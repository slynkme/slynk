// Command smoketest checks the core Slynk idea against the live xx network:
// a brand-new client uploads a file into the cMix mixnet, and a second,
// unrelated client later downloads it using nothing but the file link.
//
// It drives xxDK's channelsFileTransfer module directly, with a tiny
// in-memory event model, so no channels/chat/E2E machinery is involved.
//
//	smoketest upload   -state DIR -size 250000 -link link.json
//	smoketest download -state DIR -link link.json -out file.bin
//
// Each run must use a fresh (or its own) -state directory: that directory is
// the client's xx identity.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/channels"
	ft "gitlab.com/elixxir/client/v4/channelsFileTransfer"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/client/v4/e2e"
	"gitlab.com/elixxir/client/v4/storage"
	"gitlab.com/elixxir/client/v4/xxdk"
	cryptoBroadcast "gitlab.com/elixxir/crypto/broadcast"
	cryptoChannel "gitlab.com/elixxir/crypto/channel"
	"gitlab.com/elixxir/crypto/fastRNG"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/elixxir/crypto/message"
	"gitlab.com/xx_network/primitives/id"
)

var start = time.Now()

func logf(format string, a ...any) {
	fmt.Printf("[%7.1fs] %s\n", time.Since(start).Seconds(), fmt.Sprintf(format, a...))
}

func fatalf(format string, a ...any) {
	logf("FAILED: "+format, a...)
	os.Exit(1)
}

// linkFile is what the uploader hands to the downloader. In Slynk this would
// be packed into the URL fragment; here it is a JSON file plus test metadata.
type linkFile struct {
	FileLink json.RawMessage `json:"fileLink"`
	SHA256   string          `json:"sha256"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: smoketest upload|download [flags]")
		os.Exit(2)
	}
	mode := os.Args[1]
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	stateDir := fs.String("state", "", "fresh directory for this client's state (its xx identity)")
	size := fs.Int("size", 250_000, "upload: bytes of random test data")
	retry := fs.Float64("retry", 5, "upload: resend allowance per part")
	linkPath := fs.String("link", "link.json", "file link to write (upload) or read (download)")
	outPath := fs.String("out", "downloaded.bin", "download: where to write the file")
	readyPct := fs.Float64("ready", 0.85, "fraction of nodes to register with before transferring")
	_ = fs.Parse(os.Args[2:])
	if *stateDir == "" {
		fatalf("-state is required")
	}

	// Detailed xxDK logs go to a file next to the state; the console only shows
	// this program's progress lines.
	if err := os.MkdirAll(filepath.Dir(*stateDir), 0o700); err != nil {
		fatalf("%v", err)
	}
	logFile, err := os.Create(*stateDir + ".log")
	if err != nil {
		fatalf("%v", err)
	}
	jww.SetLogOutput(logFile)
	jww.SetLogThreshold(jww.LevelInfo)
	jww.SetStdoutThreshold(jww.LevelFatal)

	net := connect(*stateDir, *readyPct)
	w, model := startFileTransfer(net)

	switch mode {
	case "upload":
		upload(w, model, *size, float32(*retry), *linkPath)
	case "download":
		download(w, model, *linkPath, *outPath)
	default:
		fatalf("unknown mode %q", mode)
	}

	if err := net.StopNetworkFollower(); err != nil {
		logf("warning: stopping network follower: %v", err)
	}
	logf("done")
}

// connect creates a brand-new xx identity in stateDir, joins mainnet and waits
// until enough nodes are registered to send and receive.
func connect(stateDir string, readyPct float64) *xxdk.Cmix {
	ndfJSON, err := xxdk.DownloadAndVerifySignedNdfWithUrl(mainnetNdfURL, mainnetNdfCert)
	if err != nil {
		fatalf("download NDF: %v", err)
	}
	logf("network definition downloaded and signature verified (%d bytes)", len(ndfJSON))

	password := make([]byte, 32)
	if _, err = rand.Read(password); err != nil {
		fatalf("%v", err)
	}
	if err = xxdk.NewCmix(string(ndfJSON), stateDir, password, ""); err != nil {
		fatalf("create identity: %v", err)
	}
	logf("new identity created and registered with the client registrar")

	net, err := xxdk.LoadCmix(stateDir, password, xxdk.GetDefaultCMixParams())
	if err != nil {
		fatalf("load client: %v", err)
	}
	return net
}

// startFileTransfer wires up the file transfer manager with an in-memory event
// model and starts the network follower, then waits for readiness.
func startFileTransfer(net *xxdk.Cmix) (*ft.Wrapper, *memModel) {
	rid, err := xxdk.MakeReceptionIdentity(net)
	if err != nil {
		fatalf("reception identity: %v", err)
	}
	// The same 2 s send timeout as core/transfer (sendTimeout), so the two
	// harnesses stay comparable.
	params := ft.DefaultParams()
	params.SendTimeout = 2 * time.Second
	w, extensionBuilder, err := ft.NewWrapper(&ftUser{net: net, rid: rid}, params)
	if err != nil {
		fatalf("file transfer manager: %v", err)
	}

	// The extension builder normally runs inside a channels manager. Calling it
	// ourselves hands the wrapper our event model; the channels manager it
	// would also receive is only used by Send, which we never call.
	model := newMemModel()
	stream := net.GetRng().GetStream()
	chanIdentity, err := cryptoChannel.GenerateIdentity(stream)
	stream.Close()
	if err != nil {
		fatalf("channel identity: %v", err)
	}
	if _, err = extensionBuilder(model, nil, chanIdentity); err != nil {
		fatalf("attach event model: %v", err)
	}
	if err = net.AddService(w.StartProcesses); err != nil {
		fatalf("add service: %v", err)
	}

	if err = net.StartNetworkFollower(30 * time.Second); err != nil {
		fatalf("start network follower: %v", err)
	}
	logf("network follower started; registering with nodes...")

	deadline := time.Now().Add(15 * time.Minute)
	lastReport := time.Time{}
	for {
		healthy := net.GetCmix().IsHealthy()
		ready, howClose := net.IsReady(0.85)
		if healthy && ready {
			registered, total, _ := net.GetNodeRegistrationStatus()
			logf("READY: healthy, registered with %d/%d nodes", registered, total)
			return w, model
		}
		if time.Since(lastReport) > 10*time.Second {
			registered, total, _ := net.GetNodeRegistrationStatus()
			logf("  waiting: healthy=%v, nodes registered %d/%d (%.0f%% of target)",
				healthy, registered, total, howClose*100)
			lastReport = time.Now()
		}
		if time.Now().After(deadline) {
			fatalf("network not ready after 15 minutes")
		}
		time.Sleep(time.Second)
	}
}

func upload(w *ft.Wrapper, model *memModel, size int, retry float32, linkPath string) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		fatalf("%v", err)
	}
	sum := sha256.Sum256(data)
	logf("uploading %d random bytes (sha256 %s…)", size, hex.EncodeToString(sum[:])[:16])

	t0 := time.Now()
	fid, err := w.Upload(data, retry,
		func(completed bool, sent, received, total uint16, _ ft.SentTransfer,
			_ ft.FilePartTracker, err error) {
			if err != nil {
				logf("  upload error: %v", err)
				return
			}
			logf("  upload: %d/%d parts sent, %d/%d confirmed back from the network",
				sent, total, received, total)
		}, 5*time.Second)
	if err != nil {
		fatalf("start upload: %v", err)
	}

	f := model.wait(fid, 60*time.Minute)
	elapsed := time.Since(t0)
	logf("UPLOAD COMPLETE in %s (%.2f KB/s)", elapsed.Round(time.Second),
		float64(size)/1000/elapsed.Seconds())

	// xxDK records the send time in the machine's local zone; store it in UTC
	// so link files never reveal where they were made.
	var fl ft.FileLink
	if err = json.Unmarshal(f.Link, &fl); err != nil {
		fatalf("parse link: %v", err)
	}
	fl.SentTimestamp = fl.SentTimestamp.UTC()
	utcLink, _ := json.Marshal(fl)
	lf := linkFile{FileLink: utcLink, SHA256: hex.EncodeToString(sum[:])}
	out, _ := json.MarshalIndent(lf, "", "  ")
	if err = os.WriteFile(linkPath, out, 0o600); err != nil {
		fatalf("write link: %v", err)
	}
	logf("file link written to %s (%d bytes as JSON, %d chars as base64url)",
		linkPath, len(f.Link), len(base64.RawURLEncoding.EncodeToString(f.Link)))
}

func download(w *ft.Wrapper, model *memModel, linkPath, outPath string) {
	raw, err := os.ReadFile(linkPath)
	if err != nil {
		fatalf("read link: %v", err)
	}
	var lf linkFile
	if err = json.Unmarshal(raw, &lf); err != nil {
		fatalf("parse link: %v", err)
	}

	// Download expects FileInfo JSON; FileLink's fields are embedded in it, so
	// a bare FileLink parses as a FileInfo with no name, type or preview.
	t0 := time.Now()
	fid, err := w.Download(lf.FileLink,
		func(completed bool, received, total uint16, _ ft.ReceivedTransfer,
			_ ft.FilePartTracker, err error) {
			if err != nil {
				logf("  download error: %v", err)
				return
			}
			logf("  download: %d/%d parts received", received, total)
		}, 5*time.Second)
	if err != nil {
		fatalf("start download: %v", err)
	}

	f := model.wait(fid, 60*time.Minute)
	elapsed := time.Since(t0)
	sum := sha256.Sum256(f.Data)
	match := hex.EncodeToString(sum[:]) == lf.SHA256
	logf("DOWNLOAD COMPLETE in %s (%.2f KB/s), %d bytes, sha256 matches upload: %v",
		elapsed.Round(time.Second), float64(len(f.Data))/1000/elapsed.Seconds(),
		len(f.Data), match)
	if err = os.WriteFile(outPath, f.Data, 0o600); err != nil {
		fatalf("write file: %v", err)
	}
	if !match {
		fatalf("downloaded data does not match the upload")
	}
}

// ftUser satisfies channelsFileTransfer.FtE2e. File transfer never uses E2E,
// so GetE2E returns nil.
type ftUser struct {
	net *xxdk.Cmix
	rid xxdk.ReceptionIdentity
}

func (u *ftUser) GetStorage() storage.Session                  { return u.net.GetStorage() }
func (u *ftUser) GetReceptionIdentity() xxdk.ReceptionIdentity { return u.rid }
func (u *ftUser) GetCmix() cmix.Client                         { return u.net.GetCmix() }
func (u *ftUser) GetRng() *fastRNG.StreamGenerator             { return u.net.GetRng() }
func (u *ftUser) GetE2E() e2e.Handler                          { return nil }

// memModel is a minimal in-memory channelsFileTransfer.EventModel. Only the
// file methods do anything; the channels methods are never called because no
// channels manager exists.
type memModel struct {
	mu      sync.Mutex
	files   map[ftCrypto.ID]ft.ModelFile
	changed chan struct{}
}

func newMemModel() *memModel {
	return &memModel{files: map[ftCrypto.ID]ft.ModelFile{}, changed: make(chan struct{}, 1)}
}

// wait blocks until the file reaches Complete (returning it) or Error.
func (m *memModel) wait(fid ftCrypto.ID, timeout time.Duration) ft.ModelFile {
	deadline := time.After(timeout)
	for {
		m.mu.Lock()
		f, ok := m.files[fid]
		m.mu.Unlock()
		if ok && f.Status == ft.Complete {
			return f
		}
		if ok && f.Status == ft.Error {
			fatalf("transfer marked as failed by xxDK (see the .log file)")
		}
		select {
		case <-m.changed:
		case <-time.After(time.Second):
		case <-deadline:
			fatalf("transfer did not finish within %s", timeout)
		}
	}
}

func (m *memModel) notify() {
	select {
	case m.changed <- struct{}{}:
	default:
	}
}

func (m *memModel) ReceiveFile(fid ftCrypto.ID, link, data []byte,
	ts time.Time, status ft.Status) error {
	m.mu.Lock()
	m.files[fid] = ft.ModelFile{ID: fid, Link: link, Data: data, Timestamp: ts, Status: status}
	m.mu.Unlock()
	m.notify()
	return nil
}

func (m *memModel) UpdateFile(fid ftCrypto.ID, link, data []byte,
	ts *time.Time, status *ft.Status) error {
	m.mu.Lock()
	f, ok := m.files[fid]
	if !ok {
		m.mu.Unlock()
		return channels.NoMessageErr
	}
	if link != nil {
		f.Link = link
	}
	if data != nil {
		f.Data = data
	}
	if ts != nil {
		f.Timestamp = *ts
	}
	if status != nil {
		f.Status = *status
	}
	m.files[fid] = f
	m.mu.Unlock()
	m.notify()
	return nil
}

func (m *memModel) GetFile(fid ftCrypto.ID) (ft.ModelFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f, ok := m.files[fid]
	if !ok {
		return ft.ModelFile{}, channels.NoMessageErr
	}
	return f, nil
}

func (m *memModel) DeleteFile(fid ftCrypto.ID) error {
	m.mu.Lock()
	delete(m.files, fid)
	m.mu.Unlock()
	return nil
}

func (m *memModel) JoinChannel(*cryptoBroadcast.Channel) {}
func (m *memModel) LeaveChannel(*id.ID)                  {}
func (m *memModel) ReceiveMessage(*id.ID, message.ID, string, string,
	ed25519.PublicKey, uint32, uint8, time.Time, time.Duration, rounds.Round,
	channels.MessageType, channels.SentStatus, bool) uint64 {
	return 0
}
func (m *memModel) ReceiveReply(*id.ID, message.ID, message.ID, string, string,
	ed25519.PublicKey, uint32, uint8, time.Time, time.Duration, rounds.Round,
	channels.MessageType, channels.SentStatus, bool) uint64 {
	return 0
}
func (m *memModel) ReceiveReaction(*id.ID, message.ID, message.ID, string,
	string, ed25519.PublicKey, uint32, uint8, time.Time, time.Duration,
	rounds.Round, channels.MessageType, channels.SentStatus, bool) uint64 {
	return 0
}
func (m *memModel) UpdateFromUUID(uint64, *message.ID, *time.Time,
	*rounds.Round, *bool, *bool, *channels.SentStatus) error {
	return nil
}
func (m *memModel) UpdateFromMessageID(message.ID, *time.Time, *rounds.Round,
	*bool, *bool, *channels.SentStatus) (uint64, error) {
	return 0, nil
}
func (m *memModel) GetMessage(message.ID) (channels.ModelMessage, error) {
	return channels.ModelMessage{}, channels.NoMessageErr
}
func (m *memModel) DeleteMessage(message.ID) error           { return nil }
func (m *memModel) MuteUser(*id.ID, ed25519.PublicKey, bool) {}
