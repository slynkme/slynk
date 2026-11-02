//go:build embed

package main

import (
	"embed"
	"io/fs"
)

// The built site, copied into site/ before building with -tags embed, so the
// program is one file to download. all: keeps .htaccess, which holds the
// security headers.
//
//go:embed all:site
var site embed.FS

func init() {
	sub, err := fs.Sub(site, "site")
	if err != nil {
		panic(err)
	}
	embedded = sub
}
