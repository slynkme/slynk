// The core module keeps Go 1.23's runtime defaults for the browser's engine
// (core/go.mod). The key server takes today's, which include post-quantum key
// exchange in TLS (X25519MLKEM768 and others) and no SHA-1 signatures: the
// shares travel in these connections, so a recording of them must stay
// unreadable even to a future quantum computer.
//
//go:debug default=go1.26

// Command keyserver is slynk.me's key-share server: core/keyserver over HTTPS.
//
//	keyserver -cert fullchain.pem -key privkey.pem   (as installed: deploy/keyserver/)
//	keyserver -dev 127.0.0.1:8099                     (local tests: plain HTTP, no hardening)
//	keyserver -init                                   (once, at install: see below)
//
// Shares live only in memory. SIGTERM or SIGINT stops it cleanly, writing the
// waiting shares to the shutdown file, which the next start reads back and
// destroys before answering. Starting without one means the shares were lost
// (a crash), and for the next three weeks answers say so; -init writes an
// empty one at install, so the first start isn't taken for that.
//
// SIGHUP reloads the certificate (certbot's deploy hook sends it), keeping
// everything in memory; until there is one (at install), HTTPS handshakes
// fail and only certbot's challenges are served. It logs nothing about
// requests, only start-up problems, to standard error, and a crash prints no
// stack trace (it could hold request bytes).
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"slynk/core/keyserver"
)

func main() {
	debug.SetTraceback("none")
	// First, so a stop or a reload during start-up is handled, not fatal.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)

	cfg := keyserver.DefaultConfig()
	listen := flag.String("listen", ":443", "HTTPS address")
	plain := flag.String("http", ":80", `plain-HTTP address, serving only certbot's challenges from -acme-dir ("" for none)`)
	dev := flag.String("dev", "", "plain-HTTP address serving the protocol, for local tests (no HTTPS, no hardening)")
	cert := flag.String("cert", "/etc/keyserver/tls/fullchain.pem", "certificate chain (PEM)")
	key := flag.String("key", "/etc/keyserver/tls/privkey.pem", "its private key (PEM)")
	acme := flag.String("acme-dir", "/var/lib/keyserver/acme", "certbot's webroot")
	state := flag.String("state-dir", "/var/lib/keyserver", "where the shutdown file goes")
	status := flag.String("status", "/run/keyserver/status", `the hourly line ("" for none)`)
	initOnly := flag.Bool("init", false, "write an empty shutdown file, so the first start counts as clean, then exit")
	maxRecords := flag.Int("max-records", 2_000_000, `records kept at most (about 200 bytes each in memory: 2 million fit a 1 GB server); new links are refused "full" beyond`)
	maxConns := flag.Int("max-conns", 2048, "open connections at most, on each port (about 40 KB each); more wait to be accepted")
	flag.Func("allow-origin", `the pages' origins, comma-separated, the site's own first (default "`+strings.Join(cfg.AllowOrigins, ",")+`"; "" for no check): each request from one gets it back as Access-Control-Allow-Origin; browsers' requests from any other are refused`, func(v string) (err error) {
		cfg.AllowOrigins, err = keyserver.ParseOrigins(v)
		return err
	})
	flag.IntVar(&cfg.PowBits, "pow-bits", cfg.PowBits, "the puzzle's difficulty (0: off)")
	flag.IntVar(&cfg.CoverGap, "cover-gap", cfg.CoverGap, "mean seconds between a tab's cover requests")
	flag.BoolVar(&cfg.OneTimeOnly, "one-time-only", cfg.OneTimeOnly, "slynk.me's rule: one-time links only")
	flag.Parse()
	fail := func(err error) {
		fmt.Fprintln(os.Stderr, "keyserver:", err)
		os.Exit(1)
	}

	savePath := filepath.Join(*state, "shutdown")
	if *initOnly {
		if _, err := os.Stat(savePath); !errors.Is(err, os.ErrNotExist) {
			fail(errors.New("there's a shutdown file already: its links would be lost"))
		}
		if err := keyserver.NewStore(*maxRecords).Save(savePath, 0, time.Now().Unix()); err != nil {
			fail(err)
		}
		return
	}
	if *dev == "" {
		if err := harden(); err != nil {
			fail(err)
		}
	}

	// Every port is bound before the shutdown file is read: if one can't be,
	// nothing has been read or destroyed yet.
	bind := func(addr string) net.Listener {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			fail(err)
		}
		return limit(ln, *maxConns)
	}
	var devLn, tlsLn, acmeLn net.Listener
	if *dev != "" {
		devLn = bind(*dev)
	} else {
		tlsLn = bind(*listen)
		if *plain != "" {
			acmeLn = bind(*plain)
		}
	}

	store, restartedAt, err := keyserver.Load(savePath, *maxRecords, time.Now().Unix())
	if err != nil {
		fail(err)
	}
	ks := keyserver.NewServer(cfg, store, restartedAt)
	// From here on, every way out saves the shares first.
	var servers []*http.Server
	errs := make(chan error, 3)
	stop := func(code int) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		for _, s := range servers {
			if s.Shutdown(ctx) != nil {
				_ = s.Close()
			}
		}
		cancel()
		if err := store.Save(savePath, ks.RestartedAt(), time.Now().Unix()); err != nil {
			fail(fmt.Errorf("couldn't save the shares: %w", err))
		}
		os.Exit(code)
	}

	quiet := log.New(io.Discard, "", 0) // net/http would log clients' addresses
	serve := func(s *http.Server, ln net.Listener, tlsOn bool) {
		s.ErrorLog, s.MaxHeaderBytes = quiet, 8<<10
		s.ReadHeaderTimeout, s.ReadTimeout, s.WriteTimeout, s.IdleTimeout = 5*time.Second, 5*time.Second, 10*time.Second, 15*time.Second
		s.HTTP2 = &http.HTTP2Config{MaxConcurrentStreams: 8}
		servers = append(servers, s)
		go func() {
			var err error
			if tlsOn {
				err = s.ServeTLS(ln, "", "")
			} else {
				err = s.Serve(ln)
			}
			if !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}()
	}
	var certs atomic.Pointer[tls.Certificate]
	loadCert := func() error {
		c, err := tls.LoadX509KeyPair(*cert, *key)
		if err == nil {
			certs.Store(&c)
		}
		return err
	}
	if *dev != "" {
		serve(&http.Server{Handler: ks}, devLn, false)
	} else {
		if err := loadCert(); err != nil {
			fmt.Fprintln(os.Stderr, "keyserver: no certificate yet: serving only certbot's challenges until a SIGHUP brings one")
		}
		serve(&http.Server{Handler: hsts(ks), TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
				if c := certs.Load(); c != nil {
					return c, nil
				}
				return nil, errors.New("no certificate yet")
			},
		}}, tlsLn, true)
		if acmeLn != nil {
			serve(&http.Server{Handler: challenges(*acme)}, acmeLn, false)
		}
	}
	writeStatus(*status, startLine(restartedAt))
	notify("READY=1") // systemd: started, and the shutdown file destroyed

	hourly := time.NewTimer(untilNextHour())
	for {
		select {
		case <-hourly.C:
			writeStatus(*status, store.Report(time.Now().Unix()))
			hourly.Reset(untilNextHour())
		case <-errs:
			stop(1)
		case s := <-sig:
			if s != syscall.SIGHUP {
				stop(0)
			}
			if *dev == "" {
				_ = loadCert() // a bad file keeps the certificate already loaded
			}
		}
	}
}

// limit caps a listener's open connections at n: beyond it, Accept waits
// (new connections queue in the kernel) until one closes.
func limit(ln net.Listener, n int) net.Listener {
	return &limitListener{Listener: ln, sem: make(chan struct{}, max(1, n)), done: make(chan struct{})}
}

type limitListener struct {
	net.Listener
	sem       chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

func (l *limitListener) Accept() (net.Conn, error) {
	select {
	case l.sem <- struct{}{}:
	case <-l.done:
		return nil, net.ErrClosed
	}
	c, err := l.Listener.Accept()
	if err != nil {
		<-l.sem
		return nil, err
	}
	return &limitConn{Conn: c, release: sync.OnceFunc(func() { <-l.sem })}, nil
}

func (l *limitListener) Close() error {
	l.closeOnce.Do(func() { close(l.done) })
	return l.Listener.Close()
}

type limitConn struct {
	net.Conn
	release func()
}

func (c *limitConn) Close() error {
	err := c.Conn.Close()
	c.release()
	return err
}

// notify sends a state to systemd (Type=notify), if it's listening.
func notify(state string) {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" {
		return
	}
	if path[0] == '@' {
		path = "\x00" + path[1:] // an abstract socket
	}
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		return
	}
	defer c.Close()
	_, _ = c.Write([]byte(state))
}

// untilNextHour is the time to the next hour, plus a few seconds.
func untilNextHour() time.Duration {
	now := time.Now()
	return now.Truncate(time.Hour).Add(time.Hour + 5*time.Second).Sub(now)
}

func startLine(restartedAt int64) string {
	how := "with the shares it saved at its last clean shutdown"
	if restartedAt != 0 && time.Now().Unix()-restartedAt < 60 {
		how = "WITHOUT its shares (after a crash, or the shutdown file was missing): links made before now can't be opened"
	}
	return "keyserver: started at " + time.Now().UTC().Format("2006-01-02 15:04") + " UTC, " + how + ".\n"
}

// writeStatus replaces the status file (in /run, so in memory) with line.
func writeStatus(path, line string) {
	if path == "" {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, []byte(line), 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

// hsts asks browsers to use only HTTPS for this host.
func hsts(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		h.ServeHTTP(w, r)
	})
}

var challengeName = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// challenges serves certbot's HTTP-01 challenge files, which certbot --webroot
// puts under dir/.well-known/acme-challenge/, and nothing else.
func challenges(dir string) http.Handler {
	const prefix = "/.well-known/acme-challenge/"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, ok := strings.CutPrefix(r.URL.Path, prefix)
		if !ok || r.Method != http.MethodGet || !challengeName.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		b, err := os.ReadFile(filepath.Join(dir, prefix, name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write(b)
	})
}
