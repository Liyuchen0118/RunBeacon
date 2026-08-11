package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type Server struct {
	paths      Paths
	version    string
	executable string
	store      *Store
	listener   net.Listener
	wg         sync.WaitGroup
}

func NewServer(paths Paths, version, executable string) *Server {
	return &Server{
		paths:      paths,
		version:    version,
		executable: executable,
		store:      NewStore(paths),
	}
}

func (server *Server) Serve(ctx context.Context) error {
	if err := server.store.Prepare(); err != nil {
		return err
	}
	if err := server.store.ReconcileAll(); err != nil {
		return err
	}
	if err := server.store.Prune(defaultGlobalLimit); err != nil && !errors.Is(err, ErrGlobalRetentionLimit) {
		return err
	}
	pruneTicker := time.NewTicker(time.Hour)
	defer pruneTicker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-pruneTicker.C:
				_ = server.store.Prune(defaultGlobalLimit)
			}
		}
	}()
	if err := ensurePrivateDir(filepath.Dir(server.paths.SocketPath)); err != nil {
		return err
	}
	if err := removeStaleSocket(server.paths.SocketPath); err != nil {
		return err
	}
	listener, err := net.Listen("unix", server.paths.SocketPath)
	if err != nil {
		return err
	}
	server.listener = listener
	if err := os.Chmod(server.paths.SocketPath, 0o600); err != nil {
		listener.Close()
		return err
	}
	defer os.Remove(server.paths.SocketPath)
	defer listener.Close()

	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				server.wg.Wait()
				return nil
			}
			return err
		}
		server.wg.Add(1)
		go func() {
			defer server.wg.Done()
			defer connection.Close()
			server.handle(connection)
		}()
	}
}

func removeStaleSocket(path string) error {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	connection, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err == nil {
		connection.Close()
		return errors.New("runner socket is already active")
	}
	return os.Remove(path)
}

func (server *Server) handle(connection net.Conn) {
	decoder := json.NewDecoder(bufio.NewReaderSize(connection, 64*1024))
	var request Request
	if err := decoder.Decode(&request); err != nil {
		server.writeResponse(connection, failure("INVALID_REQUEST", err.Error()))
		return
	}
	if request.ProtocolVersion != ProtocolVersion {
		server.writeResponse(connection, failure("PROTOCOL_MISMATCH", "runner protocol v1 is required"))
		return
	}
	response := server.dispatch(request)
	server.writeResponse(connection, response)
}

func (server *Server) dispatch(request Request) Response {
	switch request.Method {
	case "ping":
		return success(map[string]any{
			"ready":           true,
			"version":         server.version,
			"protocolVersion": ProtocolVersion,
			"pid":             os.Getpid(),
		})
	case "submit":
		if err := server.store.Prune(defaultGlobalLimit); err != nil {
			return failure("LIMIT_REACHED", err.Error())
		}
		var params SubmitParams
		if err := decodeParams(request.Params, &params); err != nil {
			return failure("INVALID_REQUEST", err.Error())
		}
		job, created, err := server.store.Create(params)
		if errors.Is(err, ErrIdempotencyConflict) {
			return failure("IDEMPOTENCY_CONFLICT", "idempotency key is already bound to a different command digest")
		}
		if err != nil {
			return failure("SUBMIT_FAILED", err.Error())
		}
		jobDir, _ := server.store.JobDir(job.ID)
		if job.State == StateQueued && !supervisorClaimed(jobDir) {
			spec := SupervisorSpec{
				Command:          params.Command,
				CWD:              params.CWD,
				Env:              params.Env,
				TimeoutMillis:    params.TimeoutMillis,
				CancellationMode: job.CancellationMode,
			}
			_, startErr := startSupervisor(server.executable, jobDir, spec)
			if startErr != nil {
				return failure("SUBMIT_FAILED", startErr.Error())
			}
		}
		return success(map[string]any{"job": job, "created": created})
	case "get":
		jobID, _ := request.Params["jobId"].(string)
		job, err := server.store.Reconcile(jobID)
		if err != nil {
			return failure("JOB_NOT_FOUND", "runner job was not found")
		}
		return success(map[string]any{"job": job})
	case "watch":
		var params WatchParams
		if err := decodeParams(request.Params, &params); err != nil {
			return failure("INVALID_REQUEST", err.Error())
		}
		return server.watch(params)
	case "cancel":
		jobID, _ := request.Params["jobId"].(string)
		return server.cancel(jobID)
	default:
		return failure("METHOD_NOT_FOUND", fmt.Sprintf("unknown method %q", request.Method))
	}
}

func (server *Server) watch(params WatchParams) Response {
	timeout := time.Duration(params.TimeoutMillis) * time.Millisecond
	if timeout <= 0 || timeout > 24*time.Hour {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for {
		job, err := server.store.Reconcile(params.JobID)
		if err != nil {
			return failure("JOB_NOT_FOUND", "runner job was not found")
		}
		if job.LastEventSequence > params.AfterSequence || job.State.Terminal() {
			events, truncated, err := server.store.EventsAfter(params.JobID, params.AfterSequence)
			if err != nil {
				return failure("REMOTE_STATE_LOST", err.Error())
			}
			truncated = truncated ||
				(len(events) == 0 && job.OutputTruncated && job.LastEventSequence > params.AfterSequence)
			nextSequence := params.AfterSequence
			for _, event := range events {
				if event.Sequence > nextSequence {
					nextSequence = event.Sequence
				}
			}
			if len(events) == 0 && truncated {
				nextSequence = job.LastEventSequence
			}
			return success(map[string]any{
				"job":          job,
				"events":       events,
				"truncated":    truncated,
				"nextSequence": nextSequence,
				"timedOut":     false,
			})
		}
		if time.Now().After(deadline) {
			return success(map[string]any{
				"job":          job,
				"events":       []Event{},
				"truncated":    false,
				"nextSequence": params.AfterSequence,
				"timedOut":     true,
			})
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (server *Server) cancel(jobID string) Response {
	job, err := server.store.Get(jobID)
	if err != nil {
		return failure("JOB_NOT_FOUND", "runner job was not found")
	}
	if job.State.Terminal() {
		if job.State == StateCancelled && !job.CancellationVerified {
			return failure("CANCEL_UNVERIFIED", "process-group cancellation was not verified")
		}
		return success(map[string]any{"job": job})
	}
	if err := server.store.MarkCancellationRequested(jobID); err != nil {
		return failure("CANCEL_FAILED", err.Error())
	}
	// Submission and cancellation can race before the supervisor records its
	// process group. Wait for either a verified terminal state or the group ID.
	startDeadline := time.Now().Add(3 * time.Second)
	for job.ProcessGroupID <= 0 && !job.State.Terminal() && time.Now().Before(startDeadline) {
		time.Sleep(25 * time.Millisecond)
		job, err = server.store.Get(jobID)
		if err != nil {
			return failure("CANCEL_FAILED", err.Error())
		}
	}
	if job.State.Terminal() {
		if job.State != StateCancelled || !job.CancellationVerified {
			return failure("CANCEL_UNVERIFIED", "cancellation before process start was not verified")
		}
		return success(map[string]any{"job": job})
	}
	if job.ProcessGroupID <= 0 {
		return failure("CANCEL_UNVERIFIED", "runner did not record a process group before the cancellation deadline")
	}
	if err := signalProcessGroup(job.ProcessGroupID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return failure("CANCEL_FAILED", err.Error())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, readErr := server.store.Get(jobID)
		if readErr == nil && current.State.Terminal() {
			if current.State != StateCancelled || !current.CancellationVerified {
				return failure("CANCEL_UNVERIFIED", "process-group or adapter cancellation was not verified")
			}
			return success(map[string]any{"job": current})
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = signalProcessGroup(job.ProcessGroupID, syscall.SIGKILL)
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		current, readErr := server.store.Get(jobID)
		if readErr == nil && current.State.Terminal() {
			if current.State != StateCancelled || !current.CancellationVerified {
				return failure("CANCEL_UNVERIFIED", "process-group or adapter cancellation was not verified")
			}
			return success(map[string]any{"job": current})
		}
		time.Sleep(100 * time.Millisecond)
	}
	return failure("CANCEL_UNVERIFIED", "process group termination could not be verified")
}

func (server *Server) writeResponse(connection net.Conn, response Response) {
	_ = json.NewEncoder(connection).Encode(response)
}

func success(result any) Response {
	return Response{ProtocolVersion: ProtocolVersion, OK: true, Result: result}
}

func failure(code, message string) Response {
	return Response{
		ProtocolVersion: ProtocolVersion,
		OK:              false,
		Error:           &RPCError{Code: code, Message: message},
	}
}

func Call(socketPath string, request []byte) ([]byte, error) {
	connection, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(24 * time.Hour)); err != nil {
		return nil, err
	}
	if _, err := connection.Write(append(request, '\n')); err != nil {
		return nil, err
	}
	return readAllLimited(connection)
}
