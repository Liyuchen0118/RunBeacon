package runner

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

func Supervise(jobDir string, spec SupervisorSpec) error {
	job, err := readJob(jobDir)
	if err != nil {
		return err
	}
	if job.State.Terminal() {
		return nil
	}
	claimed, err := claimSupervisor(jobDir)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	job.SupervisorPID = os.Getpid()
	if err := writeJob(jobDir, job); err != nil {
		return err
	}
	if spec.Command == "" || DigestCommand(spec.Command) != job.CommandDigest {
		return finishSupervisor(jobDir, &job, StateLost, nil, "supervisor command digest mismatch", false)
	}

	shell := "/bin/sh"
	if runtime.GOOS == "darwin" {
		shell = "/bin/zsh"
	}
	command := exec.Command(shell, "-s")
	command.Dir = spec.CWD
	command.Env = os.Environ()
	for key, value := range spec.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		return finishSupervisor(jobDir, &job, StateFailed, nil, err.Error(), false)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return finishSupervisor(jobDir, &job, StateFailed, nil, err.Error(), false)
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return finishSupervisor(jobDir, &job, StateFailed, nil, err.Error(), false)
	}
	configureCommandProcessGroup(command)
	if err := command.Start(); err != nil {
		return finishSupervisor(jobDir, &job, StateFailed, nil, err.Error(), false)
	}
	if _, err := io.WriteString(stdin, spec.Command+"\n"); err != nil {
		stdin.Close()
		_ = killProcessGroup(command.Process.Pid)
		return finishSupervisor(jobDir, &job, StateFailed, nil, err.Error(), false)
	}
	if err := stdin.Close(); err != nil {
		_ = killProcessGroup(command.Process.Pid)
		return finishSupervisor(jobDir, &job, StateFailed, nil, err.Error(), false)
	}

	now := time.Now().UTC()
	job.State = StateRunning
	job.StartedAt = &now
	job.ProcessGroupID = command.Process.Pid
	job.LastEventSequence++
	if err := appendJSONLine(eventPath(jobDir), Event{
		Sequence:  job.LastEventSequence,
		Timestamp: now,
		Type:      "state",
		State:     StateRunning,
	}); err != nil {
		_ = killProcessGroup(command.Process.Pid)
		return err
	}
	if err := writeJob(jobDir, job); err != nil {
		_ = killProcessGroup(command.Process.Pid)
		return err
	}

	var outputMu sync.Mutex
	var outputErr error
	var outputWG sync.WaitGroup
	copyOutput := func(stream string, reader io.Reader) {
		defer outputWG.Done()
		buffer := make([]byte, 32*1024)
		for {
			count, readErr := reader.Read(buffer)
			if count > 0 {
				outputMu.Lock()
				if job.OutputPolicy.Mode != "none" {
					job.LastEventSequence++
					event := Event{
						Sequence:  job.LastEventSequence,
						Timestamp: time.Now().UTC(),
						Type:      "output",
						Stream:    stream,
						Data:      string(buffer[:count]),
					}
					if err := appendOutput(jobDir, &job, event); err != nil && outputErr == nil {
						outputErr = err
					}
				}
				_ = writeJob(jobDir, job)
				outputMu.Unlock()
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) && outputErr == nil {
					outputErr = readErr
				}
				return
			}
		}
	}
	outputWG.Add(2)
	go copyOutput("stdout", bufio.NewReader(stdout))
	go copyOutput("stderr", bufio.NewReader(stderr))

	timedOut := make(chan struct{}, 1)
	if spec.TimeoutMillis > 0 {
		timer := time.AfterFunc(time.Duration(spec.TimeoutMillis)*time.Millisecond, func() {
			if setTimeoutRequested(jobDir) == nil {
				_ = killProcessGroup(command.Process.Pid)
				timedOut <- struct{}{}
			}
		})
		defer timer.Stop()
	}

	outputWG.Wait()
	waitErr := command.Wait()
	exitCode := command.ProcessState.ExitCode()
	state := StateFailed
	verified := false
	message := ""
	if timeoutRequested(jobDir) {
		state = StateTimedOut
		verified = processGroupTerminationVerified(command.Process.Pid, 2*time.Second)
	} else if cancellationRequested(jobDir) {
		state = StateCancelled
		verified = processGroupTerminationVerified(command.Process.Pid, 2*time.Second)
	} else if waitErr == nil && exitCode == 0 {
		state = StateSucceeded
	} else if waitErr != nil {
		message = waitErr.Error()
	}
	if outputErr != nil && message == "" {
		message = fmt.Sprintf("capture output: %v", outputErr)
	}
	return finishSupervisor(jobDir, &job, state, &exitCode, message, verified)
}

func finishSupervisor(jobDir string, job *Job, state JobState, exitCode *int, message string, cancellationVerified bool) error {
	now := time.Now().UTC()
	job.State = state
	job.ExitCode = exitCode
	job.Error = message
	job.CancellationVerified = cancellationVerified
	job.FinishedAt = &now
	job.LastEventSequence++
	if err := appendJSONLine(eventPath(jobDir), Event{
		Sequence:  job.LastEventSequence,
		Timestamp: now,
		Type:      "state",
		State:     state,
		Details: map[string]any{
			"exitCode":             exitCode,
			"cancellationVerified": cancellationVerified,
		},
	}); err != nil {
		return err
	}
	return writeJob(jobDir, *job)
}

func eventPath(jobDir string) string {
	return jobDir + string(os.PathSeparator) + eventFileName
}
