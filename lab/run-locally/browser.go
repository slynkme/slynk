package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Slynk opens in a window of its own where it can:
// Chrome, Edge and Brave can show a page as an app, with no
// address bar or tabs, and with a profile of its own it has no extensions
// (which can read pages), isn't signed in to any account, and keeps its
// history and storage apart from everyday browsing. Firefox and Safari can't,
// so for someone whose default is one of those, an installed Chrome, Edge or
// Brave is used instead; with none, the default browser opens it as usual.

// A browser that can open Slynk as an app.
type appBrowser struct {
	name string // as it's told to the person, e.g. "Brave"
	key  string // its profile's folder name
	exe  string // the program to start (on macOS, the .app)
}

// The order to look in when the default can't: Brave first, as the most
// privacy-minded, Edge last.
var appBrowsers = []struct{ name, key string }{
	{"Brave", "brave"},
	{"Chrome", "chrome"},
	{"Chromium", "chromium"},
	{"Edge", "edge"},
}

// The browser chosen at start, for every Slynk window opened later.
var chosen struct {
	sync.Mutex
	b  appBrowser
	ok bool
}

// The browser this program started for Slynk's window, while it runs.
var started struct {
	sync.Mutex
	cmd  *exec.Cmd
	done chan struct{} // closed when it ends
}

// openSlynk opens the page, in a window of its own where it can. ended, if
// given, is told when the browser started for it ends.
func openSlynk(url string, ended func()) {
	chosen.Lock()
	defer chosen.Unlock()
	chosen.b, chosen.ok = chooseBrowser()
	if chosen.ok {
		if cmd, err := startApp(chosen.b, url); err == nil {
			fmt.Printf("Opening Slynk in %s, in a window of its own.\n", chosen.b.name)
			watchBrowser(cmd, ended)
			return
		}
		chosen.ok = false
	}
	openDefault(url)
}

// watchBrowser tells ended when the browser started for Slynk's window ends.
// One that only hands the window to a copy of itself already running ends at
// once, and counts for nothing.
func watchBrowser(cmd *exec.Cmd, ended func()) {
	done := make(chan struct{})
	started.Lock()
	started.cmd, started.done = cmd, done
	started.Unlock()
	from := time.Now()
	go func() {
		_ = cmd.Wait()
		close(done)
		started.Lock()
		if started.cmd == cmd {
			started.cmd = nil
		}
		started.Unlock()
		if ended != nil && time.Since(from) > 5*time.Second {
			ended()
		}
	}()
}

// closeBrowser asks the browser started for Slynk's window to close, if it's
// still running, as closing it would (so it doesn't offer to restore pages
// next time), and waits a few seconds for it.
func closeBrowser() {
	started.Lock()
	cmd, done := started.cmd, started.done
	started.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	endBrowser(cmd.Process)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
}

// openWindow opens another Slynk window (the page asked: /api/open), or the
// default browser where there's no window of its own.
func openWindow(url string) {
	chosen.Lock()
	defer chosen.Unlock()
	if !chosen.ok {
		chosen.b, chosen.ok = chooseBrowser()
	}
	if chosen.ok {
		if cmd, err := startApp(chosen.b, url); err == nil {
			go func() { _ = cmd.Wait() }() // it hands the window to the copy already running
			return
		}
	}
	openDefault(url)
}

// chooseBrowser picks the default browser if it can open an app window, or
// else the first such browser installed.
func chooseBrowser() (appBrowser, bool) {
	if key := defaultBrowser(); key != "" {
		if exe := findBrowser(key); exe != "" {
			return appBrowser{nameOf(key), key, exe}, true
		}
	}
	for _, b := range appBrowsers {
		if exe := findBrowser(b.key); exe != "" {
			return appBrowser{b.name, b.key, exe}, true
		}
	}
	return appBrowser{}, false
}

func nameOf(key string) string {
	for _, b := range appBrowsers {
		if b.key == key {
			return b.name
		}
	}
	return key
}

// appArgs are the browser's options: the page as an app, in Slynk's own
// profile, with no extensions, sync, first-run pages, default-browser
// question or offer to restore pages.
func appArgs(b appBrowser, url string) ([]string, error) {
	dir, err := profileDir(b.key)
	if err != nil {
		return nil, err
	}
	return []string{
		"--app=" + url,
		"--user-data-dir=" + dir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-sync",
		"--hide-crash-restore-bubble",
		"--window-size=1100,860",
	}, nil
}

// profileDir is Slynk's own profile for this browser, the same every time,
// so an inbox kept there is there next time.
func profileDir(key string) (string, error) {
	var base string
	var err error
	if runtime.GOOS == "windows" {
		base, err = os.UserCacheDir() // %LocalAppData%, which doesn't roam
	} else {
		base, err = os.UserConfigDir()
	}
	if err != nil {
		return "", err
	}
	name := "Slynk"
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		name = "slynk"
	}
	dir := filepath.Join(base, name, "browser", key)
	return dir, os.MkdirAll(dir, 0o700)
}

// exists reports whether a file is there.
func exists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

// lookPath finds a program on the PATH, or "".
func lookPath(names ...string) string {
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
}
