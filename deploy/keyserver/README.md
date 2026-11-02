# Running your own key server

One-time links split an item's key in two: one half lives only in the link, the other
on the **key server**, which hands it out once and then deletes it. Deleting that half
is what makes a used link useless, since the mixnet can't delete what it stores. So the
key server should keep its halves somewhere nothing copies them. Slynk's keeps them
only in memory: never in a file while it runs, never in a backup, never in a log.

This guide sets up a server the way slynk.me's is set up. The program is
`core/cmd/keyserver`; its service settings, certificate hook and install script are in
this folder, and ready-to-copy settings for the server itself in `server/`.

## What a "memory only" server needs, and why

- **A full virtual machine (KVM or similar) where you are root,** not a container
  (OpenVZ, LXC): you must control swap and the kernel. `systemd-detect-virt` should say
  `kvm` (or another hypervisor), not `lxc` or `openvz`.
- **No swap, no hibernation, no crash dumps:** each would write memory to disk. The key
  server checks and refuses to start while swap is on.
- **Logs in memory:** the program logs nothing about requests, and the system's own logs
  and login records (which hold your address) stay in memory too.
- **Small:** 1 CPU and 1 GB of RAM are plenty: the program uses about 20 MB in everyday
  use, and its room of 2 million links takes about 400 MB when full (about 200 bytes a
  link). A 10 GB disk is enough.
- **From the provider:** DDoS protection included (it absorbs the floods a small server
  can't), a web console for emergencies, and automatic backups or snapshots either
  absent or switched off. With nothing secret on the disk, a disk backup holds only the
  program and its settings, but one that also captured memory would hold the halves.
- **A name for it,** such as `k.example.org`, with a DNS record pointing to it.

What memory only can't change: whoever runs the machine underneath (the provider, or
anyone who makes them) can read a virtual machine's memory while it runs, so while a
link is waiting its half could be copied by someone with that access. Afterwards, there
is nothing left to find.

## Restarts and crashes

When the key server stops cleanly (a restart, a reboot, an update), it writes the
waiting halves to `/var/lib/keyserver/shutdown`; the next start reads them back and
destroys the file before answering anything. So restarts lose nothing, and the server
can install kernel updates and restart on its own. A crash or power cut loses the halves
waiting at that moment; for the next three weeks every answer then says so, and someone
opening a lost link is told it may have been lost, rather than that someone else opened
it. Deleted files can linger in a disk's freed space, so the halves that were waiting at
past restarts might be recovered by someone who takes the disk later: still useless
without the link, and once the mixnet has dropped the pieces (about three weeks).

## 1. The machine

Install Debian 13 from the provider's plain image (no desktop, no web server, no
control panel). As root, in the provider's web console or with the password it gave you:

1. **The clock: UTC, set only by authenticated time.** The puzzle and expiries depend on
   it, and a clock pushed weeks ahead would delete every waiting half at the next
   clean-up. `timedatectl set-timezone Etc/UTC`; then install `server/chrony-keyserver.conf`
   as `/etc/chrony/conf.d/keyserver.conf` and `apt install chrony` (its header says how to
   check): it takes the time only from NTS servers, which prove their answers, instead of
   Debian's default, which anyone on the network path could fake.
2. **SSH with keys only.**
   - On your own computer: `ssh-keygen -t ed25519 -C keyserver -f ~/.ssh/keyserver`.
   - On the server, add the contents of `~/.ssh/keyserver.pub` to `/root/.ssh/authorized_keys`
     (`chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys`).
   - Before trusting the server, compare fingerprints: on the server,
     `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`; on your computer,
     `ssh-keyscan -t ed25519 k.example.org | ssh-keygen -lf -`. They must match.
   - Install `server/sshd-keyserver.conf` as `/etc/ssh/sshd_config.d/10-keyserver.conf`
     (its header says how), and check a new login with the key works before closing
     your session.
3. **No swap:** `swapoff -a`, delete any swap line in `/etc/fstab`, and delete the swap
   file. `swapon --show` must print nothing.
4. **Logs in memory:** install `server/journald-keyserver.conf` and
   `server/tmpfiles-keyserver-logins.conf` (their headers say how), remove `rsyslog` if
   it's installed (`apt purge rsyslog`), and delete `/var/log/journal`. Log in again with
   a terminal and check the record appears under `/run/wtmpdb/`, and
   `find / -xdev -name 'wtmp*' -not -type l` finds nothing on disk.
5. **Remove the provider's guest agent** if there is one (`apt purge qemu-guest-agent`):
   it lets the machine underneath run commands and read files inside yours.
6. **The firewall:** edit `server/nftables.conf` to list your own addresses for SSH,
   install it as `/etc/nftables.conf`, and apply it with the safety net its header
   describes. Then `systemctl enable nftables`.
7. **Automatic updates:** `apt install unattended-upgrades needrestart`, then install
   `server/apt-20auto-upgrades`, `server/apt-52keyserver-unattended` (pick your own
   quiet hour) and `server/needrestart-keyserver.conf`. Run `apt full-upgrade` once now,
   then `apt autoremove --purge`: an image's first kernel can linger otherwise. With these
   settings old kernels and downloaded packages are cleared on their own, and Debian's
   certbot leaves its logs to logrotate, so the disk stays at about 1 GB.
8. **Kernel features nothing uses, off:** install `server/sysctl-keyserver.conf` as
   `/etc/sysctl.d/90-keyserver.conf`, run `sysctl --system`, and check
   `systemctl --failed` lists nothing.
9. **Restart once** (`systemctl reboot`) and check everything held: SSH with the key only,
   `nft list ruleset`, no swap, the journal in `/run/log/journal`.

## 2. The key server

1. **Point a name at it,** e.g. an A record for `k.example.org`.
2. **Build it** on your computer, from the repo:
   `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C core build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /tmp/ks/keyserver ./cmd/keyserver`,
   and copy `keyserver.service`, `certbot-deploy-hook` and `install.sh` from this folder
   beside it. In `keyserver.service`, set `-allow-origin` to your site's own address (the
   page's origin, e.g. `https://example.org`), followed by the address your downloadable
   copy serves its page at, if you offer one, comma-separated and exactly as browsers send
   them; in `certbot-deploy-hook`, your key server's name. Give your downloadable copy a
   port of its own, not slynk.me's 8293: browsers keep a page's stored data per address
   and port, so two products on one port would share it (remembered inbox words
   included).
3. **Install it:** copy the folder to the server (`scp -r /tmp/ks root@k.example.org:/root/ks`),
   then run `/root/ks/install.sh` there. It creates the service's own user and folders,
   writes an empty shutdown file (so the first start isn't taken for a crash), and starts
   it. With no certificate yet, it answers only certbot's challenges on port 80.
4. **The certificate:** `apt install certbot`, then
   `certbot certonly --webroot -w /var/lib/keyserver/acme -d k.example.org --register-unsafely-without-email --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/keyserver`
   (it asks you to accept Let's Encrypt's terms; the name goes into public Certificate
   Transparency logs). The hook installs the certificate and reloads the key server
   without restarting it, now and at every renewal. Check renewal works with
   `certbot renew --dry-run`.
5. **Your page:** set `KEY_SERVER` in `web/src/site.ts` to `https://k.example.org/`, and
   add that address to the CSP's `connect-src` in `web/public/.htaccess`. If your copy
   allows links that aren't one-time, also run the key server with `-one-time-only=false`
   (and set `ONE_TIME_ONLY` in `site.ts`).

## 3. Checks

- `systemctl status keyserver` is active; `cat /run/keyserver/status` says it started
  with its saved shares.
- The service's protections: `systemd-analyze security keyserver` (about 1.7, "OK");
  `grep VmLck /proc/$(systemctl show -p MainPID --value keyserver)/status` is non-zero
  (its memory is locked).
- From your computer, a request answers 200 with exactly 128 bytes:
  `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Content-Type: text/plain' --data-binary @request.json https://k.example.org/`
  (any 256-byte request the page sends; `requestBody()` in `web/src/burn.ts` makes them).
- The connection is post-quantum: a TLS 1.3 client offering it (recent browsers, or Go's
  `crypto/tls`) negotiates `X25519MLKEM768`.
- A restart keeps a waiting link: make a link, `systemctl restart keyserver`, open it.
- The firewall's limits: 100 connections opened at once from one address get about 50
  through (its burst), and no address holds more than 128.
- The clock: `chronyc -N sources` marks one of the six NTS servers `*` (Debian's pool
  `?`: never used), and `chronyc -N authdata` shows each with `NTS` and cookies.

## Running it

- **The hourly line:** `cat /run/keyserver/status`: links kept, new links in the last hour
  against the usual, and warnings for a busy hour, refused links, or a store nearly full.
- **Updating the program:** build and copy as above, and run `install.sh` again (the
  restart saves and restores the halves).
- **A flood of new links:** raise the puzzle's difficulty, `-pow-bits` in
  `/etc/systemd/system/keyserver.service` (each 1 more doubles the work, for everyone),
  then `systemctl daemon-reload && systemctl restart keyserver`. Open pages follow it from
  their next answer.
- **The limits:** 600 new links at once, then 60 a minute, for everyone together (no
  addresses are kept, so there's no per-person limit); room for 2 million links
  (`-max-records`: more than that rate can fill, as at most about 1.8 million exist at
  once; raise it only with more memory); 2,048 connections per port
  (`-max-conns`).
