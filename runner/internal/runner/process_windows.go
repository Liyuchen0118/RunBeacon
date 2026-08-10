//go:build windows

package runner

import (
	"errors"
	"os/exec"
	"syscall"
)

var errUnsupported = errors.New("runbeacon-runner remote execution is supported only on Linux and macOS")

func startSupervisor(string, string, SupervisorSpec) (int, error) {
	return 0, errUnsupported
}

func configureCommandProcessGroup(*exec.Cmd) {}

func signalProcessGroup(int, syscall.Signal) error { return errUnsupported }

func killProcessGroup(int) error { return errUnsupported }

func processGroupExists(int) bool { return false }

func processExists(int) bool { return false }

func currentUserUID() int { return -1 }
