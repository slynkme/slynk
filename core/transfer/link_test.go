package transfer

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	ft "gitlab.com/elixxir/client/v4/channelsFileTransfer"
)

var labLinks = []string{
	"../../lab/mixnet-smoketest/testdata/link-250k-uploaded-2026-10-13T1733Z.json",
	"../../lab/mixnet-smoketest/testdata/link-1m-uploaded-2026-10-13T1737Z.json",
}

// Real FileLinks recorded on mainnet must survive packing into a Slynk link
// and back without losing anything Download needs.
func TestLinkRoundTrip(t *testing.T) {
	for _, path := range labLinks {
		t.Run(path, func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var lf struct {
				FileLink json.RawMessage `json:"fileLink"`
			}
			if err = json.Unmarshal(raw, &lf); err != nil {
				t.Fatal(err)
			}
			var want ft.FileLink
			if err = json.Unmarshal(lf.FileLink, &want); err != nil {
				t.Fatal(err)
			}

			link, err := PackFileLinkJSON(lf.FileLink)
			if err != nil {
				t.Fatal(err)
			}
			if len(link) != linkLen {
				t.Fatalf("link is %d bytes, want %d", len(link), linkLen)
			}

			info, got, err := unpackLink(link)
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case got.FileID != want.FileID:
				t.Error("file ID changed")
			case !got.RecipientID.Cmp(want.RecipientID):
				t.Error("recipient ID changed")
			case !got.SentTimestamp.Equal(want.SentTimestamp):
				t.Errorf("sent time changed: %v vs %v", got.SentTimestamp, want.SentTimestamp)
			case got.Key != want.Key:
				t.Error("key changed")
			case !bytes.Equal(got.Mac, want.Mac):
				t.Error("MAC changed")
			case got.Size != want.Size || got.NumParts != want.NumParts || got.Retry != want.Retry:
				t.Error("size, parts or retry changed")
			}

			// Download consumes FileInfo JSON with the FileLink embedded.
			var fi ft.FileInfo
			if err = json.Unmarshal(info, &fi); err != nil {
				t.Fatal(err)
			}
			if fi.FileID != want.FileID || fi.NumParts != want.NumParts {
				t.Error("FileInfo JSON doesn't carry the link")
			}
		})
	}
}

func TestUnpackRejectsBadLinks(t *testing.T) {
	good := make([]byte, linkLen)
	good[0] = linkVersion1
	for name, b := range map[string][]byte{
		"empty":         nil,
		"short":         good[:linkLen-1],
		"long":          append(append([]byte(nil), good...), 0),
		"wrong version": append([]byte{9}, good[1:]...),
	} {
		if _, _, err := unpackLink(b); err == nil {
			t.Errorf("%s link was accepted", name)
		}
	}
}
