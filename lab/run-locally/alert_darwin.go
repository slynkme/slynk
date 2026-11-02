package main

import "os/exec"

// alert shows msg in a macOS alert. The words go to the script as an
// argument, never as part of it.
func alert(msg string) {
	_ = exec.Command("/usr/bin/osascript",
		"-e", "on run argv",
		"-e", `display alert "Slynk" message (item 1 of argv) as critical`,
		"-e", "end run",
		msg).Run()
}
