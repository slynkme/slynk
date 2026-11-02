//go:build !windows && !darwin

package main

import "os/exec"

// alert shows msg with whichever of the desktop's own tools is there, or
// nowhere (it's in the terminal's output too, for anyone who started it
// there).
func alert(msg string) {
	for _, try := range [][]string{
		{"zenity", "--error", "--title=Slynk", "--no-markup", "--text=" + msg},
		{"kdialog", "--title", "Slynk", "--error", msg},
		{"notify-send", "--urgency=critical", "Slynk", msg},
	} {
		if path, err := exec.LookPath(try[0]); err == nil && exec.Command(path, try[1:]...).Run() == nil {
			return
		}
	}
}
