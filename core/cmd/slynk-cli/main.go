// Command slynk-cli sends and receives Slynk transfers from a terminal using
// the same core as the browser, which makes it handy for cross-checking.
//
//	slynk-cli send FILE...               prints one link per file
//	slynk-cli receive LINK OUT [LINK OUT]...
//	                                     LINK may be a full https://slynk.me/#...
//	                                     URL, or a lab link file (*.json, e.g.
//	                                     lab/mixnet-smoketest/testdata/*.json)
//	slynk-cli inbox ...                  anonymous inboxes (see inbox.go)
//	slynk-cli cover DURATION [FILE...]   cover messages, then timed uploads (cover.go)
//
// Several files or links share one identity, so a lab test costs one
// registrar sign-up per side. SLYNK_VERBOSE=1 prints xxDK's logs.
// SLYNK_SITE=https://example.org prints links and inbox addresses for that
// site instead of https://slynk.me (web/src/site.ts SITE_URL).
// SLYNK_READ_BACK=1 makes send confirm parts by reading them back, as uploads
// did before 2026-10-14, instead of by their rounds' results.
package main

import (
	"cmp"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"slynk/core/transfer"
)

// siteURL is what links and inbox addresses begin with: the site's address, then /#.
var siteURL = strings.TrimSuffix(cmp.Or(os.Getenv("SLYNK_SITE"), "https://slynk.me"), "/") + "/#"

var start = time.Now()

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[%6.1fs] %s\n", time.Since(start).Seconds(), fmt.Sprintf(format, a...))
}

func main() {
	if len(os.Args) >= 2 && (os.Args[1] == "inbox" || os.Args[1] == "cover") {
		transfer.SetVerbose(os.Getenv("SLYNK_VERBOSE") != "")
		if os.Args[1] == "inbox" {
			runInbox(os.Args[2:])
		} else {
			runCover(os.Args[2:])
		}
		return
	}
	args := os.Args[min(2, len(os.Args)):]
	if len(os.Args) < 3 || (os.Args[1] == "receive" && len(args)%2 != 0) {
		fmt.Fprintln(os.Stderr, "usage: slynk-cli send FILE... | slynk-cli receive LINK OUT [LINK OUT]...")
		os.Exit(2)
	}
	transfer.SetVerbose(os.Getenv("SLYNK_VERBOSE") != "")

	// Read and check everything before connecting, so a typo costs no
	// identity.
	var payloads, links [][]byte
	switch os.Args[1] {
	case "send":
		for _, path := range args {
			data, err := os.ReadFile(path)
			if err != nil {
				fail(err)
			}
			payloads = append(payloads, data)
		}
	case "receive":
		for i := 0; i < len(args); i += 2 {
			link, err := parseLink(args[i])
			if err != nil {
				fail(err)
			}
			links = append(links, link)
		}
	default:
		fail(fmt.Errorf("unknown command %q", os.Args[1]))
	}

	c := connect()
	defer c.Close()

	switch os.Args[1] {
	case "send":
		if os.Getenv("SLYNK_READ_BACK") != "" {
			c.SetConfirmByRound(false)
			logf("confirming parts by reading them back, not by round results")
		}
		for i, data := range payloads {
			name := args[i]
			began := time.Now()
			link, err := c.Upload(data, func(stage string, done, total int) {
				logf("%s %s: %d/%d parts", name, stage, done, total)
			})
			if err != nil {
				fail(fmt.Errorf("%s: %w", name, err))
			}
			took := time.Since(began).Seconds()
			logf("uploaded %s, %d bytes, in %.1fs (%.1f KB/s)", name, len(data), took, float64(len(data))/1000/took)
			fmt.Println(siteURL + base64.RawURLEncoding.EncodeToString(link))
		}
	case "receive":
		for i, link := range links {
			out := args[2*i+1]
			began := time.Now()
			data, err := c.Download(link, func(stage string, done, total int) {
				if stage == "stalled" {
					logf("%s: no new parts for a while (%d of %d have arrived); still waiting", out, done, total)
					return
				}
				logf("%s %s: %d/%d parts", out, stage, done, total)
			})
			if err != nil {
				fail(fmt.Errorf("%s: %w", out, err))
			}
			if err = os.WriteFile(out, data, 0o600); err != nil {
				fail(err)
			}
			logf("downloaded %d bytes to %s in %.1fs", len(data), out, time.Since(began).Seconds())
		}
	}
}

// parseLink accepts a full link, its fragment, or a lab link file.
func parseLink(s string) ([]byte, error) {
	if strings.HasSuffix(s, ".json") {
		return linkFromLabFile(s)
	}
	if i := strings.LastIndex(s, "#"); i >= 0 {
		s = s[i+1:]
	}
	link, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("link isn't valid: %w", err)
	}
	return link, nil
}

func connect() *transfer.Client {
	lastStage := ""
	c, err := transfer.Connect(func(stage string, done, total int) {
		if stage != lastStage || stage == "ready" {
			logf("connect: %s %d/%d", stage, done, total)
			lastStage = stage
		}
	})
	if err != nil {
		fail(err)
	}
	return c
}

// linkFromLabFile reads a link recorded by lab/mixnet-smoketest:
// {"fileLink": {...xxDK FileLink...}, "sha256": "..."}.
func linkFromLabFile(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var lf struct {
		FileLink json.RawMessage `json:"fileLink"`
	}
	if err = json.Unmarshal(raw, &lf); err != nil || len(lf.FileLink) == 0 {
		return nil, fmt.Errorf("%s isn't a lab link file", path)
	}
	return transfer.PackFileLinkJSON(lf.FileLink)
}

func fail(err error) {
	logf("FAILED: %v", err)
	os.Exit(1)
}
