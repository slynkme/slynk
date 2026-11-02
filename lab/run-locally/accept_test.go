package main

import "testing"

func TestAcceptsEncoding(t *testing.T) {
	for _, c := range []struct {
		header, token string
		want          bool
	}{
		{"gzip, deflate, br, zstd", "br", true},
		{"gzip, deflate", "br", false},
		{"gzip;q=0", "gzip", false},
		{"gzip; q=0.000", "gzip", false},
		{"GZIP;Q=0.5", "gzip", true},
		{"*", "gzip", true},
		{"*;q=0", "gzip", false},
		{"*, gzip;q=0", "gzip", false},
		{"gzip;q=0, *", "gzip", false},
		{"", "gzip", false},
	} {
		if got := acceptsEncoding(c.header, c.token); got != c.want {
			t.Errorf("acceptsEncoding(%q, %q) = %v, want %v", c.header, c.token, got, c.want)
		}
	}
}
