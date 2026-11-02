package main

import (
	"bytes"
	"crypto/sha256"
	"debug/macho"
	"encoding/base64"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// buildApp makes a small Slynk.app for arch around a real Go program.
func buildApp(t *testing.T, arch string) string {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	must(t, os.WriteFile(filepath.Join(src, "go.mod"), []byte("module hello\n\ngo 1.26\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(src, "main.go"), []byte("package main\n\nfunc main() { println(\"hello\") }\n"), 0o644))
	app := filepath.Join(dir, "Slynk.app")
	contents := filepath.Join(app, "Contents")
	must(t, os.MkdirAll(filepath.Join(contents, "MacOS"), 0o755))
	must(t, os.MkdirAll(filepath.Join(contents, "Resources"), 0o755))
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags=-s -w", "-o", filepath.Join(contents, "MacOS", "slynk"), ".")
	cmd.Dir = src
	cmd.Env = append(os.Environ(), "GOOS=darwin", "GOARCH="+arch, "CGO_ENABLED=0", "GOFLAGS=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	plist, err := os.ReadFile("../mac/Info.plist")
	must(t, err)
	must(t, os.WriteFile(filepath.Join(contents, "Info.plist"), plist, 0o644))
	must(t, os.WriteFile(filepath.Join(contents, "Resources", "slynk.icns"), []byte("icon"), 0o644))
	return app
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// check verifies the signature as macOS would read it.
func check(t *testing.T, app string) {
	t.Helper()
	contents := filepath.Join(app, "Contents")
	data, err := os.ReadFile(filepath.Join(contents, "MacOS", "slynk"))
	must(t, err)
	info, _ := os.ReadFile(filepath.Join(contents, "Info.plist"))
	res, err := os.ReadFile(filepath.Join(contents, "_CodeSignature", "CodeResources"))
	must(t, err)
	icon := sha256.Sum256([]byte("icon"))
	if !strings.Contains(string(res), "<key>Resources/slynk.icns</key>") || !strings.Contains(string(res), b64(icon[:])) {
		t.Fatalf("CodeResources doesn't seal the icon:\n%s", res)
	}

	f, err := macho.NewFile(bytes.NewReader(data))
	must(t, err)
	var sigOff, sigSize uint32
	var linkedit, text *macho.Segment
	n := 0
	for _, l := range f.Loads {
		raw := l.Raw()
		if f.ByteOrder.Uint32(raw) == lcCodeSignature {
			sigOff, sigSize = f.ByteOrder.Uint32(raw[8:]), f.ByteOrder.Uint32(raw[12:])
			n++
		}
		if s, ok := l.(*macho.Segment); ok && s.Name == "__LINKEDIT" {
			linkedit = s
		}
		if s, ok := l.(*macho.Segment); ok && s.Name == "__TEXT" {
			text = s
		}
	}
	if n != 1 || int(sigOff+sigSize) != len(data) || sigOff%16 != 0 {
		t.Fatalf("%d signature commands, at %d+%d of %d", n, sigOff, sigSize, len(data))
	}
	if linkedit.Offset+linkedit.Filesz != uint64(len(data)) || linkedit.Memsz < linkedit.Filesz {
		t.Fatalf("__LINKEDIT %d+%d (%d in memory) for a file of %d", linkedit.Offset, linkedit.Filesz, linkedit.Memsz, len(data))
	}

	be := binary.BigEndian
	sig := data[sigOff:]
	if be.Uint32(sig) != magicEmbedded || be.Uint32(sig[4:]) != sigSize || be.Uint32(sig[8:]) != 3 {
		t.Fatalf("superblob %x", sig[:12])
	}
	blobs := map[uint32][]byte{}
	for i := 0; i < 3; i++ {
		slot, off := be.Uint32(sig[12+8*i:]), be.Uint32(sig[16+8*i:])
		blobs[slot] = sig[off:][:be.Uint32(sig[off+4:])]
	}
	if be.Uint32(blobs[slotRequirements]) != magicRequirements || len(blobs[slotRequirements]) != 12 {
		t.Fatalf("requirements %x", blobs[slotRequirements])
	}
	if be.Uint32(blobs[slotCMS]) != magicBlobWrapper || len(blobs[slotCMS]) != 8 {
		t.Fatalf("CMS %x", blobs[slotCMS])
	}
	cd := blobs[slotCodeDir]
	if be.Uint32(cd) != magicCodeDir || be.Uint32(cd[8:]) != 0x20400 || be.Uint32(cd[12:]) != flagAdhoc {
		t.Fatalf("code directory %x", cd[:16])
	}
	hashOff, identOff := be.Uint32(cd[16:]), be.Uint32(cd[20:])
	nSpecial, nCode, limit := be.Uint32(cd[24:]), be.Uint32(cd[28:]), be.Uint32(cd[32:])
	if got := string(cd[identOff : identOff+uint32(len("me.slynk.Slynk"))+1]); got != "me.slynk.Slynk\x00" {
		t.Fatalf("identifier %q", got)
	}
	if cd[36] != 32 || cd[37] != hashSHA256 || cd[39] != pageBits || limit != sigOff || nCode != (sigOff+pageSize-1)/pageSize || nSpecial != 3 {
		t.Fatalf("hash fields %x, limit %d, %d code and %d special slots", cd[36:40], limit, nCode, nSpecial)
	}
	if be.Uint64(cd[64:]) != text.Offset || be.Uint64(cd[72:]) != text.Filesz || be.Uint64(cd[80:]) != execSegMainBinary {
		t.Fatalf("executable segment %x", cd[64:88])
	}
	for i, s := range [][]byte{info, blobs[slotRequirements], res} {
		h := sha256.Sum256(s)
		if !bytes.Equal(cd[hashOff-uint32(i+1)*32:][:32], h[:]) {
			t.Fatalf("special slot -%d doesn't match", i+1)
		}
	}
	for p := uint32(0); p < nCode; p++ {
		h := sha256.Sum256(data[p*pageSize : min((p+1)*pageSize, limit)])
		if !bytes.Equal(cd[hashOff+p*32:][:32], h[:]) {
			t.Fatalf("page %d doesn't match", p)
		}
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestSignApp(t *testing.T) {
	// arm64: the Go linker's signature, replaced; amd64: none, added.
	for _, arch := range []string{"arm64", "amd64"} {
		t.Run(arch, func(t *testing.T) {
			app := buildApp(t, arch)
			must(t, signApp(app))
			check(t, app)
			// Signing again (a build run twice) gives the same bytes.
			first, _ := os.ReadFile(filepath.Join(app, "Contents", "MacOS", "slynk"))
			must(t, signApp(app))
			check(t, app)
			again, _ := os.ReadFile(filepath.Join(app, "Contents", "MacOS", "slynk"))
			if !bytes.Equal(first, again) {
				t.Fatal("signing twice changed the program")
			}
		})
	}
}

func TestSignAppRefusesStrayFiles(t *testing.T) {
	app := buildApp(t, "arm64")
	must(t, os.WriteFile(filepath.Join(app, "Contents", "extra.txt"), []byte("x"), 0o644))
	if err := signApp(app); err == nil || !strings.Contains(err.Error(), "unexpected file") {
		t.Fatalf("got %v", err)
	}
}
