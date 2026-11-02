// Command slynk-local serves a built copy of Slynk's website on this computer
// only, at http://127.0.0.1:<port>/, so the page runs from files on disk
// instead of from slynk.me. A prototype, to see what running Slynk locally
// takes (README.md); it isn't shipped.
//
// It does two things a plain file server doesn't:
//   - It sends the security headers slynk.me sends, read from the site's own
//     .htaccess (the Content-Security-Policy, cross-origin isolation, no
//     framing, the Permissions-Policy), so the page and its workers run as
//     they do on slynk.me.
//   - It serves the pre-compressed WebAssembly (.wasm.gz or .wasm.br) to
//     browsers that ask for the .wasm, as .htaccess does.
//
// Everything else is the page's, as on slynk.me: the browser talks to the xx
// network and to slynk.me's key server itself, which answers pages at
// http://127.0.0.1:8293 as well as https://slynk.me (its -allow-origin).
// So the port must stay 8293 for one-time links to work.
//
// It listens on 127.0.0.1 only, so other devices on the network can't reach
// it, answers only requests addressed to 127.0.0.1:<port> (another name
// pointed at this computer gets nothing), and writes no log.
//
// It opens no window of its own (a Terminal or
// black window puzzles people): Slynk's window is all there is, and closing
// it stops the program (lifetime.go). Anything that goes wrong is said in a
// message box when there's no terminal to say it in.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// embedded is the site built into the program (embed.go, with -tags embed),
// or nil to serve -site from disk.
var embedded fs.FS

func main() {
	port := flag.Int("port", 8293, "port on 127.0.0.1; keep it the same every time: the browser keeps settings and kept inboxes per address and port, and slynk.me's key server answers pages at 8293 only")
	site := flag.String("site", "site", "folder holding the built site (ignored when the site is built in)")
	open := flag.Bool("open", true, "open Slynk's window when it starts, and on Linux keep its apps-menu shortcut up to date")
	stay := flag.Bool("stay", false, "keep running once Slynk's last window closes, until stopped (for development)")
	// Some versions of macOS give an app opened from the Finder a -psn_… argument of its own.
	var args []string
	for _, a := range os.Args[1:] {
		if !strings.HasPrefix(a, "-psn_") {
			args = append(args, a)
		}
	}
	_ = flag.CommandLine.Parse(args)

	files := embedded
	if files == nil {
		dir, err := filepath.Abs(*site)
		if err == nil {
			files = os.DirFS(dir)
		}
	}
	headers, err := securityHeaders(files)
	if err != nil {
		fail("Slynk can't start, because its files are incomplete (%v). Download it again.", err)
	}

	host := fmt.Sprintf("127.0.0.1:%d", *port)
	s := &server{
		files:    files,
		host:     host,
		origin:   "http://" + host,
		headers:  headers,
		openPage: openWindow,
		openSite: openDefault,
	}
	ln, err := net.Listen("tcp", host)
	if err != nil {
		// Started again while it's running (a second double-click): it opens another window, and this leaves it be.
		if alreadyRunning(s.origin) {
			fmt.Printf("Slynk is already running at %s/, so this opens another window.\n", s.origin)
			if *open && !askToOpen(s.origin) {
				openSlynk(s.origin+"/", nil)
			}
			return
		}
		fail("Slynk can't start, because another program is using %s, the address Slynk needs. Close that program, then open Slynk again.", host)
	}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		<-stopped
		shutdown()
	}()
	if *stay {
		fmt.Printf("Slynk is running at %s/\nCtrl+C stops it.\n", s.origin)
	} else {
		fmt.Printf("Slynk is running at %s/\nIt stops when you close its window. Ctrl+C here stops it too.\n", s.origin)
		s.life = newLifetime(10*time.Second, 30*time.Minute, shutdown)
	}
	if *open {
		addShortcut()
		ended := func() {}
		if s.life != nil {
			ended = s.life.bye
		}
		openSlynk(s.origin+"/", ended)
	}
	srv := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, ErrorLog: log.New(io.Discard, "", 0)}
	fail("Slynk stopped unexpectedly: %v", srv.Serve(ln))
}

// shutdown closes the browser this program started for Slynk's window, if
// it's still running (on a Mac it keeps running once its window is closed),
// and ends the program.
func shutdown() {
	closeBrowser()
	os.Exit(0)
}

type server struct {
	files   fs.FS
	host    string // 127.0.0.1:<port>
	origin  string // http://127.0.0.1:<port>
	headers [][2]string
	// What opens windows for the page (/api/open): a Slynk window, another site's page.
	openPage, openSite func(string)
	// When to stop, from the pages open (lifetime.go); nil to run until stopped.
	life *lifetime
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only requests addressed to this exact host and port: a web page that
	// points another name at 127.0.0.1 (DNS rebinding) gets nothing.
	if r.Host != s.host {
		// Someone who typed localhost: send the page to the one address whose
		// storage holds their Slynk (the # after it goes along).
		if r.Host == "localhost"+s.host[strings.LastIndex(s.host, ":"):] && r.Method == http.MethodGet {
			http.Redirect(w, r, s.origin+r.URL.RequestURI(), http.StatusTemporaryRedirect)
			return
		}
		http.Error(w, "Misdirected request", http.StatusMisdirectedRequest)
		return
	}
	for _, kv := range s.headers {
		w.Header().Set(kv[0], kv[1])
	}
	switch r.URL.Path {
	case "/api/open":
		s.openRequest(w, r)
		return
	case "/api/alive":
		s.alive(w, r)
		return
	case "/api/bye":
		s.byeRequest(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.file(w, r)
}

// Built assets carry a content hash in their names, so they can be kept
// forever (as .htaccess says); everything else is checked every time.
var hashed = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.(js|css|wasm)(\.br|\.gz)?$`)

var types = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".wasm": "application/wasm",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".json": "application/json",
	".txt":  "text/plain; charset=utf-8",
}

func (s *server) file(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	// Never .htaccess, a .git folder or any other hidden file.
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			s.notFound(w, r)
			return
		}
	}
	if name == "" {
		name = "index.html"
	} else if st, err := fs.Stat(s.files, name); err == nil && st.IsDir() {
		if !strings.HasSuffix(r.URL.Path, "/") {
			http.Redirect(w, r, "/"+name+"/", http.StatusMovedPermanently)
			return
		}
		name += "/index.html"
	}
	if strings.HasSuffix(name, ".wasm") {
		s.wasm(w, r, name)
		return
	}
	data, err := fs.ReadFile(s.files, name)
	if err != nil {
		s.notFound(w, r)
		return
	}
	s.send(w, r, name, data, http.StatusOK)
}

// wasm serves the compressed copy the browser accepts, as .htaccess does
// (the build keeps no raw .wasm). Chromium offers brotli to
// http://127.0.0.1 too; a browser that offers it only over https gets the
// gzip copy.
func (s *server) wasm(w http.ResponseWriter, r *http.Request, name string) {
	accepts := r.Header.Get("Accept-Encoding")
	w.Header().Add("Vary", "Accept-Encoding")
	for _, enc := range []struct{ token, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !acceptsEncoding(accepts, enc.token) {
			continue
		}
		if data, err := fs.ReadFile(s.files, name+enc.ext); err == nil {
			w.Header().Set("Content-Encoding", enc.token)
			s.send(w, r, name+enc.ext, data, http.StatusOK)
			return
		}
	}
	if data, err := fs.ReadFile(s.files, name); err == nil {
		s.send(w, r, name, data, http.StatusOK)
		return
	}
	// A browser that accepts neither: unpack the gzip copy here.
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", types[".wasm"])
		return
	}
	gz, err := fs.ReadFile(s.files, name+".gz")
	if err != nil {
		s.notFound(w, r)
		return
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		s.notFound(w, r)
		return
	}
	data, err := io.ReadAll(zr)
	if err != nil {
		s.notFound(w, r)
		return
	}
	s.send(w, r, name, data, http.StatusOK)
}

// acceptsEncoding reports whether an Accept-Encoding header takes token,
// named or by "*", with a weight above zero.
func acceptsEncoding(header, token string) bool {
	star := false
	for _, part := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		coding = strings.TrimSpace(coding)
		ok := true
		for _, p := range strings.Split(params, ";") {
			k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
			if strings.EqualFold(k, "q") {
				q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				ok = err == nil && q > 0
			}
		}
		switch {
		case strings.EqualFold(coding, token):
			return ok
		case coding == "*":
			star = ok
		}
	}
	return star
}

func (s *server) notFound(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(s.files, "404.html")
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	s.send(w, r, "404.html", data, http.StatusNotFound)
}

func (s *server) send(w http.ResponseWriter, r *http.Request, name string, data []byte, code int) {
	h := w.Header()
	ext := path.Ext(strings.TrimSuffix(strings.TrimSuffix(name, ".gz"), ".br"))
	if t, ok := types[ext]; ok {
		h.Set("Content-Type", t)
	} else {
		h.Set("Content-Type", "application/octet-stream")
	}
	if hashed.MatchString(name) {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	if code == http.StatusOK {
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
		return
	}
	w.WriteHeader(code)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

// securityHeaders reads the "Header always set" lines of the site's
// .htaccess, as web/vite.config.ts does for `vite preview`. HSTS is left out:
// browsers ignore it over plain http.
func securityHeaders(files fs.FS) ([][2]string, error) {
	if files == nil {
		return nil, errors.New("no site folder")
	}
	f, err := files.Open(".htaccess")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	line := regexp.MustCompile(`^Header always set ([\w-]+) "([^"]+)"$`)
	var out [][2]string
	csp := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		m := line.FindStringSubmatch(sc.Text())
		if m == nil || m[1] == "Strict-Transport-Security" {
			continue
		}
		csp = csp || m[1] == "Content-Security-Policy"
		out = append(out, [2]string{m[1], m[2]})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !csp {
		return nil, errors.New("no Content-Security-Policy line")
	}
	return out, nil
}

// openRequest opens a window for the page (ui/localLinks.ts): one of Slynk's
// own pages in a second Slynk window, or another site's in the person's own
// browser. Only for this program's own page: browsers send Origin with every
// POST, and no other site can send this one, so no website can use it to open
// windows. Web addresses only, nothing else the system might open.
func (s *server) openRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("Origin") != s.origin {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil || len(body) > 8192 {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(strings.TrimSpace(string(body)))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.Opaque != "" {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if u.Scheme+"://"+u.Host == s.origin {
		s.openPage(u.String())
	} else {
		s.openSite(u.String())
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// askToOpen asks the Slynk already running at origin to open another window,
// as its page would (/api/open).
func askToOpen(origin string) bool {
	req, err := http.NewRequest(http.MethodPost, origin+"/api/open", strings.NewReader(origin+"/"))
	if err != nil {
		return false
	}
	req.Header.Set("Origin", origin)
	res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusNoContent
}

// alreadyRunning reports whether Slynk answers at origin: its page, with its
// security headers.
func alreadyRunning(origin string) bool {
	c := &http.Client{Timeout: 3 * time.Second}
	res, err := c.Get(origin + "/")
	if err != nil {
		return false
	}
	defer res.Body.Close()
	page, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode == http.StatusOK && res.Header.Get("Content-Security-Policy") != "" &&
		strings.Contains(string(page), "<title>Slynk</title>")
}

// fail says what went wrong, in the terminal or, without one, in a message
// box, and ends the program.
func fail(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, msg)
	if !inTerminal() {
		alert(msg)
	}
	os.Exit(1)
}
