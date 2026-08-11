package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestUnixSocketPing(t *testing.T) {
	if len(t.TempDir()) > 70 {
		t.Skip("temporary path is too long for a portable Unix socket")
	}
	root := t.TempDir()
	paths := Paths{
		StateDir:   root,
		JobsDir:    filepath.Join(root, "jobs"),
		SocketPath: filepath.Join(root, "runner.sock"),
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := NewServer(paths, "test-version", os.Args[0])
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(ctx) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(paths.SocketPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("runner socket did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}

	request, _ := json.Marshal(Request{ProtocolVersion: ProtocolVersion, Method: "ping"})
	responseData, err := Call(paths.SocketPath, request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var response Response
	if err := json.Unmarshal(responseData, &response); err != nil {
		cancel()
		t.Fatal(err)
	}
	if !response.OK {
		cancel()
		t.Fatalf("ping failed: %+v", response.Error)
	}

	cancel()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("runner server did not stop")
	}
}

func TestUnixSocketRPCDoesNotLeakGoroutines(t *testing.T) {
	if len(t.TempDir()) > 70 {
		t.Skip("temporary path is too long for a portable Unix socket")
	}
	root := t.TempDir()
	paths := Paths{
		StateDir:   root,
		JobsDir:    filepath.Join(root, "jobs"),
		SocketPath: filepath.Join(root, "runner.sock"),
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := NewServer(paths, "test-version", os.Args[0])
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(ctx) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(paths.SocketPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("runner socket did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	baseline := runtime.NumGoroutine()
	request, _ := json.Marshal(Request{ProtocolVersion: ProtocolVersion, Method: "ping"})
	for attempt := 0; attempt < 1000; attempt++ {
		if _, err := Call(paths.SocketPath, request); err != nil {
			cancel()
			t.Fatal(err)
		}
	}
	runtime.GC()
	time.Sleep(100 * time.Millisecond)
	if growth := runtime.NumGoroutine() - baseline; growth > 10 {
		cancel()
		t.Fatalf("1000 RPC reconnects leaked %d goroutines", growth)
	}
	cancel()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("runner server did not stop")
	}
}
