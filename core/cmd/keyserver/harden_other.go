//go:build !linux

package main

import "errors"

func harden() error {
	return errors.New("the key server runs on Linux only (use -dev to try it elsewhere)")
}
