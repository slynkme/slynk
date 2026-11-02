//go:build linux

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"syscall"
)

const (
	mclOnFault    = 4 // MCL_ONFAULT (Linux 4.4+): lock pages as they're first touched
	prSetDumpable = 4 // PR_SET_DUMPABLE
)

// harden keeps the shares off the disk and out of other processes' reach:
// it refuses to run while swap is on (memory could be written to it), locks
// all of this program's memory into RAM, and makes it undumpable, which also
// stops other processes (root aside) attaching to it or reading its memory.
func harden() error {
	if n, err := swapAreas(); err != nil {
		return fmt.Errorf("can't read /proc/swaps: %w", err)
	} else if n > 0 {
		return errors.New("swap is on: switch it off (swapoff -a, and remove it from /etc/fstab) first")
	}
	if err := syscall.Mlockall(syscall.MCL_CURRENT | syscall.MCL_FUTURE | mclOnFault); err != nil {
		return fmt.Errorf("can't lock memory (needs CAP_IPC_LOCK or LimitMEMLOCK=infinity): %w", err)
	}
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); e != 0 {
		return fmt.Errorf("can't make this process undumpable: %w", e)
	}
	return nil
}

// swapAreas counts the swap areas in use (/proc/swaps lists one a line, after a header).
func swapAreas() (int, error) {
	f, err := os.Open("/proc/swaps")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n := -1
	for s := bufio.NewScanner(f); s.Scan(); {
		n++
	}
	return max(n, 0), nil
}
