# Deployment

Pushing to `main` builds the site; putting it on the server is a second step.

1. `.github/workflows/deploy.yml` builds `web/` and the Go core on GitHub
   Actions, and commits the result to the `deploy` branch. That branch holds
   only built files.
2. `webserver/deploy.sh` checks that build against its own list of files and
   puts it on the web server, which runs Caddy (`webserver/README.md` says how
   it's set up). A host that reads `.htaccess` files can instead pull the
   `deploy` branch into the website's folder with its own Git deployment.

## The key server (k.slynk.me)

One-time links keep slynk.me's half of each key on slynk.me's own **key server**,
`k.slynk.me`: a small Go program (`core/cmd/keyserver`) on its own small Debian 13 virtual
server, which keeps the halves **in memory only**, apart from the web server, so the web
server never sees a half. Why, and what it costs: `docs/findings/one-time-links.md`.
Setting one up from scratch, as slynk.me's is: `deploy/keyserver/README.md`.

- **Getting in:** SSH with a key, only through a private WireGuard link, as for the web
  server (`deploy/webserver/README.md`). The provider's web console is the emergency way in.
- **What's where on the server:**

  | Path | What |
  |---|---|
  | `/usr/local/bin/keyserver` | the program |
  | `/etc/systemd/system/keyserver.service` | its service settings (`deploy/keyserver/keyserver.service`) |
  | `/etc/keyserver/tls/` | copies of its certificate, readable by the service |
  | `/var/lib/keyserver/` | `acme/` for certbot's challenges, and `shutdown`, which exists only between a clean stop and the next start |
  | `/run/keyserver/status` | the hourly line (in memory) |

- **Restarts lose nothing.** `systemctl restart keyserver`, a reboot, or an automatic
  update's restart: as it stops, the program writes the waiting halves to
  `/var/lib/keyserver/shutdown`; the next start reads them back and destroys the file
  before answering anything. Only a **crash** (or a power cut) loses the halves waiting at
  that moment. For the next three weeks every answer then says so (`"r":1`), and someone
  opening a link that was lost is told it may have been lost in a restart, rather than
  that someone else opened it. `systemctl reload keyserver` only re-reads the certificate.
- **The hourly line:** `cat /run/keyserver/status` on the key server shows a line starting
  `keyserver:`, with warnings for a busy hour, refused links, or the store nearly full (the
  room is 2 million links, `-max-records`). Right after a start, it says whether the server
  started with its saved halves or without them.
- **Updating the program:**
  1. Build it, and copy the files in `deploy/keyserver/` beside it:
     `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C core build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /tmp/ks/keyserver ./cmd/keyserver`
  2. `scp -r /tmp/ks slynk-keyserver:/root/ks`, then `ssh slynk-keyserver /root/ks/install.sh`.
     It restarts the service, so the halves are saved and restored.
  3. Check that `/run/keyserver/status` says it started with its saved halves, and that a
     test request is answered.
  - **Going back to an older program:** install it with the service file of its own commit
     (`install.sh` copies both), since a program's flags and its service file go together.
- **The certificate** comes from Let's Encrypt through certbot (Debian's package), using the
  key server's port 80 (`--webroot`). certbot's timer renews it; `deploy/keyserver/certbot-deploy-hook`
  installs each new one and reloads the program, without restarting it. The first one is
  asked for once, by hand, with `certbot certonly --webroot -w /var/lib/keyserver/acme -d k.slynk.me
  --register-unsafely-without-email` (no email address goes to Let's Encrypt). That means
  accepting Let's Encrypt's terms, which is the operator's call. The certificate, and so the
  name `k.slynk.me`, is published in public Certificate Transparency logs. Add
  `--deploy-hook /etc/letsencrypt/renewal-hooks/deploy/keyserver` to that first command:
  certbot runs the hooks folder only on renewals, and without it the first certificate
  would never reach the key server.
- **The puzzle, and making it harder in an emergency.** Every new link comes with a small
  puzzle the sender's page solves in the background (`web/src/pow/`; how it works is in
  `core/keyserver/protocol.go`). It stops lazy scripts, not a determined attacker. Its
  difficulty is the number after `-pow-bits` in `/etc/systemd/system/keyserver.service`
  (20). Every answer says it and open pages follow it, so changing it needs no rebuild.
  Each 1 more doubles the work for everyone, scripts included:

  | `-pow-bits` | Mid-range phone (average) | Old phone (average) | Computer |
  |---|---|---|---|
  | 20 | about 1 s | about 4 s | about 0.3 s |
  | 21 | about 2 s | about 8 s | about 0.7 s |
  | 22 | about 4 s | about 15 s | about 1.3 s |
  | 0 | off | off | off |

  These are averages (about 1 in 20 puzzles takes three times as long), estimated from a
  2020 desktop's speed, not measured on phones. Pages solve it while the person is still
  writing, so a send rarely waits for it. Checking one costs the server a hash or two,
  whatever the number. If a script is making links non-stop (people get "Slynk can't set
  up new links right now"), raise it for a while, as root on the key server:
  `sed -i 's/-pow-bits 20 /-pow-bits 22 /' /etc/systemd/system/keyserver.service && systemctl daemon-reload && systemctl restart keyserver`
  (the restart saves and restores the waiting halves). Set it back the same way once the
  flood is over, and keep `deploy/keyserver/keyserver.service` in the repo in step.
- **The rate limit** (600 new links at once, then 60 a minute) is in
  `core/keyserver/protocol.go`; the room is `-max-records` in the service file: 2 million
  links, about 400 MB, which a 1 GB server holds safely (measured 2026-10-21: 403 MB).
  Even a flood at the rate limit can't fill it: at most about 1.8 million links exist at
  once. Were it full, new links would be refused until older ones expire, and nothing
  would be lost.
- **Floods:** the provider's DDoS protection absorbs floods of traffic. The program itself
  caps open connections (`-max-conns`), reads a request before giving it one of its
  answer slots, and times idle connections out after 15 seconds. The server's firewall
  also limits each address to 20 new connections a second (a burst of 50) and 128 at once.
- **The clock** decides when links expire, so it's set only by authenticated time (NTS):
  chrony with six servers from three public time services, at least three agreeing
  (`deploy/keyserver/server/chrony-keyserver.conf`). On the key server, `chronyc -N sources`
  marks the one in use `*`; Debian's pool shows `?`, never used.
