package runner

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

func Install(stateDir string) error {
	if runtime.GOOS == "windows" {
		return errors.New("remote Runner installation is supported only on Linux and macOS")
	}
	paths, err := ResolvePaths(stateDir, "")
	if err != nil {
		return err
	}
	if err := NewStore(paths).Prepare(); err != nil {
		return err
	}
	current, err := os.Executable()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		return installLaunchAgent(current, home)
	}
	return installSystemdUser(current, home)
}

func Uninstall(stateDir string) error {
	paths, err := ResolvePaths(stateDir, "")
	if err != nil {
		return err
	}
	if active, err := activeJobs(paths); err != nil {
		return err
	} else if len(active) > 0 {
		return fmt.Errorf("refusing to uninstall with active jobs: %s", strings.Join(active, ", "))
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		uid := strconv.Itoa(currentUserUID())
		plist := filepath.Join(home, "Library", "LaunchAgents", "io.runbeacon.runner.plist")
		_ = exec.Command("launchctl", "bootout", "gui/"+uid, plist).Run()
		if err := os.Remove(plist); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if runtime.GOOS == "linux" {
		_ = exec.Command("systemctl", "--user", "disable", "--now", "runbeacon-runner.service").Run()
		unit := filepath.Join(home, ".config", "systemd", "user", "runbeacon-runner.service")
		if err := os.Remove(unit); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
		return nil
	}
	return errors.New("unsupported operating system")
}

func activeJobs(paths Paths) ([]string, error) {
	entries, err := os.ReadDir(paths.JobsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var active []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		job, readErr := readJob(filepath.Join(paths.JobsDir, entry.Name()))
		if readErr == nil && !job.State.Terminal() {
			active = append(active, job.ID)
		}
	}
	return active, nil
}

func installSystemdUser(current, home string) error {
	target := filepath.Join(home, ".local", "bin", "runbeacon-runner")
	if err := copyExecutable(current, target); err != nil {
		return err
	}
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	if err := ensurePrivateDir(unitDir); err != nil {
		return err
	}
	unit := fmt.Sprintf(`[Unit]
Description=RunBeacon durable job runner
After=network.target

[Service]
Type=simple
ExecStart=%s serve
Restart=on-failure
RestartSec=2
KillMode=process
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
`, systemdEscape(target))
	unitPath := filepath.Join(unitDir, "runbeacon-runner.service")
	if err := os.WriteFile(unitPath, []byte(unit), 0o600); err != nil {
		return err
	}
	if output, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %s", strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("systemctl", "--user", "enable", "runbeacon-runner.service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable: %s", strings.TrimSpace(string(output)))
	}
	// Restart is intentional on upgrade. Supervisors run in independent
	// sessions and KillMode=process leaves them alive for reconciliation.
	if output, err := exec.Command("systemctl", "--user", "restart", "runbeacon-runner.service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl restart: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func installLaunchAgent(current, home string) error {
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" {
		return errors.New("macOS Runner installation must be performed locally in the logged-in GUI session")
	}
	uid := strconv.Itoa(currentUserUID())
	if err := exec.Command("launchctl", "print", "gui/"+uid).Run(); err != nil {
		return errors.New("an active macOS Aqua login session is required")
	}
	base := filepath.Join(home, "Library", "Application Support", "RunBeacon")
	binDir := filepath.Join(base, "bin")
	logDir := filepath.Join(base, "logs")
	if err := ensurePrivateDir(binDir); err != nil {
		return err
	}
	if err := ensurePrivateDir(logDir); err != nil {
		return err
	}
	target := filepath.Join(binDir, "runbeacon-runner")
	if err := copyExecutable(current, target); err != nil {
		return err
	}
	plistDir := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(plistDir, 0o700); err != nil {
		return err
	}
	plistPath := filepath.Join(plistDir, "io.runbeacon.runner.plist")
	plist := launchAgentPlist(target, logDir)
	if err := os.WriteFile(plistPath, []byte(plist), 0o600); err != nil {
		return err
	}
	_ = exec.Command("launchctl", "bootout", "gui/"+uid, plistPath).Run()
	if output, err := exec.Command("launchctl", "bootstrap", "gui/"+uid, plistPath).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func launchAgentPlist(target, logDir string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.runbeacon.runner</string>
<key>ProgramArguments</key><array><string>%s</string><string>serve</string></array>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>ProcessType</key><string>Interactive</string><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, xmlEscape(target), xmlEscape(filepath.Join(logDir, "runner.stdout.log")), xmlEscape(filepath.Join(logDir, "runner.stderr.log")))
}

func copyExecutable(source, target string) error {
	if filepath.Clean(source) == filepath.Clean(target) {
		return os.Chmod(target, 0o700)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	temporary := target + ".new"
	if err := os.WriteFile(temporary, data, 0o700); err != nil {
		return err
	}
	if err := os.Rename(temporary, target); err != nil {
		return err
	}
	return os.Chmod(target, 0o700)
}

func systemdEscape(path string) string {
	return strings.ReplaceAll(path, "%", "%%")
}

func xmlEscape(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;")
	return replacer.Replace(value)
}
