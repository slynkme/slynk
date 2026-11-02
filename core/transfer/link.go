package transfer

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"time"

	"github.com/pkg/errors"
	ft "gitlab.com/elixxir/client/v4/channelsFileTransfer"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/primitives/id"
)

// A Slynk link is a packed channelsFileTransfer.FileLink: everything a
// recipient needs to fetch and decrypt a transfer, and nothing else. It is
// carried in the URL fragment, which browsers never send to servers.
//
//	version(1) fileID(32) recipientID(33) sentUnixNano(8) key(32) mac(32)
//	size(4) numParts(2) retry(4)
const (
	linkVersion1 = 1
	macLen       = 32
	linkLen      = 1 + ftCrypto.IdLen + id.ArrIDLen + 8 + ftCrypto.TransferKeyLength + macLen + 4 + 2 + 4
)

// packLink converts xxDK's JSON FileLink into the compact binary form.
func packLink(fileLinkJSON []byte) ([]byte, error) {
	var fl ft.FileLink
	if err := json.Unmarshal(fileLinkJSON, &fl); err != nil {
		return nil, errors.Wrap(err, "parse file link")
	}
	if fl.RecipientID == nil || len(fl.Mac) != macLen {
		return nil, errors.New("file link is incomplete")
	}
	b := make([]byte, 0, linkLen)
	b = append(b, linkVersion1)
	b = append(b, fl.FileID[:]...)
	b = append(b, fl.RecipientID[:]...)
	b = binary.BigEndian.AppendUint64(b, uint64(fl.SentTimestamp.UnixNano()))
	b = append(b, fl.Key[:]...)
	b = append(b, fl.Mac...)
	b = binary.BigEndian.AppendUint32(b, fl.Size)
	b = binary.BigEndian.AppendUint16(b, fl.NumParts)
	b = binary.BigEndian.AppendUint32(b, math.Float32bits(fl.Retry))
	return b, nil
}

// PackFileLinkJSON turns xxDK's JSON FileLink into a Slynk link. It's for
// tools working with links recorded by the lab experiments.
func PackFileLinkJSON(fileLinkJSON []byte) ([]byte, error) {
	return packLink(fileLinkJSON)
}

// unpackLink converts a compact link back into xxDK's FileInfo JSON, which
// is what channelsFileTransfer.Wrapper.Download expects.
func unpackLink(b []byte) ([]byte, *ft.FileLink, error) {
	if len(b) != linkLen || b[0] != linkVersion1 {
		return nil, nil, errors.New("not a valid Slynk link")
	}
	var fl ft.FileLink
	p := b[1:]
	copy(fl.FileID[:], p[:ftCrypto.IdLen])
	p = p[ftCrypto.IdLen:]
	var rid id.ID
	copy(rid[:], p[:id.ArrIDLen])
	fl.RecipientID = &rid
	p = p[id.ArrIDLen:]
	fl.SentTimestamp = time.Unix(0, int64(binary.BigEndian.Uint64(p)))
	p = p[8:]
	copy(fl.Key[:], p[:ftCrypto.TransferKeyLength])
	p = p[ftCrypto.TransferKeyLength:]
	fl.Mac = append([]byte(nil), p[:macLen]...)
	p = p[macLen:]
	fl.Size = binary.BigEndian.Uint32(p)
	fl.NumParts = binary.BigEndian.Uint16(p[4:])
	fl.Retry = math.Float32frombits(binary.BigEndian.Uint32(p[6:]))

	info, err := json.Marshal(ft.FileInfo{FileLink: fl})
	if err != nil {
		return nil, nil, err
	}
	return info, &fl, nil
}
