// Package transfer is Slynk's core: it joins the xx network as a brand-new,
// in-memory identity and moves bytes through the cMix mixnet using xxDK's
// channels file transfer, addressed to a random single-use recipient. The
// result is a self-contained link, so sender and recipient never need to be
// online at the same time.
package transfer

import (
	"crypto/hmac"
	"crypto/rand"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"
	ft "gitlab.com/elixxir/client/v4/channelsFileTransfer"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/e2e"
	"gitlab.com/elixxir/client/v4/storage"
	"gitlab.com/elixxir/client/v4/xxdk"
	cryptoChannel "gitlab.com/elixxir/crypto/channel"
	"gitlab.com/elixxir/crypto/fastRNG"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
)

const (
	// readyFraction of nodes must be registered before sending; sends issued
	// earlier routinely fail.
	readyFraction = 0.85
	// connectTimeout caps a whole join, fresh starts included.
	connectTimeout = 5 * time.Minute
	// A join usually takes 12-27 s. One that registers with no new node for
	// joinStall, or isn't ready joinAttempt after it began registering,
	// starts again with a fresh identity, up to joinRestarts times (a
	// join once sat at 19% for minutes). Each fresh
	// start is a new identity from the registrar's daily allowance.
	joinStall    = 30 * time.Second
	joinAttempt  = 90 * time.Second
	joinRestarts = 3

	// uploadRetry is the resend allowance per part (a retry of 5 with 10
	// parts allows 60 send attempts in total).
	uploadRetry      = 5
	transferTimeout  = 45 * time.Minute
	progressInterval = time.Second

	// sendTimeout is how long one batch of file parts may take to reach its
	// round's gateway, nearly always through a proxy gateway (xxDK's default
	// is 500 ms). At 500 ms, batches that had in fact landed were reported
	// as failed and sent again. The round's start still caps each call.
	sendTimeout = 2 * time.Second

	// storageDir only namespaces keys inside the in-memory store.
	storageDir = "slynk"
)

var (
	errTransferFailed  = errors.New("the network reported the transfer as failed")
	errTransferTimeout = errors.New("the transfer took too long and was abandoned")
	errStopped         = errors.New("stopped") // a wait's stop closed: Upload and Download say which
	ErrLinkExpired     = errors.New("this link has expired: the network no longer holds the file")
	// ErrDownloadStopped means StopDownload ended a download early.
	ErrDownloadStopped = errors.New("the download was stopped before every piece arrived")
	// ErrUploadStopped means UploadStoppable's stop closed before it finished.
	ErrUploadStopped = errors.New("the upload was stopped before every piece was sent")
	// ErrConnectStopped means ConnectStoppable's stop closed before it joined.
	ErrConnectStopped = errors.New("joining the mixnet was stopped")
	// ErrConnectStalled means every fresh start of a join stalled too.
	ErrConnectStalled = errors.New("couldn't join the mixnet: it stopped making progress, even with fresh identities")
	errJoinStalled    = errors.New("joining the mixnet stalled")
)

// Progress reports a step of an operation: done of total, when known.
type Progress func(stage string, done, total int)

// Client is one connected, in-memory xx network identity.
type Client struct {
	net   *xxdk.Cmix
	ft    *ft.Wrapper
	model *memModel

	mu   sync.Mutex
	stop chan struct{} // closed by StopDownload; one per running download

	cover      coverer
	lastActive atomic.Int64 // unix nanoseconds of the last send or receive

	// streamNet and streamRng stand in for the network that notices and cover
	// messages go through, in tests (network); nil means net's.
	streamNet streamSender
	streamRng *fastRNG.StreamGenerator
}

// network is what notices and cover messages go through: xxDK's, or a test's
// stand-in.
func (c *Client) network() (streamSender, *fastRNG.StreamGenerator) {
	if c.streamNet != nil {
		return c.streamNet, c.streamRng
	}
	return c.net.GetCmix(), c.net.GetRng()
}

// SetVerbose switches xxDK's detailed logging (to stdout/console) on or off.
func SetVerbose(verbose bool) {
	if verbose {
		jww.SetStdoutThreshold(jww.LevelInfo)
	} else {
		jww.SetStdoutThreshold(jww.LevelError)
	}
}

// Connect creates a brand-new identity, joins mainnet, and waits until it
// is registered with enough nodes to send and receive.
func Connect(progress Progress) (*Client, error) {
	return ConnectStoppable(progress, nil)
}

// ConnectStoppable is Connect, given up (its network follower stopped) as
// soon as stop closes, so a join that's stuck can start again with a fresh
// identity without waiting out connectTimeout. A nil stop never closes.
//
// A join that stalls starts again by itself with a fresh identity, up to
// joinRestarts times, reported as the stage "restart" (done: which fresh
// start, of total). If they all stall, it gives up with ErrConnectStalled.
func ConnectStoppable(progress Progress, stop <-chan struct{}) (*Client, error) {
	return retryJoin(progress, stop, time.Now().Add(connectTimeout), joinOnce)
}

// retryJoin runs once until it joins, fails some other way, or has stalled
// joinRestarts+1 times.
func retryJoin(progress Progress, stop <-chan struct{}, deadline time.Time, once func(Progress, <-chan struct{}, time.Time) (*Client, error)) (*Client, error) {
	for attempt := 0; ; attempt++ {
		if attempt > 0 {
			progress("restart", attempt, joinRestarts)
		}
		c, err := once(progress, stop, deadline)
		if !errors.Is(err, errJoinStalled) {
			return c, err
		}
		if attempt == joinRestarts {
			return nil, ErrConnectStalled
		}
	}
}

// joinOnce joins with a brand-new identity, or reports errJoinStalled.
func joinOnce(progress Progress, stop <-chan struct{}, deadline time.Time) (*Client, error) {
	stopped := func() bool {
		select {
		case <-stop:
			return true
		default:
			return false
		}
	}
	if stopped() {
		return nil, ErrConnectStopped
	}
	progress("network", 0, 0)
	ndfJSON, err := xxdk.DownloadAndVerifySignedNdfWithUrl(mainnetNdfURL, mainnetNdfCert)
	if err != nil {
		return nil, errors.Wrap(err, "download network definition")
	}

	if stopped() {
		return nil, ErrConnectStopped
	}
	progress("identity", 0, 0)
	password := make([]byte, 32)
	if _, err = rand.Read(password); err != nil {
		return nil, err
	}
	kv := newMemKV()
	if err = xxdk.NewCmixWithKV(kv, string(ndfJSON), storageDir, password, ""); err != nil {
		return nil, errors.Wrap(err, "create identity")
	}
	net, err := xxdk.LoadCmixWithKV(kv, storageDir, password, xxdk.GetDefaultCMixParams())
	if err != nil {
		return nil, errors.Wrap(err, "load client")
	}

	c := &Client{net: net, model: newMemModel()}
	c.touch()
	if err = c.startFileTransfer(); err != nil {
		return nil, err
	}
	if err = net.StartNetworkFollower(30 * time.Second); err != nil {
		return nil, errors.Wrap(err, "start network follower")
	}

	w := joinWait{
		status: func() (int, int, bool) {
			registered, total, _ := net.GetNodeRegistrationStatus()
			ready, _ := net.IsReady(readyFraction)
			return registered, total, ready && net.GetCmix().IsHealthy()
		},
		now:   time.Now,
		sleep: time.Sleep,
	}
	if err = w.run(progress, stop, deadline); err != nil {
		_ = net.StopNetworkFollower()
		return nil, err
	}
	return c, nil
}

// joinWait waits for a join to be ready: its status, and the clock (a test's own).
type joinWait struct {
	status func() (registered, total int, ready bool)
	now    func() time.Time
	sleep  func(time.Duration)
}

// run reports the join's progress until it's ready. errJoinStalled: no new
// node registered for joinStall, or not ready joinAttempt after it began.
func (w joinWait) run(progress Progress, stop <-chan struct{}, deadline time.Time) error {
	start := w.now()
	best, moved := -1, start
	for {
		registered, total, ready := w.status()
		progress("nodes", registered, total)
		if ready {
			progress("ready", registered, total)
			return nil
		}
		now := w.now()
		if registered > best {
			best, moved = registered, now
		}
		if now.After(deadline) {
			return errors.New("couldn't register with enough mixnet nodes in time")
		}
		if now.Sub(moved) > joinStall || now.Sub(start) > joinAttempt {
			return errJoinStalled
		}
		select {
		case <-stop:
			return ErrConnectStopped
		default:
		}
		w.sleep(500 * time.Millisecond)
	}
}

// startFileTransfer wires up the file transfer manager with the in-memory
// event model. The extension builder normally runs inside a channels
// manager; calling it ourselves hands the wrapper our event model. The
// channels manager it would also receive is only used by Send, which Slynk
// never calls.
func (c *Client) startFileTransfer() error {
	rid, err := xxdk.MakeReceptionIdentity(c.net)
	if err != nil {
		return errors.Wrap(err, "reception identity")
	}
	params := ft.DefaultParams()
	params.SendTimeout = sendTimeout
	w, extensionBuilder, err := ft.NewWrapper(&ftUser{net: c.net, rid: rid}, params)
	if err != nil {
		return errors.Wrap(err, "file transfer manager")
	}
	stream := c.net.GetRng().GetStream()
	chanIdentity, err := cryptoChannel.GenerateIdentity(stream)
	stream.Close()
	if err != nil {
		return err
	}
	if _, err = extensionBuilder(c.model, nil, chanIdentity); err != nil {
		return errors.Wrap(err, "attach event model")
	}
	// Uploads confirm their parts by round results rather than reading them
	// back, so the uploader never polls its link's pickup address (see
	// SetConfirmByRound).
	w.SetConfirmByRound(true)
	c.ft = w
	return c.net.AddService(w.StartProcesses)
}

// SetVariedBatches chooses how full later uploads' batches are. By default a
// mixnet round carries 9 to 11 parts of an upload; varied batches carry 1 to
// 11 at random, so each round holds fewer of them and an upload takes nearly
// twice as long.
func (c *Client) SetVariedBatches(varied bool) {
	if varied {
		c.ft.SetMinPartsPerSend(1)
		return
	}
	c.ft.SetMinPartsPerSend(ft.DefaultMinPartsPerSend)
}

// SetConfirmByRound chooses how later uploads confirm their parts. On (the
// default since 2026-10-14), a part counts once the round carrying it reports
// Succeeded, and the uploader never polls the recipient. Off, the uploader
// downloads each part back, which means polling the upload's recipient ID
// from its own IP address, as every downloader later does too. That removes only
// the uploader's own poll: gateways still see each round's senders and
// recipients, so a multi-round upload can be matched to its recipient. It is
// also best-effort, because a Succeeded round doesn't prove every message in
// it was stored, and nothing re-sends a part lost after that.
func (c *Client) SetConfirmByRound(on bool) {
	c.ft.SetConfirmByRound(on)
}

// Upload sends data into the mixnet and returns its compact link once every
// part's round has reported it delivered.
func (c *Client) Upload(data []byte, progress Progress) ([]byte, error) {
	return c.UploadStoppable(data, progress, nil)
}

// UploadStoppable is Upload, given up as soon as stop closes: the parts still
// to go are dropped (our xxDK fork's CancelUpload) and it returns
// ErrUploadStopped. Parts already sent stay on the network until it lets
// them go, unreadable without the link, which nobody gets. The identity
// carries on. A nil stop never closes.
func (c *Client) UploadStoppable(data []byte, progress Progress, stop <-chan struct{}) ([]byte, error) {
	c.touch()
	defer c.touch()
	if len(data) > c.ft.MaxFileSize() {
		return nil, errors.Errorf("too large: %d bytes (max %d)", len(data), c.ft.MaxFileSize())
	}
	select {
	case <-stop:
		return nil, ErrUploadStopped
	default:
	}
	fid, err := c.ft.Upload(data, uploadRetry,
		func(_ bool, _, received, total uint16, _ ft.SentTransfer, _ ft.FilePartTracker, err error) {
			if err == nil {
				progress("upload", int(received), int(total))
			}
		}, progressInterval)
	if err != nil {
		return nil, errors.Wrap(err, "start upload")
	}
	f, err := c.model.wait(fid, transferTimeout, stop)
	if err == errStopped {
		if err := c.ft.CancelUpload(fid); err != nil {
			jww.WARN.Printf("[Slynk] Cancelling upload %s: %+v", fid, err)
		}
		_ = c.model.DeleteFile(fid)
		return nil, ErrUploadStopped
	}
	if err != nil {
		return nil, err
	}
	return packLink(f.Link)
}

// Download fetches and verifies the data a link points to. If no new part
// arrives for a while, it reports the stage "stalled" (done of total) and
// keeps waiting; StopDownload ends it early with ErrDownloadStopped.
func (c *Client) Download(link []byte, progress Progress) ([]byte, error) {
	c.touch()
	defer c.touch()
	info, fl, err := unpackLink(link)
	if err != nil {
		return nil, err
	}
	if fl.Expired() {
		return nil, ErrLinkExpired
	}

	stop := make(chan struct{})
	c.mu.Lock()
	c.stop = stop
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.stop == stop {
			c.stop = nil
		}
		c.mu.Unlock()
	}()

	watch := newStallWatch(time.Now(), fl.SentTimestamp, int(fl.NumParts))
	fid, err := c.ft.Download(info,
		func(_ bool, received, total uint16, _ ft.ReceivedTransfer, _ ft.FilePartTracker, err error) {
			if err == nil {
				watch.seen(int(received), int(total), time.Now())
				progress("download", int(received), int(total))
			}
		}, progressInterval)
	if err != nil {
		return nil, errors.Wrap(err, "start download")
	}

	done := make(chan struct{})
	defer close(done)
	go func() {
		tick := time.NewTicker(stallCheckEvery)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case now := <-tick.C:
				if got, total, stalled := watch.check(now); stalled {
					progress("stalled", got, total)
				}
			}
		}
	}()

	f, err := c.model.wait(fid, transferTimeout, stop)
	if err == errStopped {
		err = ErrDownloadStopped
	}
	if err == ErrDownloadStopped || err == errTransferTimeout {
		// Stop looking for its parts, so trying again starts afresh.
		_ = c.ft.CloseReceive(fid)
		_ = c.model.DeleteFile(fid)
	}
	if err != nil {
		return nil, err
	}
	// xxDK authenticates every part; also check the reassembled whole against
	// the MAC carried in the link before handing anything over.
	if !hmac.Equal(ftCrypto.CreateTransferMAC(f.Data, fl.Key), fl.Mac) {
		return nil, errors.New("the file failed its integrity check and was discarded")
	}
	return f.Data, nil
}

// StopDownload ends the download in progress, if any: Download returns
// ErrDownloadStopped and stops looking for the link's parts. Slynk runs one
// download at a time; with several, this stops the latest.
func (c *Client) StopDownload() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stop != nil {
		close(c.stop)
		c.stop = nil
	}
}

// Status reports how many mixnet nodes this identity is registered with
// (registration continues in the background after Connect returns) and
// whether its connection to the network is currently healthy.
func (c *Client) Status() (registered, total int, healthy bool) {
	registered, total, _ = c.net.GetNodeRegistrationStatus()
	return registered, total, c.net.GetCmix().IsHealthy()
}

// Close leaves the network. The identity, which only ever existed in
// memory, is gone for good.
func (c *Client) Close() error {
	c.SetCover(false)
	return c.net.StopNetworkFollower()
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
