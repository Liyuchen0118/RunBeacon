package runner

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
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
	if _, _, err := store.EventsAfter(terminal.ID, 0); err != nil {
		t.Fatal(err)
	}
	if len(store.eventCursors) == 0 {
		t.Fatal("expected an event cursor before pruning")
	}
	if err := store.Prune(defaultGlobalLimit); err != nil {
		t.Fatal(err)
	}
	if len(store.eventCursors) != 0 {
		t.Fatalf("pruned job retained event cursors: %+v", store.eventCursors)
	}
	if _, err := store.Get(terminal.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired terminal job still exists: %v", err)
	}
	if _, err := store.Get(active.ID); err != nil {
		t.Fatalf("active job was pruned: %v", err)
	}
}

func TestPruneEnforcesGlobalLimitByOldestTerminalJob(t *testing.T) {
	store, _ := newTestStore(t)
	oldJob, _, err := store.Create(submitFixture("echo old", "old-key", "job-old-terminal"))
	if err != nil {
		t.Fatal(err)
	}
	newJob, _, err := store.Create(submitFixture("echo new", "new-key", "job-new-terminal"))
	if err != nil {
		t.Fatal(err)
	}
	active, _, err := store.Create(submitFixture("sleep 30", "active-retention-key", "job-active-retention"))
	if err != nil {
		t.Fatal(err)
	}
	for index, fixture := range []struct {
		job      *Job
		finished time.Time
	}{
		{job: &oldJob, finished: time.Now().UTC().Add(-2 * time.Hour)},
		{job: &newJob, finished: time.Now().UTC().Add(-time.Hour)},
	} {
		dir, _ := store.JobDir(fixture.job.ID)
		fixture.job.State = StateSucceeded
		fixture.job.FinishedAt = &fixture.finished
		if err := writeJob(dir, *fixture.job); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "padding"), []byte(strings.Repeat(string(rune('a'+index)), 4096)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	newDir, _ := store.JobDir(newJob.ID)
	activeDir, _ := store.JobDir(active.ID)
	newSize, _ := directorySize(newDir)
	activeSize, _ := directorySize(activeDir)
	if err := store.Prune(newSize + activeSize); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(oldJob.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("oldest terminal job was not pruned: %v", err)
	}
	if _, err := store.Get(newJob.ID); err != nil {
		t.Fatalf("newer terminal job was pruned: %v", err)
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

func TestFullAndNoneOutputPolicies(t *testing.T) {
	store, _ := newTestStore(t)
	fullParams := submitFixture("echo full", "full-key", "job-full-output")
	fullParams.OutputPolicy.Mode = "full"
	full, _, err := store.Create(fullParams)
	if err != nil {
		t.Fatal(err)
	}
	fullDir, _ := store.JobDir(full.ID)
	for sequence := uint64(2); sequence <= 8; sequence++ {
		full.LastEventSequence = sequence
		if err := appendOutput(fullDir, &full, Event{
			Sequence: sequence,
			Type:     "output",
			Stream:   "stdout",
			Data:     strings.Repeat("f", 16*1024),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if !full.OutputTruncated || full.OutputBytes > full.OutputPolicy.MaxBytes {
		t.Fatalf("full policy did not stop at its cap: %+v", full)
	}
	fullEvents, _, err := store.EventsAfter(full.ID, 0)
	if err != nil || len(fullEvents) == 0 {
		t.Fatalf("full policy retained no events: events=%d err=%v", len(fullEvents), err)
	}

	noneParams := submitFixture("echo none", "none-key", "job-none-output")
	noneParams.OutputPolicy.Mode = "none"
	none, _, err := store.Create(noneParams)
	if err != nil {
		t.Fatal(err)
	}
	noneDir, _ := store.JobDir(none.ID)
	if err := appendOutput(noneDir, &none, Event{
		Sequence: 2,
		Type:     "output",
		Stream:   "stdout",
		Data:     "must-not-persist",
	}); err != nil {
		t.Fatal(err)
	}
	if none.OutputBytes != 0 || none.OutputTruncated {
		t.Fatalf("none policy recorded output metadata: %+v", none)
	}
	if _, err := os.Stat(filepath.Join(noneDir, outputFileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("none policy created an output file: %v", err)
	}
}

func TestEventContinuationAcrossTenThousandEvents(t *testing.T) {
	store, _ := newTestStore(t)
	job, _, err := store.Create(submitFixture("echo events", "events-key", "job-events-10000"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	runtime.GC()
	var baselineMemory runtime.MemStats
	runtime.ReadMemStats(&baselineMemory)
	var journal strings.Builder
	for sequence := uint64(2); sequence <= 10001; sequence++ {
		encoded, marshalErr := json.Marshal(Event{
			Sequence: sequence,
			Type:     "state",
			State:    StateRunning,
		})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		journal.Write(encoded)
		journal.WriteByte('\n')
	}
	if err := os.WriteFile(filepath.Join(jobDir, eventFileName), []byte(journal.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	journal = strings.Builder{}
	events, truncated, err := store.EventsAfter(job.ID, 9990)
	if err != nil {
		t.Fatal(err)
	}
	if truncated || len(events) != 11 || events[0].Sequence != 9991 || events[10].Sequence != 10001 {
		t.Fatalf("event continuation failed: first=%d last=%d count=%d truncated=%v", events[0].Sequence, events[len(events)-1].Sequence, len(events), truncated)
	}
	runtime.GC()
	var currentMemory runtime.MemStats
	runtime.ReadMemStats(&currentMemory)
	if growth := int64(currentMemory.Alloc) - int64(baselineMemory.Alloc); growth > 20*1024*1024 {
		t.Fatalf("10000 event continuation grew stable memory by %d bytes", growth)
	}
}

func TestEventReadsContinueFromCachedFileOffset(t *testing.T) {
	store, _ := newTestStore(t)
	job, _, err := store.Create(submitFixture("echo events", "cursor-key", "job-event-cursor"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	initial, _, err := store.EventsAfter(job.ID, 0)
	if err != nil || len(initial) != 1 {
		t.Fatalf("initial event read failed: events=%d err=%v", len(initial), err)
	}
	path := filepath.Join(jobDir, eventFileName)
	firstCursor := store.eventCursors[path]
	event := Event{Sequence: 2, Type: "state", State: StateRunning}
	if err := appendJSONLine(path, event); err != nil {
		t.Fatal(err)
	}
	continued, _, err := store.EventsAfter(job.ID, 1)
	if err != nil || len(continued) != 1 || continued[0].Sequence != 2 {
		t.Fatalf("incremental event read failed: events=%+v err=%v", continued, err)
	}
	secondCursor := store.eventCursors[path]
	if secondCursor.offset <= firstCursor.offset || firstCursor.offset == 0 {
		t.Fatalf("event cursor did not advance: first=%+v second=%+v", firstCursor, secondCursor)
	}
}

func TestEventCursorWaitsForCompleteRecord(t *testing.T) {
	store, _ := newTestStore(t)
	job, _, err := store.Create(submitFixture("echo events", "partial-key", "job-partial-event"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	if _, _, err := store.EventsAfter(job.ID, 0); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(jobDir, eventFileName)
	event := Event{Sequence: 2, Type: "state", State: StateRunning}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	partial, _, err := store.EventsAfter(job.ID, 1)
	if err != nil || len(partial) != 0 {
		t.Fatalf("partial record was consumed: events=%+v err=%v", partial, err)
	}
	file, err = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{'\n'}); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	completed, _, err := store.EventsAfter(job.ID, 1)
	if err != nil || len(completed) != 1 || completed[0].Sequence != 2 {
		t.Fatalf("completed record was not recovered: events=%+v err=%v", completed, err)
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

func TestCancellationMarkerIsIdempotent(t *testing.T) {
	store, _ := newTestStore(t)
	job, _, err := store.Create(submitFixture("sleep 1", "cancel-idempotent-key", "job-cancel-idempotent"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MarkCancellationRequested(job.ID); err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	path := filepath.Join(jobDir, cancelFileName)
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := store.MarkCancellationRequested(job.ID); err != nil {
		t.Fatal(err)
	}
	second, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !first.ModTime().Equal(second.ModTime()) {
		t.Fatalf("duplicate cancellation changed the acknowledgement boundary: %v -> %v", first.ModTime(), second.ModTime())
	}
}
