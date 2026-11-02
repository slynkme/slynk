package main

// slynk-cli cover DURATION [FILE...] turns cover messages on, waits DURATION
// while logging how many have gone out, then uploads each FILE with cover still
// on, to see what cover does to upload speed. For lab tests.

import (
	"fmt"
	"os"
	"time"
)

func runCover(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: slynk-cli cover DURATION [FILE...]")
		os.Exit(2)
	}
	d, err := time.ParseDuration(args[0])
	if err != nil {
		fail(err)
	}
	var payloads [][]byte
	for _, path := range args[1:] {
		data, err := os.ReadFile(path)
		if err != nil {
			fail(err)
		}
		payloads = append(payloads, data)
	}

	c := connect()
	defer c.Close()
	c.SetCover(true)
	logf("cover messages on for %s", d)
	last := 0
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(time.Second) {
		if n := c.CoverSent(); n != last {
			logf("cover messages sent: %d", n)
			last = n
		}
	}
	for i, data := range payloads {
		name := args[1+i]
		began := time.Now()
		link, err := c.Upload(data, func(stage string, done, total int) {
			logf("%s %s: %d/%d parts", name, stage, done, total)
		})
		if err != nil {
			fail(fmt.Errorf("%s: %w", name, err))
		}
		took := time.Since(began).Seconds()
		logf("uploaded %s, %d bytes, in %.1fs (%.1f KB/s) with cover on", name, len(data), took, float64(len(data))/1000/took)
		_ = link // the upload is only timed
	}
	logf("done: %d cover messages sent", c.CoverSent())
}
