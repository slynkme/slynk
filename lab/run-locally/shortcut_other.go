//go:build !windows && !darwin

package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed slynk.png
var logo []byte

// addShortcut puts Slynk in the desktop's apps menu, with its logo:
// a program file can't carry an icon on Linux, but a
// .desktop file can. It points at this program where it is, so it's written
// again if the program has moved. It opens no terminal: Slynk's window is all
// there is, and closing it stops the program (lifetime.go).
func addShortcut() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		data = filepath.Join(home, ".local", "share")
	}
	icon := filepath.Join(data, "icons", "hicolor", "256x256", "apps", "slynk.png")
	entry := strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=Slynk",
		"Comment=Private file and message drop, run from this computer",
		"Exec=" + execQuote(exe),
		"Icon=" + icon,
		"Terminal=false",
		"Categories=Network;",
		"",
	}, "\n")
	file := filepath.Join(data, "applications", "slynk.desktop")
	if old, err := os.ReadFile(file); err == nil && string(old) == entry {
		return
	}
	if os.MkdirAll(filepath.Dir(icon), 0o755) != nil || os.WriteFile(icon, logo, 0o644) != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(file), 0o755) != nil || os.WriteFile(file, []byte(entry), 0o644) != nil {
		return
	}
	fmt.Println("Added Slynk to your apps menu.")
}

// execQuote quotes a path for a .desktop file's Exec line, as its
// specification says: in double quotes, with \, ", ` and $ escaped.
func execQuote(path string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", `$`, `\$`)
	return `"` + r.Replace(path) + `"`
}
