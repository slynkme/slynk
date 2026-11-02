//go:build !windows && !darwin

package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// defaultBrowser asks the desktop which browser opens web pages, and gives its
// key if it can open an app window, else "".
func defaultBrowser() string {
	out, err := exec.Command("xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return ""
	}
	d := strings.ToLower(string(out))
	switch {
	case strings.Contains(d, "brave"):
		return "brave"
	case strings.Contains(d, "chromium"):
		return "chromium"
	case strings.Contains(d, "chrome"):
		return "chrome"
	case strings.Contains(d, "edge"):
		return "edge"
	}
	return ""
}

// findBrowser finds a browser's program on the PATH, or "".
func findBrowser(key string) string {
	switch key {
	case "brave":
		return lookPath("brave-browser", "brave")
	case "chrome":
		return lookPath("google-chrome", "google-chrome-stable")
	case "chromium":
		return lookPath("chromium", "chromium-browser")
	case "edge":
		return lookPath("microsoft-edge", "microsoft-edge-stable")
	}
	return ""
}

// startApp starts the browser in a session of its own, so Ctrl+C in this
// program's terminal reaches this program only, which then closes it gently.
func startApp(b appBrowser, url string) (*exec.Cmd, error) {
	args, err := appArgs(b, url)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(b.exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd, cmd.Start()
}

// endBrowser asks the browser to close, as quitting it would.
func endBrowser(p *os.Process) {
	_ = p.Signal(syscall.SIGTERM)
}

func openDefault(url string) {
	_ = exec.Command("xdg-open", url).Start()
}
