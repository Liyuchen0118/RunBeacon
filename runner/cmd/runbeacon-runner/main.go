package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/Liyuchen0118/RunBeacon/runner/internal/runner"
)

var version = "3.0.0"

func main() {
	if len(os.Args) < 2 {
		fatal(errors.New("usage: runbeacon-runner <serve|rpc|supervise|install|uninstall|version>"))
	}

	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "rpc":
		err = rpc(os.Args[2:])
	case "supervise":
		err = supervise(os.Args[2:])
	case "install":
		err = install(os.Args[2:])
	case "uninstall":
		err = uninstall(os.Args[2:])
	case "version", "--version", "-version":
		fmt.Println(version)
		return
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fatal(err)
	}
}

func install(args []string) error {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	stateDir := flags.String("state-dir", "", "runner state directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	return runner.Install(*stateDir)
}

func uninstall(args []string) error {
	flags := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	stateDir := flags.String("state-dir", "", "runner state directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	return runner.Uninstall(*stateDir)
}

func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	stateDir := flags.String("state-dir", "", "runner state directory")
	socketPath := flags.String("socket", "", "runner Unix socket")
	if err := flags.Parse(args); err != nil {
		return err
	}
	paths, err := runner.ResolvePaths(*stateDir, *socketPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runner.NewServer(paths, version, os.Args[0]).Serve(ctx)
}

func rpc(args []string) error {
	flags := flag.NewFlagSet("rpc", flag.ContinueOnError)
	socketPath := flags.String("socket", "", "runner Unix socket")
	if err := flags.Parse(args); err != nil {
		return err
	}
	paths, err := runner.ResolvePaths("", *socketPath)
	if err != nil {
		return err
	}
	request, err := io.ReadAll(io.LimitReader(os.Stdin, runner.MaxRPCBytes+1))
	if err != nil {
		return err
	}
	if len(request) > runner.MaxRPCBytes {
		return errors.New("RPC request exceeds the size limit")
	}
	response, err := runner.Call(paths.SocketPath, request)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(response)
	return err
}

func supervise(args []string) error {
	flags := flag.NewFlagSet("supervise", flag.ContinueOnError)
	jobDir := flags.String("job-dir", "", "job state directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *jobDir == "" {
		return errors.New("--job-dir is required")
	}
	var spec runner.SupervisorSpec
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, runner.MaxRPCBytes))
	if err := decoder.Decode(&spec); err != nil {
		return fmt.Errorf("decode supervisor input: %w", err)
	}
	return runner.Supervise(*jobDir, spec)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(1)
}
