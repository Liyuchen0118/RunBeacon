//go:build !windows

package runner

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func startSupervisor(executable, jobDir string, spec SupervisorSpec) (int, error) {
	command := exec.Command(executable, "supervise", "--job-dir", jobDir)
	command.Stdout = nil
	command.Stderr = nil
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdin, err := command.StdinPipe()
	if err != nil {
		return 0, err
	}
	if err := command.Start(); err != nil {
		return 0, err
	}
	if err := json.NewEncoder(stdin).Encode(spec); err != nil {
		stdin.Close()
		_ = command.Process.Kill()
		return 0, err
	}
	if err := stdin.Close(); err != nil {
		_ = command.Process.Kill()
		return 0, err
	}
	pid := command.Process.Pid
	if err := command.Process.Release(); err != nil {
		return 0, err
	}
	return pid, nil
}

func configureCommandProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func signalProcessGroup(processGroupID int, signal syscall.Signal) error {
	if processGroupID <= 0 {
		return errors.New("invalid process group")
	}
	return syscall.Kill(-processGroupID, signal)
}

func killProcessGroup(processGroupID int) error {
	err := signalProcessGroup(processGroupID, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func processGroupExists(processGroupID int) bool {
	if processGroupID <= 0 {
		return false
	}
	err := syscall.Kill(-processGroupID, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func currentUserUID() int { return os.Getuid() }
