package transfer

import (
	"crypto/ed25519"
	"sync"
	"time"

	"gitlab.com/elixxir/client/v4/channels"
	ft "gitlab.com/elixxir/client/v4/channelsFileTransfer"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	cryptoBroadcast "gitlab.com/elixxir/crypto/broadcast"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/elixxir/crypto/message"
	"gitlab.com/xx_network/primitives/id"
)

// memModel is a minimal in-memory channelsFileTransfer.EventModel. Only the
// file methods do anything. The channels methods are never called, because
// no channels manager exists.
type memModel struct {
	mu      sync.Mutex
	files   map[ftCrypto.ID]ft.ModelFile
	changed chan struct{}
}

func newMemModel() *memModel {
	return &memModel{files: map[ftCrypto.ID]ft.ModelFile{}, changed: make(chan struct{}, 1)}
}

// wait blocks until the file reaches Complete, then returns it and drops it
// from memory. It fails if xxDK marks the transfer as errored, the timeout
// passes, or stop is closed (a nil stop never is).
func (m *memModel) wait(fid ftCrypto.ID, timeout time.Duration, stop <-chan struct{}) (ft.ModelFile, error) {
	deadline := time.After(timeout)
	for {
		m.mu.Lock()
		f, ok := m.files[fid]
		if ok && f.Status == ft.Complete {
			delete(m.files, fid)
		}
		m.mu.Unlock()
		switch {
		case ok && f.Status == ft.Complete:
			return f, nil
		case ok && f.Status == ft.Error:
			return ft.ModelFile{}, errTransferFailed
		}
		select {
		case <-m.changed:
		case <-time.After(time.Second):
		case <-deadline:
			return ft.ModelFile{}, errTransferTimeout
		case <-stop:
			return ft.ModelFile{}, errStopped
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
