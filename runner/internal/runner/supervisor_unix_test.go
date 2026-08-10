//go:build !windows

package runner

import (
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
