// Command macsign signs Slynk.app ad hoc, as `codesign --sign -` does on a
// Mac, but from any computer: the release and test builds are made on Linux.
// An ad-hoc signature names nobody (no Apple
// account, no identity), and on Apple silicon macOS calls an app without a
// whole one "damaged", with no way to open it. The Go linker signs the
// program inside, but that signature doesn't cover the app around it.
//
//	go run ./macsign path/to/Slynk.app
//
// It writes Contents/_CodeSignature/CodeResources (each resource's SHA-1 and
// SHA-256, under Apple's standard rules), then signs Contents/MacOS/<program>
// again: a SHA-256 code directory for its pages, whose special slots bind the
// app's Info.plist, its (empty) requirements and that resource list; an empty
// requirements set; and the empty CMS blob ad-hoc signatures carry. The same
// app always gets the same signature.
//
// The layout follows the Go linker's own signer (cmd/internal/codesign, BSD
// licence, The Go Authors) and Apple's published cs_blobs.h.
package main

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"debug/macho"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	pageBits = 12
	pageSize = 1 << pageBits

	lcCodeSignature = 0x1d

	magicEmbedded     = 0xfade0cc0
	magicCodeDir      = 0xfade0c02
	magicRequirements = 0xfade0c01
	magicBlobWrapper  = 0xfade0b01

	slotCodeDir      = 0
	slotRequirements = 2
	slotCMS          = 0x10000

	hashSHA256 = 2
	flagAdhoc  = 0x2

	execSegMainBinary = 0x1

	codeDirHeader = 13*4 + 4 + 4*8
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: macsign path/to/Slynk.app")
		os.Exit(2)
	}
	if err := signApp(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "macsign:", err)
		os.Exit(1)
	}
}

func signApp(app string) error {
	contents := filepath.Join(app, "Contents")
	info, err := os.ReadFile(filepath.Join(contents, "Info.plist"))
	if err != nil {
		return err
	}
	id, exe := plistString(info, "CFBundleIdentifier"), plistString(info, "CFBundleExecutable")
	if id == "" || exe == "" {
		return errors.New("Info.plist names no CFBundleIdentifier or CFBundleExecutable")
	}
	resources, err := codeResources(contents, exe)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(contents, "_CodeSignature"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(contents, "_CodeSignature", "CodeResources"), resources, 0o644); err != nil {
		return err
	}
	program := filepath.Join(contents, "MacOS", exe)
	data, err := os.ReadFile(program)
	if err != nil {
		return err
	}
	signed, err := sign(data, id, [][]byte{info, requirements(), resources})
	if err != nil {
		return err
	}
	return os.WriteFile(program, signed, 0o755)
}

// plistString finds a key's string in an XML property list (Info.plist, which
// this program's build writes).
func plistString(plist []byte, key string) string {
	m := regexp.MustCompile(`<key>` + regexp.QuoteMeta(key) + `</key>\s*<string>([^<]*)</string>`).FindSubmatch(plist)
	if m == nil {
		return ""
	}
	return string(m[1])
}

// requirements is an empty requirements set, which ad-hoc signatures have.
func requirements() []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint32(b, magicRequirements)
	binary.BigEndian.PutUint32(b[4:], 12)
	return b
}

// The rules codesign writes for an app by default: Info.plist and the program
// have their own slots, code under MacOS/ is nested, everything else sealed.
const rules = `	<key>rules</key>
	<dict>
		<key>^Resources/</key>
		<true/>
		<key>^Resources/.*\.lproj/</key>
		<dict>
			<key>optional</key>
			<true/>
			<key>weight</key>
			<real>1000</real>
		</dict>
		<key>^Resources/.*\.lproj/locversion.plist$</key>
		<dict>
			<key>omit</key>
			<true/>
			<key>weight</key>
			<real>1100</real>
		</dict>
		<key>^Resources/Base\.lproj/</key>
		<dict>
			<key>weight</key>
			<real>1010</real>
		</dict>
		<key>^version.plist$</key>
		<true/>
	</dict>
	<key>rules2</key>
	<dict>
		<key>.*\.dSYM($|/)</key>
		<dict>
			<key>weight</key>
			<real>11</real>
		</dict>
		<key>^(.*/)?\.DS_Store$</key>
		<dict>
			<key>omit</key>
			<true/>
			<key>weight</key>
			<real>2000</real>
		</dict>
		<key>^(Frameworks|SharedFrameworks|PlugIns|Plug-ins|XPCServices|Helpers|MacOS|Library/(Automator|Spotlight|LoginItems))/</key>
		<dict>
			<key>nested</key>
			<true/>
			<key>weight</key>
			<real>10</real>
		</dict>
		<key>^.*</key>
		<true/>
		<key>^Info\.plist$</key>
		<dict>
			<key>omit</key>
			<true/>
			<key>weight</key>
			<real>20</real>
		</dict>
		<key>^PkgInfo$</key>
		<dict>
			<key>omit</key>
			<true/>
			<key>weight</key>
			<real>20</real>
		</dict>
		<key>^Resources/</key>
		<dict>
			<key>weight</key>
			<real>20</real>
		</dict>
		<key>^Resources/.*\.lproj/</key>
		<dict>
			<key>optional</key>
			<true/>
			<key>weight</key>
			<real>1000</real>
		</dict>
		<key>^Resources/.*\.lproj/locversion.plist$</key>
		<dict>
			<key>omit</key>
			<true/>
			<key>weight</key>
			<real>1100</real>
		</dict>
		<key>^Resources/Base\.lproj/</key>
		<dict>
			<key>weight</key>
			<real>1010</real>
		</dict>
		<key>^[^/]+$</key>
		<dict>
			<key>nested</key>
			<true/>
			<key>weight</key>
			<real>10</real>
		</dict>
		<key>^embedded\.provisionprofile$</key>
		<dict>
			<key>weight</key>
			<real>20</real>
		</dict>
		<key>^version\.plist$</key>
		<dict>
			<key>weight</key>
			<real>20</real>
		</dict>
	</dict>
`

// codeResources lists every file under Contents/Resources with its hashes.
// The app may hold nothing else besides Info.plist and its program: anything
// more would need rules this doesn't apply.
func codeResources(contents, exe string) ([]byte, error) {
	var files []string
	err := filepath.WalkDir(contents, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(contents, path)
		rel = filepath.ToSlash(rel)
		switch {
		case rel == "Info.plist", rel == "MacOS/"+exe, strings.HasPrefix(rel, "_CodeSignature/"):
		case strings.HasPrefix(rel, "Resources/"):
			files = append(files, rel)
		default:
			return fmt.Errorf("unexpected file in the app: %s", rel)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var v1, v2 strings.Builder
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(contents, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		s1, s2 := sha1.Sum(data), sha256.Sum256(data)
		fmt.Fprintf(&v1, "\t\t<key>%s</key>\n\t\t<data>\n\t\t%s\n\t\t</data>\n", rel, base64.StdEncoding.EncodeToString(s1[:]))
		fmt.Fprintf(&v2, "\t\t<key>%s</key>\n\t\t<dict>\n\t\t\t<key>hash2</key>\n\t\t\t<data>\n\t\t\t%s\n\t\t\t</data>\n\t\t</dict>\n", rel, base64.StdEncoding.EncodeToString(s2[:]))
	}
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>files</key>
	<dict>
` + v1.String() + `	</dict>
	<key>files2</key>
	<dict>
` + v2.String() + `	</dict>
` + rules + `</dict>
</plist>
`), nil
}

// sign returns the 64-bit Mach-O program data signed ad hoc as id, its
// special slots -1, -2, -3 holding the hashes of special[0], [1], [2]. Any
// signature it has already (the Go linker's) is replaced; without one, a
// load command for it goes in the header's spare room.
func sign(data []byte, id string, special [][]byte) ([]byte, error) {
	f, err := macho.NewFile(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if f.Magic != macho.Magic64 {
		return nil, errors.New("not a 64-bit Mach-O program")
	}
	order := f.ByteOrder
	const header = 32 // mach_header_64
	var sigCmd, linkeditCmd int
	var linkedit, text *macho.Segment
	at := header
	for _, l := range f.Loads {
		raw := l.Raw()
		switch order.Uint32(raw) {
		case lcCodeSignature:
			sigCmd = at
		}
		if seg, ok := l.(*macho.Segment); ok {
			switch seg.Name {
			case "__LINKEDIT":
				linkedit, linkeditCmd = seg, at
			case "__TEXT":
				text = seg
			}
		}
		at += len(raw)
	}
	if linkedit == nil || text == nil {
		return nil, errors.New("no __TEXT or __LINKEDIT segment")
	}
	if linkedit.Offset+linkedit.Filesz != uint64(len(data)) && sigCmd == 0 {
		return nil, errors.New("__LINKEDIT isn't at the end of the file")
	}
	out := append([]byte(nil), data...)
	var sigOff int
	if sigCmd != 0 {
		sigOff = int(order.Uint32(out[sigCmd+8:]))
		if sigOff+int(order.Uint32(out[sigCmd+12:])) != len(out) {
			return nil, errors.New("something follows the existing signature")
		}
	} else {
		// A new load command after the others, in the room the header leaves.
		first := len(out)
		for _, s := range f.Sections {
			if s.Offset != 0 && int(s.Offset) < first {
				first = int(s.Offset)
			}
		}
		sigCmd = header + int(f.Cmdsz)
		if sigCmd+16 > first || !bytes.Equal(out[sigCmd:sigCmd+16], make([]byte, 16)) {
			return nil, errors.New("no room in the header for a signature's load command")
		}
		order.PutUint32(out[sigCmd:], lcCodeSignature)
		order.PutUint32(out[sigCmd+4:], 16)
		order.PutUint32(out[16:], f.Ncmd+1)
		order.PutUint32(out[20:], f.Cmdsz+16)
		sigOff = (len(out) + 15) &^ 15
	}
	out = out[:sigOff]
	for len(out) < sigOff {
		out = append(out, 0)
	}

	nCode := (sigOff + pageSize - 1) / pageSize
	nSpecial := len(special)
	identOff := codeDirHeader
	hashOff := identOff + len(id) + 1 + nSpecial*sha256.Size
	cdLen := hashOff + nCode*sha256.Size
	req := requirements()
	cms := make([]byte, 8)
	binary.BigEndian.PutUint32(cms, magicBlobWrapper)
	binary.BigEndian.PutUint32(cms[4:], 8)
	const index = 12 + 3*8
	total := index + cdLen + len(req) + len(cms)

	// The header first: the signature's size, and __LINKEDIT reaching to its end, are hashed with it.
	order.PutUint32(out[sigCmd+8:], uint32(sigOff))
	order.PutUint32(out[sigCmd+12:], uint32(total))
	segEnd := uint64(sigOff+total) - linkedit.Offset
	order.PutUint64(out[linkeditCmd+32:], (segEnd+0x3fff)&^0x3fff) // vmsize, whole pages
	order.PutUint64(out[linkeditCmd+48:], segEnd)                  // filesize

	be := binary.BigEndian
	sig := make([]byte, total)
	be.PutUint32(sig, magicEmbedded)
	be.PutUint32(sig[4:], uint32(total))
	be.PutUint32(sig[8:], 3)
	for i, b := range []struct{ slot, off int }{{slotCodeDir, index}, {slotRequirements, index + cdLen}, {slotCMS, index + cdLen + len(req)}} {
		be.PutUint32(sig[12+8*i:], uint32(b.slot))
		be.PutUint32(sig[16+8*i:], uint32(b.off))
	}
	cd := sig[index : index+cdLen]
	be.PutUint32(cd[0:], magicCodeDir)
	be.PutUint32(cd[4:], uint32(cdLen))
	be.PutUint32(cd[8:], 0x20400) // with the executable segment's fields
	be.PutUint32(cd[12:], flagAdhoc)
	be.PutUint32(cd[16:], uint32(hashOff))
	be.PutUint32(cd[20:], uint32(identOff))
	be.PutUint32(cd[24:], uint32(nSpecial))
	be.PutUint32(cd[28:], uint32(nCode))
	be.PutUint32(cd[32:], uint32(sigOff)) // code limit
	cd[36] = sha256.Size
	cd[37] = hashSHA256
	cd[39] = pageBits
	be.PutUint64(cd[64:], text.Offset) // executable segment base
	be.PutUint64(cd[72:], text.Filesz) // and limit
	be.PutUint64(cd[80:], execSegMainBinary)
	copy(cd[identOff:], id)
	for i, s := range special { // slot -(i+1) sits i+1 hashes before slot 0
		h := sha256.Sum256(s)
		copy(cd[hashOff-(i+1)*sha256.Size:], h[:])
	}
	for p := 0; p < nCode; p++ {
		end := min((p+1)*pageSize, sigOff)
		h := sha256.Sum256(out[p*pageSize : end])
		copy(cd[hashOff+p*sha256.Size:], h[:])
	}
	copy(sig[index+cdLen:], req)
	copy(sig[index+cdLen+len(req):], cms)
	return append(out, sig...), nil
}
