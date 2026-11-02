//go:build windows || darwin

package main

// addShortcut does nothing here: a Windows program carries its own icon
// (rsrc_windows_amd64.syso), and on a Mac the app does (Slynk.app).
func addShortcut() {}
