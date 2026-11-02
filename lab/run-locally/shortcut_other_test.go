//go:build !windows && !darwin

package main

import "testing"

func TestExecQuote(t *testing.T) {
	if got := execQuote(`/home/a b/$x "q" \`); got != `"/home/a b/\$x \"q\" \\"` {
		t.Fatalf("got %s", got)
	}
}
