package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// defaultBrowser reads which browser opens https links, from the setting
// Windows keeps for the person, and gives its key if it can open an app
// window, else "".
func defaultBrowser() string {
	id := userChoice(`Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`)
	switch {
	case strings.HasPrefix(id, "BraveHTML"):
		return "brave"
	case strings.HasPrefix(id, "ChromeHTML"):
		return "chrome"
	case strings.HasPrefix(id, "ChromiumHTM"):
		return "chromium"
	case strings.HasPrefix(id, "MSEdgeHTM"):
		return "edge"
	}
	return ""
}

// userChoice reads the ProgId under a key of HKEY_CURRENT_USER, or "".
func userChoice(path string) string {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	var h syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, p, 0, syscall.KEY_READ, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	name, _ := syscall.UTF16PtrFromString("ProgId")
	buf := make([]uint16, 256)
	n := uint32(len(buf) * 2)
	var typ uint32
	if syscall.RegQueryValueEx(h, name, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil || typ != syscall.REG_SZ {
		return ""
	}
	return syscall.UTF16ToString(buf[:n/2])
}

// findBrowser finds a browser's program where its installer puts it, or "".
func findBrowser(key string) string {
	var rel []string
	switch key {
	case "brave":
		rel = []string{`BraveSoftware\Brave-Browser\Application\brave.exe`}
	case "chrome":
		rel = []string{`Google\Chrome\Application\chrome.exe`}
	case "chromium":
		rel = []string{`Chromium\Application\chrome.exe`}
	case "edge":
		rel = []string{`Microsoft\Edge\Application\msedge.exe`}
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		for _, r := range rel {
			if p := filepath.Join(base, r); exists(p) {
				return p
			}
		}
	}
	return ""
}

// startApp starts the browser with the page as an app.
func startApp(b appBrowser, url string) (*exec.Cmd, error) {
	args, err := appArgs(b, url)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(b.exe, args...)
	return cmd, cmd.Start()
}

// endBrowser asks the browser to close its windows, as clicking their close
// buttons would (taskkill without /F).
func endBrowser(p *os.Process) {
	cmd := exec.Command("taskkill", "/PID", strconv.Itoa(p.Pid))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}

func openDefault(url string) {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Start()
}
