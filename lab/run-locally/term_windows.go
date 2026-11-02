package main

import (
	"os"
	"syscall"
)

// inTerminal reports whether this program has a console to write to. Built
// as a windows program (-H=windowsgui), as the downloads are, it has none.
func inTerminal() bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(os.Stdout.Fd()), &mode) == nil
}
