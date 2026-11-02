//go:build linux || darwin

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// inTerminal reports whether this program was started from a terminal, which
// can show what it says. Started from the desktop, its output goes nowhere
// (on a Mac, to /dev/null, which is no terminal).
func inTerminal() bool {
	var t syscall.Termios
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, os.Stdout.Fd(), getTermios, uintptr(unsafe.Pointer(&t)))
	return e == 0
}
