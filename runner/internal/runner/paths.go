package runner

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

type Paths struct {
	StateDir   string
	JobsDir    string
	SocketPath string
}

func ResolvePaths(stateDir, socketPath string) (Paths, error) {
	if stateDir == "" {
		stateDir = os.Getenv("RUNBEACON_RUNNER_STATE_DIR")
	}
	if stateDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Paths{}, err
		}
		if runtime.GOOS == "darwin" {
			stateDir = filepath.Join(home, "Library", "Application Support", "RunBeacon", "Runner")
		} else if xdg := os.Getenv("XDG_STATE_HOME"); xdg != "" {
			stateDir = filepath.Join(xdg, "runbeacon-runner")
		} else {
			stateDir = filepath.Join(home, ".local", "state", "runbeacon-runner")
		}
	}
	absState, err := filepath.Abs(stateDir)
	if err != nil {
		return Paths{}, err
	}
	if absState == string(filepath.Separator) {
		return Paths{}, errors.New("runner state directory cannot be the filesystem root")
	}
	if socketPath == "" {
		socketPath = os.Getenv("RUNBEACON_RUNNER_SOCKET")
	}
	if socketPath == "" {
		if runtimeDir := os.Getenv("XDG_RUNTIME_DIR"); runtimeDir != "" {
			socketPath = filepath.Join(runtimeDir, "runbeacon", "runner.sock")
		} else {
			socketPath = filepath.Join(absState, "run", "runner.sock")
		}
	}
	absSocket, err := filepath.Abs(socketPath)
	if err != nil {
		return Paths{}, err
	}
	return Paths{
		StateDir:   absState,
		JobsDir:    filepath.Join(absState, "jobs"),
		SocketPath: absSocket,
	}, nil
}

func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}
