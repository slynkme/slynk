package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

var bundles = map[string]string{
	"com.brave.browser":     "brave",
	"com.google.chrome":     "chrome",
	"org.chromium.chromium": "chromium",
	"com.microsoft.edgemac": "edge",
}

var apps = map[string]string{
	"brave":    "Brave Browser.app",
	"chrome":   "Google Chrome.app",
	"chromium": "Chromium.app",
	"edge":     "Microsoft Edge.app",
}

// The program inside each app, which this one starts itself so it knows
// when it ends, and can close it: on a Mac a browser keeps running once its
// last window is closed.
var programs = map[string]string{
	"brave":    "Brave Browser",
	"chrome":   "Google Chrome",
	"chromium": "Chromium",
	"edge":     "Microsoft Edge",
}

var handlerDict = regexp.MustCompile(`(?s)<dict>(.*?)</dict>`)
var roleAll = regexp.MustCompile(`(?s)<key>LSHandlerRoleAll</key>\s*<string>([^<]+)</string>`)

// defaultBrowser reads which app opens https links, from macOS's own record
// of the person's choices, and gives its key if it can open an app window,
// else "". With no choice recorded, it's Safari.
func defaultBrowser() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	plist := filepath.Join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
	out, err := exec.Command("/usr/bin/plutil", "-convert", "xml1", "-o", "-", plist).Output()
	if err != nil {
		return ""
	}
	for _, m := range handlerDict.FindAllStringSubmatch(string(out), -1) {
		if !strings.Contains(m[1], "<string>https</string>") {
			continue
		}
		if r := roleAll.FindStringSubmatch(m[1]); r != nil {
			return bundles[strings.ToLower(strings.TrimSpace(r[1]))]
		}
	}
	return ""
}

// findBrowser finds a browser's app in /Applications or ~/Applications, or "".
func findBrowser(key string) string {
	app := apps[key]
	if app == "" {
		return ""
	}
	dirs := []string{"/Applications"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, "Applications"))
	}
	for _, d := range dirs {
		p := filepath.Join(d, app)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

// startApp starts the browser's own program, with Slynk's own profile, in a
// session of its own, so Ctrl+C in a Terminal reaches this program only,
// which then closes it gently. Without that program, macOS starts the app
// (open -n: an instance of its own, which Slynk's profile needs), and this
// one can't tell when it ends.
func startApp(b appBrowser, url string) (*exec.Cmd, error) {
	args, err := appArgs(b, url)
	if err != nil {
		return nil, err
	}
	if exe := filepath.Join(b.exe, "Contents", "MacOS", programs[b.key]); exists(exe) {
		cmd := exec.Command(exe, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		return cmd, cmd.Start()
	}
	cmd := exec.Command("/usr/bin/open", append([]string{"-na", b.exe, "--args"}, args...)...)
	return cmd, cmd.Start()
}

// endBrowser asks the browser to quit, as Cmd-Q would.
func endBrowser(p *os.Process) {
	_ = p.Signal(syscall.SIGTERM)
}

func openDefault(url string) {
	_ = exec.Command("/usr/bin/open", url).Start()
}
