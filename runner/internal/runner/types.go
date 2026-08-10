package runner

import "time"

const (
	ProtocolVersion = 1
	MaxRPCBytes     = 70 * 1024 * 1024
)

type JobState string

const (
	StateQueued    JobState = "queued"
	StateRunning   JobState = "running"
	StateSucceeded JobState = "succeeded"
	StateFailed    JobState = "failed"
	StateCancelled JobState = "cancelled"
	StateTimedOut  JobState = "timed_out"
	StateLost      JobState = "lost"
)

func (state JobState) Terminal() bool {
	switch state {
	case StateSucceeded, StateFailed, StateCancelled, StateTimedOut, StateLost:
		return true
	default:
		return false
	}
}

type OutputPolicy struct {
	Mode           string `json:"mode"`
	MaxBytes       int64  `json:"maxBytes"`
	RetentionHours int    `json:"retentionHours"`
}

type Job struct {
	ProtocolVersion      int          `json:"protocolVersion"`
	ID                   string       `json:"id"`
	IdempotencyKey       string       `json:"idempotencyKey,omitempty"`
	CommandDigest        string       `json:"commandDigest"`
	State                JobState     `json:"state"`
	CreatedAt            time.Time    `json:"createdAt"`
	UpdatedAt            time.Time    `json:"updatedAt"`
	StartedAt            *time.Time   `json:"startedAt,omitempty"`
	FinishedAt           *time.Time   `json:"finishedAt,omitempty"`
	SupervisorPID        int          `json:"supervisorPid,omitempty"`
	ProcessGroupID       int          `json:"processGroupId,omitempty"`
	ExitCode             *int         `json:"exitCode,omitempty"`
	Signal               string       `json:"signal,omitempty"`
	Error                string       `json:"error,omitempty"`
	CancellationVerified bool         `json:"cancellationVerified"`
	OutputPolicy         OutputPolicy `json:"outputPolicy"`
	OutputBytes          int64        `json:"outputBytes"`
	OutputTruncated      bool         `json:"outputTruncated"`
	LastEventSequence    uint64       `json:"lastEventSequence"`
}

type Event struct {
	Sequence  uint64         `json:"sequence"`
	Timestamp time.Time      `json:"timestamp"`
	Type      string         `json:"type"`
	State     JobState       `json:"state,omitempty"`
	Stream    string         `json:"stream,omitempty"`
	Data      string         `json:"data,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

type Request struct {
	ProtocolVersion int            `json:"protocolVersion"`
	Method          string         `json:"method"`
	Params          map[string]any `json:"params,omitempty"`
}

type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	ProtocolVersion int       `json:"protocolVersion"`
	OK              bool      `json:"ok"`
	Result          any       `json:"result,omitempty"`
	Error           *RPCError `json:"error,omitempty"`
}

type SubmitParams struct {
	JobID          string            `json:"jobId"`
	IdempotencyKey string            `json:"idempotencyKey"`
	CommandDigest  string            `json:"commandDigest"`
	Command        string            `json:"command"`
	CWD            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutMillis  int64             `json:"timeoutMillis,omitempty"`
	OutputPolicy   OutputPolicy      `json:"outputPolicy"`
}

type WatchParams struct {
	JobID         string `json:"jobId"`
	AfterSequence uint64 `json:"afterSequence"`
	TimeoutMillis int64  `json:"timeoutMillis"`
}

type SupervisorSpec struct {
	Command       string            `json:"command"`
	CWD           string            `json:"cwd,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	TimeoutMillis int64             `json:"timeoutMillis,omitempty"`
}
