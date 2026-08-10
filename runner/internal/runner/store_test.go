package runner

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestStore(t *testing.T) (*Store, Paths) {
	t.Helper()
	root := t.TempDir()
	paths := Paths{
		StateDir:   root,
		JobsDir:    filepath.Join(root, "jobs"),
		SocketPath: filepath.Join(root, "runner.sock"),
	}
	store := NewStore(paths)
	if err := store.Prepare(); err != nil {
		t.Fatal(err)
	}
	return store, paths
}

func submitFixture(command, key, jobID string) SubmitParams {
	return SubmitParams{
		JobID:          jobID,
		IdempotencyKey: key,
		CommandDigest:  DigestCommand(command),
		Command:        command,
		OutputPolicy: OutputPolicy{
			Mode:           "tail",
			MaxBytes:       64 * 1024,
			RetentionHours: 24,
		},
	}
}

func TestCreateIsIdempotentAndRejectsDigestConflicts(t *testing.T) {
	store, _ := newTestStore(t)
	params := submitFixture("echo once", "stable-key", "job-12345678")
	first, created, err := store.Create(params)
	if err != nil || !created {
		t.Fatalf("first create: created=%v err=%v", created, err)
	}
	second, created, err := store.Create(params)
	if err != nil || created || second.ID != first.ID {
		t.Fatalf("idempotent create: created=%v err=%v second=%+v", created, err, second)
	}

	conflict := submitFixture("echo different", "stable-key", "job-87654321")
	_, _, err = store.Create(conflict)
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected idempotency conflict, got %v", err)
	}
}

func TestCreateRejectsOversizedCommandAndEnvironment(t *testing.T) {
	store, _ := newTestStore(t)
	command := strings.Repeat("x", maximumCommandSize+1)
	_, _, err := store.Create(submitFixture(command, "large-command", "job-large-command"))
	if err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("expected command size rejection, got %v", err)
	}
	params := submitFixture("echo ok", "large-env", "job-large-env-123")
	params.Env = map[string]string{"VALUE": strings.Repeat("x", maximumEnvSize+1)}
	_, _, err = store.Create(params)
	if err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("expected environment size rejection, got %v", err)
	}
}

func TestPruneRemovesOnlyExpiredTerminalJobs(t *testing.T) {
	store, _ := newTestStore(t)
	terminal, _, err := store.Create(submitFixture("echo done", "expired-key", "job-expired-1234"))
	if err != nil {
		t.Fatal(err)
	}
	active, _, err := store.Create(submitFixture("sleep 10", "active-key", "job-active-12345"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(terminal.ID)
	finished := time.Now().UTC().Add(-48 * time.Hour)
	terminal.State = StateSucceeded
	terminal.FinishedAt = &finished
	terminal.OutputPolicy.RetentionHours = 1
	if err := writeJob(jobDir, terminal); err != nil {
		t.Fatal(err)
	}
	if err := store.Prune(defaultGlobalLimit); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(terminal.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired terminal job still exists: %v", err)
	}
	if _, err := store.Get(active.ID); err != nil {
		t.Fatalf("active job was pruned: %v", err)
	}
}

func TestCommandBodyIsNeverPersisted(t *testing.T) {
	store, paths := newTestStore(t)
	secretCommand := "printf RUNBEACON_COMMAND_CANARY_8492"
	_, _, err := store.Create(submitFixture(secretCommand, "secret-key", "job-secret-1234"))
	if err != nil {
		t.Fatal(err)
	}

	err = filepath.Walk(paths.StateDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(data), secretCommand) || strings.Contains(string(data), "RUNBEACON_COMMAND_CANARY_8492") {
			t.Fatalf("command body persisted in %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTailOutputIsBoundedAndSignalsRetentionGap(t *testing.T) {
	store, _ := newTestStore(t)
	job, _, err := store.Create(submitFixture("echo output", "output-key", "job-output-1234"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	for sequence := uint64(2); sequence <= 5; sequence++ {
		job.LastEventSequence = sequence
		err = appendOutput(jobDir, &job, Event{
			Sequence: sequence,
			Type:     "output",
			Stream:   "stdout",
			Data:     strings.Repeat("x", 24*1024),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if job.OutputBytes > job.OutputPolicy.MaxBytes {
		t.Fatalf("output grew to %d bytes, limit is %d", job.OutputBytes, job.OutputPolicy.MaxBytes)
	}
	if !job.OutputTruncated {
		t.Fatal("expected output truncation")
	}
	events, truncated, err := store.EventsAfter(job.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || !truncated {
		t.Fatalf("expected retained events and a sequence gap, events=%d truncated=%v", len(events), truncated)
	}
}

func TestCancellationMarkerDoesNotChangeTerminalState(t *testing.T) {
	store, _ := newTestStore(t)
	job, _, err := store.Create(submitFixture("sleep 1", "cancel-key", "job-cancel-1234"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MarkCancellationRequested(job.ID); err != nil {
		t.Fatal(err)
	}
	current, err := store.Get(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State != StateQueued || current.CancellationVerified {
		t.Fatalf("request marker reported cancellation prematurely: %+v", current)
	}
}
