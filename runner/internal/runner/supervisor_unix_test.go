//go:build !windows

package runner

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConcurrentSupervisorsExecuteCommandAtMostOnce(t *testing.T) {
	store, paths := newTestStore(t)
	marker := filepath.Join(paths.StateDir, "executions.txt")
	command := "printf 'once\\n' >> '" + marker + "'"
	job, _, err := store.Create(submitFixture(command, "claim-key", "job-claim-123456"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	var wait sync.WaitGroup
	errorsSeen := make(chan error, 2)
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errorsSeen <- Supervise(jobDir, SupervisorSpec{Command: command, TimeoutMillis: 5_000})
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		if err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "once\n" {
		t.Fatalf("command was not executed exactly once: %q", data)
	}
}

func TestSupervisorCompletesAndPersistsOutput(t *testing.T) {
	store, _ := newTestStore(t)
	for attempt := 0; attempt < 20; attempt++ {
		expected := fmt.Sprintf("runner-success-%d", attempt)
		command := fmt.Sprintf("printf '%s\\n'", expected)
		jobID := fmt.Sprintf("job-supervise-%04d", attempt)
		idempotencyKey := fmt.Sprintf("supervise-key-%04d", attempt)
		job, _, err := store.Create(submitFixture(command, idempotencyKey, jobID))
		if err != nil {
			t.Fatal(err)
		}
		jobDir, _ := store.JobDir(job.ID)
		if err := Supervise(jobDir, SupervisorSpec{Command: command, TimeoutMillis: 5_000}); err != nil {
			t.Fatal(err)
		}
		completed, err := store.Get(job.ID)
		if err != nil {
			t.Fatal(err)
		}
		if completed.State != StateSucceeded || completed.ExitCode == nil || *completed.ExitCode != 0 {
			t.Fatalf("unexpected terminal job: %+v", completed)
		}
		events, _, err := store.EventsAfter(job.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		var output strings.Builder
		for _, event := range events {
			output.WriteString(event.Data)
		}
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("attempt %d missing supervisor output: %q", attempt, output.String())
		}
	}
}

func TestSupervisorTimeoutVerifiesProcessGroupExit(t *testing.T) {
	store, _ := newTestStore(t)
	command := "sleep 30"
	job, _, err := store.Create(submitFixture(command, "timeout-key", "job-timeout-1234"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	started := time.Now()
	if err := Supervise(jobDir, SupervisorSpec{Command: command, TimeoutMillis: 100}); err != nil {
		t.Fatal(err)
	}
	completed, err := store.Get(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != StateTimedOut || !completed.CancellationVerified {
		t.Fatalf("timeout was not verified: %+v", completed)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("timeout took too long: %v", time.Since(started))
	}
}

func TestSupervisorCancellationVerifiesProcessGroupExit(t *testing.T) {
	store, _ := newTestStore(t)
	command := "sleep 30"
	job, _, err := store.Create(submitFixture(command, "cancel-supervisor-key", "job-cancel-supervisor"))
	if err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	finished := make(chan error, 1)
	go func() {
		finished <- Supervise(jobDir, SupervisorSpec{Command: command, TimeoutMillis: 30_000})
	}()
	deadline := time.Now().Add(3 * time.Second)
	var running Job
	for {
		running, err = store.Get(job.ID)
		if err == nil && running.ProcessGroupID > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supervisor did not record its process group")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := store.MarkCancellationRequested(job.ID); err != nil {
		t.Fatal(err)
	}
	if err := signalProcessGroup(running.ProcessGroupID, 15); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	completed, err := store.Get(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != StateCancelled || !completed.CancellationVerified {
		t.Fatalf("cancellation was not verified: %+v", completed)
	}
}

func TestSupervisorCancellationBeforeProcessStartExecutesNothing(t *testing.T) {
	store, paths := newTestStore(t)
	marker := filepath.Join(paths.StateDir, "must-not-exist")
	command := "printf unexpected > '" + marker + "'"
	job, _, err := store.Create(submitFixture(command, "cancel-before-start-key", "job-cancel-before-start"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.MarkCancellationRequested(job.ID); err != nil {
		t.Fatal(err)
	}
	jobDir, _ := store.JobDir(job.ID)
	if err := Supervise(jobDir, SupervisorSpec{Command: command, TimeoutMillis: 5_000}); err != nil {
		t.Fatal(err)
	}
	completed, err := store.Get(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != StateCancelled || !completed.CancellationVerified || completed.ProcessGroupID != 0 {
		t.Fatalf("pre-start cancellation was not verified: %+v", completed)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled command executed: %v", err)
	}
}

func TestExternalCancellationRequiresAdapterAcknowledgement(t *testing.T) {
	for _, fixture := range []struct {
		name          string
		command       string
		expectedState JobState
		verified      bool
	}{
		{
			name:          "acknowledged",
			command:       "trap 'printf verified > \"$RUNBEACON_CANCELLATION_ACK_FILE\"; exit 130' TERM; while :; do sleep 1; done",
			expectedState: StateCancelled,
			verified:      true,
		},
		{
			name:          "unacknowledged",
			command:       "trap 'exit 70' TERM; while :; do sleep 1; done",
			expectedState: StateFailed,
			verified:      false,
		},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			store, _ := newTestStore(t)
			params := submitFixture(fixture.command, "external-"+fixture.name, "job-external-"+fixture.name)
			params.CancellationMode = "external"
			job, _, err := store.Create(params)
			if err != nil {
				t.Fatal(err)
			}
			jobDir, _ := store.JobDir(job.ID)
			finished := make(chan error, 1)
			go func() {
				finished <- Supervise(jobDir, SupervisorSpec{
					Command:          fixture.command,
					TimeoutMillis:    30_000,
					CancellationMode: "external",
				})
			}()
			deadline := time.Now().Add(3 * time.Second)
			var running Job
			for {
				running, err = store.Get(job.ID)
				if err == nil && running.ProcessGroupID > 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("supervisor did not record its process group")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := store.MarkCancellationRequested(job.ID); err != nil {
				t.Fatal(err)
			}
			if err := signalProcessGroup(running.ProcessGroupID, 15); err != nil {
				t.Fatal(err)
			}
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
			completed, err := store.Get(job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if completed.State != fixture.expectedState || completed.CancellationVerified != fixture.verified {
				t.Fatalf("unexpected external cancellation result: %+v", completed)
			}
		})
	}
}

func TestExternalTerminalStateMapsVerifiedSchedulerOutcome(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		declared string
		exitCode int
		expected JobState
	}{
		{name: "cancelled", declared: "cancelled", exitCode: 130, expected: StateCancelled},
		{name: "timed-out", declared: "timed_out", exitCode: 124, expected: StateTimedOut},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			store, _ := newTestStore(t)
			command := fmt.Sprintf("printf '%s\\n' >\"$RUNBEACON_TERMINAL_STATE_FILE\"; exit %d", fixture.declared, fixture.exitCode)
			params := submitFixture(command, "external-state-"+fixture.name, "job-external-state-"+fixture.name)
			params.CancellationMode = "external"
			job, _, err := store.Create(params)
			if err != nil {
				t.Fatal(err)
			}
			jobDir, _ := store.JobDir(job.ID)
			if err := Supervise(jobDir, SupervisorSpec{Command: command, CancellationMode: "external"}); err != nil {
				t.Fatal(err)
			}
			completed, err := store.Get(job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if completed.State != fixture.expected || !completed.CancellationVerified {
				t.Fatalf("scheduler state was not verified: %+v", completed)
			}
		})
	}
}
