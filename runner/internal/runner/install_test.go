package runner

import (
	"strings"
	"testing"
)

func TestLaunchAgentPreservesSupervisorsInAquaSession(t *testing.T) {
	plist := launchAgentPlist(
		"/Users/test/Library/Application Support/RunBeacon/bin/runbeacon-runner",
		"/Users/test/Library/Application Support/RunBeacon/logs",
	)
	for _, expected := range []string{
		"<key>LimitLoadToSessionType</key><string>Aqua</string>",
		"<key>AbandonProcessGroup</key><true/>",
		"<key>Umask</key><integer>63</integer>",
		"<key>ProcessType</key><string>Interactive</string>",
	} {
		if !strings.Contains(plist, expected) {
			t.Fatalf("LaunchAgent plist missing %q", expected)
		}
	}
}
