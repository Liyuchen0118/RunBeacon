package runner

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	jobFileName         = "job.json"
	eventFileName       = "events.jsonl"
	outputFileName      = "output.jsonl"
	cancelFileName      = "cancel.requested"
	timeoutFileName     = "timeout.requested"
	supervisorClaimName = "supervisor.claim"
	defaultMaxOutput    = int64(64 * 1024 * 1024)
	defaultRetention    = 7 * 24
	maximumOutputSize   = int64(1024 * 1024 * 1024)
	maximumCommandSize  = 1024 * 1024
	maximumEnvSize      = 1024 * 1024
	defaultGlobalLimit  = int64(10 * 1024 * 1024 * 1024)
)

type Store struct {
	paths Paths
	mu    sync.Mutex
}

func NewStore(paths Paths) *Store {
	return &Store{paths: paths}
}

func (store *Store) Prepare() error {
	if err := ensurePrivateDir(store.paths.StateDir); err != nil {
		return err
	}
	return ensurePrivateDir(store.paths.JobsDir)
}

func (store *Store) ReconcileAll() error {
	entries, err := os.ReadDir(store.paths.JobsDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !validJobID(entry.Name()) {
			continue
		}
		if _, err := store.Reconcile(entry.Name()); err != nil {
			return err
		}
	}
	return nil
}

type retainedJob struct {
	id         string
	finishedAt time.Time
	size       int64
}

func (store *Store) Prune(maxBytes int64) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if maxBytes <= 0 {
		maxBytes = defaultGlobalLimit
	}
	entries, err := os.ReadDir(store.paths.JobsDir)
	if err != nil {
		return err
	}
	var total int64
	var terminal []retainedJob
	now := time.Now().UTC()
	for _, entry := range entries {
		if !entry.IsDir() || !validJobID(entry.Name()) {
			continue
		}
		jobDir := filepath.Join(store.paths.JobsDir, entry.Name())
		job, readErr := readJob(jobDir)
		if readErr != nil {
			continue
		}
		size, sizeErr := directorySize(jobDir)
		if sizeErr != nil {
			return sizeErr
		}
		total += size
		if !job.State.Terminal() {
			continue
		}
		finished := job.UpdatedAt
		if job.FinishedAt != nil {
			finished = *job.FinishedAt
		}
		expires := finished.Add(time.Duration(job.OutputPolicy.RetentionHours) * time.Hour)
		if !now.Before(expires) {
			if err := os.RemoveAll(jobDir); err != nil {
				return err
			}
			total -= size
			continue
		}
		terminal = append(terminal, retainedJob{id: entry.Name(), finishedAt: finished, size: size})
	}
	sort.Slice(terminal, func(i, j int) bool {
		return terminal[i].finishedAt.Before(terminal[j].finishedAt)
	})
	for _, candidate := range terminal {
		if total <= maxBytes {
			break
		}
		if err := os.RemoveAll(filepath.Join(store.paths.JobsDir, candidate.id)); err != nil {
			return err
		}
		total -= candidate.size
	}
	if total > maxBytes {
		return ErrGlobalRetentionLimit
	}
	return nil
}

func directorySize(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

func (store *Store) Reconcile(jobID string) (Job, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	jobDir, err := store.JobDir(jobID)
	if err != nil {
		return Job{}, err
	}
	job, err := readJob(jobDir)
	if err != nil || job.State.Terminal() {
		return job, err
	}
	claimPID, claimed := readSupervisorClaim(jobDir)
	if claimed && processExists(claimPID) {
		if job.SupervisorPID != claimPID {
			job.SupervisorPID = claimPID
			if err := writeJob(jobDir, job); err != nil {
				return Job{}, err
			}
		}
		return job, nil
	}
	if !claimed && job.State == StateQueued && time.Since(job.CreatedAt) < 5*time.Second {
		return job, nil
	}
	// An active record without a live claimed supervisor is ambiguous. Never
	// replay it automatically because the command may already have started.
	return job, finishSupervisor(jobDir, &job, StateLost, nil, "runner supervisor is unavailable", false)
}

func supervisorClaimed(jobDir string) bool {
	_, err := os.Stat(filepath.Join(jobDir, supervisorClaimName))
	return err == nil
}

func claimSupervisor(jobDir string) (bool, error) {
	path := filepath.Join(jobDir, supervisorClaimName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, writeErr := fmt.Fprintf(file, "%d\n", os.Getpid())
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil {
		return false, writeErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	return true, nil
}

func readSupervisorClaim(jobDir string) (int, bool) {
	data, err := os.ReadFile(filepath.Join(jobDir, supervisorClaimName))
	if err != nil {
		return 0, false
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &pid); err != nil || pid <= 0 {
		return 0, true
	}
	return pid, true
}

func DigestCommand(command string) string {
	sum := sha256.Sum256([]byte(command))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func normalizeOutputPolicy(policy OutputPolicy) OutputPolicy {
	switch policy.Mode {
	case "full", "none", "tail":
	default:
		policy.Mode = "tail"
	}
	if policy.MaxBytes < 64*1024 {
		policy.MaxBytes = defaultMaxOutput
	}
	if policy.MaxBytes > maximumOutputSize {
		policy.MaxBytes = maximumOutputSize
	}
	if policy.RetentionHours < 1 {
		policy.RetentionHours = defaultRetention
	}
	if policy.RetentionHours > 90*24 {
		policy.RetentionHours = 90 * 24
	}
	return policy
}

func (store *Store) JobDir(jobID string) (string, error) {
	if !validJobID(jobID) {
		return "", errors.New("invalid jobId")
	}
	return filepath.Join(store.paths.JobsDir, jobID), nil
}

func validJobID(value string) bool {
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}

func (store *Store) FindByIdempotency(key string) (*Job, error) {
	if key == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(store.paths.JobsDir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		job, err := readJob(filepath.Join(store.paths.JobsDir, entry.Name()))
		if err == nil && job.IdempotencyKey == key {
			return &job, nil
		}
	}
	return nil, nil
}

func (store *Store) Create(params SubmitParams) (Job, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	if params.Command == "" || params.IdempotencyKey == "" {
		return Job{}, false, errors.New("command and idempotencyKey are required")
	}
	if len(params.IdempotencyKey) > 200 {
		return Job{}, false, errors.New("idempotencyKey exceeds 200 characters")
	}
	if len(params.Command) > maximumCommandSize {
		return Job{}, false, errors.New("command exceeds 1 MiB")
	}
	if envSize(params.Env) > maximumEnvSize {
		return Job{}, false, errors.New("environment exceeds 1 MiB")
	}
	actualDigest := DigestCommand(params.Command)
	if params.CommandDigest == "" {
		params.CommandDigest = actualDigest
	}
	if params.CommandDigest != actualDigest {
		return Job{}, false, errors.New("commandDigest does not match command")
	}
	if existing, err := store.FindByIdempotency(params.IdempotencyKey); err != nil {
		return Job{}, false, err
	} else if existing != nil {
		if existing.CommandDigest != params.CommandDigest {
			return Job{}, false, ErrIdempotencyConflict
		}
		return *existing, false, nil
	}
	jobDir, err := store.JobDir(params.JobID)
	if err != nil {
		return Job{}, false, err
	}
	if _, err := os.Stat(jobDir); err == nil {
		existing, readErr := readJob(jobDir)
		if readErr != nil || existing.CommandDigest != params.CommandDigest {
			return Job{}, false, ErrIdempotencyConflict
		}
		return existing, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return Job{}, false, err
	}
	if err := ensurePrivateDir(jobDir); err != nil {
		return Job{}, false, err
	}
	now := time.Now().UTC()
	job := Job{
		ProtocolVersion:   ProtocolVersion,
		ID:                params.JobID,
		IdempotencyKey:    params.IdempotencyKey,
		CommandDigest:     params.CommandDigest,
		State:             StateQueued,
		CreatedAt:         now,
		UpdatedAt:         now,
		OutputPolicy:      normalizeOutputPolicy(params.OutputPolicy),
		LastEventSequence: 1,
	}
	if err := writeJob(jobDir, job); err != nil {
		return Job{}, false, err
	}
	if err := appendJSONLine(filepath.Join(jobDir, eventFileName), Event{
		Sequence:  1,
		Timestamp: now,
		Type:      "state",
		State:     StateQueued,
	}); err != nil {
		return Job{}, false, err
	}
	return job, true, nil
}

func envSize(env map[string]string) int {
	total := 0
	for key, value := range env {
		total += len(key) + len(value) + 1
	}
	return total
}

func (store *Store) Get(jobID string) (Job, error) {
	jobDir, err := store.JobDir(jobID)
	if err != nil {
		return Job{}, err
	}
	return readJob(jobDir)
}

func readJob(jobDir string) (Job, error) {
	data, err := os.ReadFile(filepath.Join(jobDir, jobFileName))
	if err != nil {
		return Job{}, err
	}
	var job Job
	if err := json.Unmarshal(data, &job); err != nil {
		return Job{}, err
	}
	if job.ProtocolVersion != ProtocolVersion || !validJobID(job.ID) {
		return Job{}, errors.New("invalid runner job record")
	}
	return job, nil
}

func writeJob(jobDir string, job Job) error {
	job.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(jobDir, jobFileName+".tmp")
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(jobDir, jobFileName))
}

func appendJSONLine(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return err
	}
	return file.Sync()
}

func appendOutput(jobDir string, job *Job, event Event) error {
	if job.OutputPolicy.Mode == "none" || event.Data == "" {
		return nil
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	path := filepath.Join(jobDir, outputFileName)
	if job.OutputPolicy.Mode == "full" && job.OutputBytes+int64(len(encoded)) > job.OutputPolicy.MaxBytes {
		job.OutputTruncated = true
		return nil
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	job.OutputBytes += int64(len(encoded))
	if job.OutputPolicy.Mode == "tail" && job.OutputBytes > job.OutputPolicy.MaxBytes {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		start := len(data) - int(job.OutputPolicy.MaxBytes)
		if start < 0 {
			start = 0
		}
		if newline := bytes.IndexByte(data[start:], '\n'); newline >= 0 {
			start += newline + 1
		}
		data = data[start:]
		if err := atomicWrite(path, data); err != nil {
			return err
		}
		job.OutputBytes = int64(len(data))
		job.OutputTruncated = true
	}
	return nil
}

func atomicWrite(path string, data []byte) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func readEvents(path string, after uint64) ([]Event, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	var events []Event
	for scanner.Scan() {
		var event Event
		if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Sequence > after {
			events = append(events, event)
		}
	}
	return events, scanner.Err()
}

func (store *Store) EventsAfter(jobID string, after uint64) ([]Event, bool, error) {
	jobDir, err := store.JobDir(jobID)
	if err != nil {
		return nil, false, err
	}
	stateEvents, err := readEvents(filepath.Join(jobDir, eventFileName), after)
	if err != nil {
		return nil, false, err
	}
	outputEvents, err := readEvents(filepath.Join(jobDir, outputFileName), after)
	if err != nil {
		return nil, false, err
	}
	events := append(stateEvents, outputEvents...)
	sort.Slice(events, func(i, j int) bool { return events[i].Sequence < events[j].Sequence })
	truncated := len(events) > 0 && events[0].Sequence > after+1
	for index := 1; index < len(events) && !truncated; index++ {
		truncated = events[index].Sequence > events[index-1].Sequence+1
	}
	// Bound one blocking watch response so the coordinator can consume a long
	// backlog over multiple sequence-continuation requests.
	if len(events) > 128 {
		events = events[:128]
	}
	return events, truncated, nil
}

func (store *Store) MarkCancellationRequested(jobID string) error {
	jobDir, err := store.JobDir(jobID)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(jobDir, cancelFileName), []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0o600)
}

func cancellationRequested(jobDir string) bool {
	_, err := os.Stat(filepath.Join(jobDir, cancelFileName))
	return err == nil
}

func timeoutRequested(jobDir string) bool {
	_, err := os.Stat(filepath.Join(jobDir, timeoutFileName))
	return err == nil
}

func setTimeoutRequested(jobDir string) error {
	return os.WriteFile(filepath.Join(jobDir, timeoutFileName), []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0o600)
}

func decodeParams(params map[string]any, target any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func readAllLimited(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxRPCBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxRPCBytes {
		return nil, fmt.Errorf("request exceeds %d bytes", MaxRPCBytes)
	}
	return data, nil
}

var ErrIdempotencyConflict = errors.New("IDEMPOTENCY_CONFLICT")
var ErrGlobalRetentionLimit = errors.New("global runner retention limit reached")
