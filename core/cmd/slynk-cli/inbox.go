package main

// Anonymous inboxes from the terminal, for network tests:
//
//	slynk-cli inbox new                    prints a new inbox's 12 words and addresses
//	slynk-cli inbox send ADDRESS TEXT...   sends each TEXT as its own message, to
//	                                       either address (the quantum-safe one in a
//	                                       file with @FILE, as it's 1,726 characters)
//	slynk-cli inbox send [-apart] ADDRESS TEXT...
//	                                       -apart sends a message to a quantum-safe
//	                                       address as its two messages one at a
//	                                       time, each in a round of its own
//	slynk-cli inbox send -from WORDSFILE [-name NAME] [-reply KEYS] ADDRESS TEXT...
//	                                       includes the inbox whose 12 words are
//	                                       in WORDSFILE, so its owner can reply;
//	                                       -reply seals it with the reply keys that
//	                                       inbox gave (hex, as "inbox check" prints
//	                                       them: secrets, so the log holds them):
//	                                       quantum-safe, in one message
//	slynk-cli inbox check SINCE FOR        reads the 12 words from stdin, looks back
//	                                       SINCE (e.g. 2h, at least a day in practice)
//	                                       and listens for FOR (e.g. 5m)
//
// Messages are raw bytes, not the website's envelope.

import (
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"slynk/core/transfer"
)

func runInbox(args []string) {
	if len(args) == 0 {
		inboxUsage()
	}
	switch args[0] {
	case "new":
		phrase, err := transfer.NewInboxPhrase()
		if err != nil {
			fail(err)
		}
		key, err := transfer.InboxKeyFromPhrase(phrase)
		if err != nil {
			fail(err)
		}
		fmt.Printf("words:   %s\naddress: %s\nquantum-safe address: %s\n", phrase,
			siteURL+base64.RawURLEncoding.EncodeToString(key.Address.Bytes()),
			siteURL+base64.RawURLEncoding.EncodeToString(key.Address4.Bytes()))
	case "send":
		fs := flag.NewFlagSet("inbox send", flag.ExitOnError)
		fromFile := fs.String("from", "", "a file holding the 12 words of an inbox to include, so its owner can reply")
		fromName := fs.String("name", "", "the name to show with it")
		replyHex := fs.String("reply", "", "the reply keys the inbox at ADDRESS gave, in hex, to send each as a reply")
		apart := fs.Bool("apart", false, "send a message to a quantum-safe address as its two messages, each in a round of its own")
		_ = fs.Parse(args[1:])
		rest := fs.Args()
		if len(rest) < 2 {
			inboxUsage()
		}
		var from *transfer.From
		if *fromFile != "" {
			words, err := os.ReadFile(*fromFile)
			if err != nil {
				fail(err)
			}
			key, err := transfer.InboxKeyFromPhrase(strings.TrimPrefix(strings.TrimSpace(string(words)), "words:"))
			if err != nil {
				fail(err)
			}
			from = &transfer.From{Key: key, Name: *fromName}
		}
		var reply *transfer.ReplyKeys
		if *replyHex != "" {
			b, err := hex.DecodeString(*replyHex)
			if err == nil {
				reply, err = transfer.ParseReplyKeys(b)
			}
			if err != nil {
				fail(transfer.ErrReplyKeys)
			}
		}
		addr := parseInboxAddress(rest[0])
		name := shortAddress(addr)
		c := connect()
		defer c.Close()
		for i, text := range rest[1:] {
			sent, err := c.SendNoticeAt(addr, transfer.NoticeText, []byte(text), from, reply,
				transfer.NoticeTiming{AtRandom: true, Apart: *apart}, func(string, int, int) {})
			if err != nil {
				fail(fmt.Errorf("message %d: %w", i+1, err))
			}
			logf("message %d delivered to %s (round time %s)", i+1, name, sent.UTC().Format(time.RFC3339))
		}
	case "check":
		if len(args) != 3 {
			inboxUsage()
		}
		since, err := time.ParseDuration(args[1])
		if err != nil {
			fail(err)
		}
		listen, err := time.ParseDuration(args[2])
		if err != nil {
			fail(err)
		}
		fmt.Fprintln(os.Stderr, "Enter the inbox's 12 words, then Ctrl-D:")
		in, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		if err != nil {
			fail(err)
		}
		// Accept the first line of "inbox new" as it was printed.
		words := strings.TrimPrefix(strings.TrimSpace(string(in)), "words:")
		key, err := transfer.InboxKeyFromPhrase(words)
		if err != nil {
			fail(err)
		}
		name := shortAddress(key.Address)
		c := connect()
		defer c.Close()
		logf("checking %s, looking back %s, for %s", name, since, listen)
		found := 0 // found is never called concurrently, nor after Close
		opened := time.Now()
		var last transfer.Lookback
		progress := func(l transfer.Lookback) {
			if l.Finished && !last.Finished {
				logf("finished looking back after %s (%d days checked, %d rounds not handed over)",
					time.Since(opened).Round(100*time.Millisecond), l.DaysTotal, l.Missing)
			} else if l.DaysLeft != last.DaysLeft || l.Collecting != last.Collecting {
				logf("looking back: %d of %d days left, %d pickups pending", l.DaysLeft, l.DaysTotal, l.Collecting)
			}
			last = l
		}
		s := c.OpenInbox(key, time.Now().Add(-since), func(n transfer.Notice) {
			found++
			kind := "compact"
			switch {
			case n.Reply:
				kind = "quantum-safe reply"
			case n.QuantumSafe:
				kind = "quantum-safe"
			}
			from := ""
			if n.From != nil {
				from = fmt.Sprintf(", from %s as %q", shortAddress(n.From), n.FromName)
			}
			if n.ReplyKeys != nil {
				from += fmt.Sprintf(", reply keys %x", n.ReplyKeys.Bytes())
			}
			logf("message %d (kind %d, %s, round %d at %s%s): %q", found, n.Kind, kind, n.Round,
				n.RoundTime.UTC().Format(time.RFC3339), from, n.Body)
		}, progress)
		time.Sleep(listen)
		s.Close()
		logf("done: %d messages, %d others' messages at the same labels, %d copies sent again dropped", found, s.Others(), s.Copies())
	default:
		inboxUsage()
	}
}

func parseInboxAddress(s string) *transfer.InboxAddress {
	if file, ok := strings.CutPrefix(s, "@"); ok {
		b, err := os.ReadFile(file)
		if err != nil {
			fail(err)
		}
		s = strings.TrimSpace(string(b))
	}
	if i := strings.LastIndex(s, "#"); i >= 0 {
		s = s[i+1:]
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		fail(transfer.ErrInboxAddress)
	}
	addr, err := transfer.ParseInboxAddress(b)
	if err != nil {
		fail(err)
	}
	return addr
}

// shortAddress is the start of an inbox's compact address, enough to tell
// test inboxes apart in a log.
func shortAddress(a *transfer.InboxAddress) string {
	return "inbox " + base64.RawURLEncoding.EncodeToString(a.Compact().Bytes())[:12] + "…"
}

func inboxUsage() {
	fmt.Fprintln(os.Stderr, "usage: slynk-cli inbox new | send [-from WORDSFILE [-name NAME] [-reply KEYS]] ADDRESS TEXT... | check SINCE FOR")
	os.Exit(2)
}
