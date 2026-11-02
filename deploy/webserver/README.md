# Running the website on your own server

The website is static: the server only hands out files. Any web server that sends the
right headers will do. On a host that reads `.htaccess` files (Apache and similar),
`web/public/.htaccess` does everything. This folder does the same on a server of your
own, with [Caddy](https://caddyserver.com), and is how slynk.me is run:

- `Caddyfile`: the site's rules.
- `caddy-slynk.conf`: a few additions to Caddy's service settings.
- `deploy.sh`: puts a published build on the server.
- `slynk-activate`: switches the server to a build once it's there.
- `nftables.conf`: the firewall.

## What the server needs

- A small virtual machine where you are root. 1 CPU, 1 GB of RAM and a 10 GB disk are
  plenty. A first visit downloads about 8 MB and a return visit almost nothing, so plan
  the bandwidth around 8 MB per new visitor.
- Debian 13, so the steps below apply as written.
- A name for the site with an A record pointing to the server. Delete any AAAA record
  unless the server has an IPv6 address.

## Setting it up

1. **The system:** set it up as the key server guide does (`../keyserver/README.md`):
   - SSH with keys only
   - logs and login records in memory only
   - UTC time from authenticated servers
   - automatic updates
   - the kernel settings

   Swap can stay, since this server holds nothing secret.

   For the firewall, use `nftables.conf` from this folder (same safety net). It lets
   SSH in only from the addresses it lists and through the private link ("Private SSH"
   below), so list your own addresses first, or set up the link before you apply it. If your
   provider's image uses cloud-init, a file in `/etc/cloud/cloud.cfg.d/` with
   `ssh_pwauth: false` and `ssh_deletekeys: false` stops it turning password logins
   back on.

2. **Caddy and rsync.** Debian 13's Caddy is 2.6, which offers browsers no quantum-safe
   key exchange, so take Caddy from its own signed package source (`apt/` here):
   - Save https://dl.cloudsmith.io/public/caddy/stable/gpg.key as
     `/etc/apt/keyrings/caddy-stable.asc`, and check its fingerprint is
     `6576 0C51 EDEA 2017 CEA2 CA15 155B 6D79 CA56 EA34`.
   - Install `apt/caddy-stable.sources` in `/etc/apt/sources.list.d/` and
     `apt/caddy-stable.pref` as `/etc/apt/preferences.d/caddy-stable`. The second lets
     that source supply Caddy and nothing else.
   - Install `apt/53caddy-unattended` as
     `/etc/apt/apt.conf.d/53slynk-caddy-unattended`, so its updates install
     by themselves.
   - Then:

         apt update
         apt install caddy rsync
         systemctl stop caddy

3. **The site's settings.**
   - Copy `Caddyfile` to `/etc/caddy/Caddyfile` (keep Debian's as `Caddyfile.orig`).
   - Copy `caddy-slynk.conf` to `/etc/systemd/system/caddy.service.d/slynk.conf`.
   - Copy `slynk-activate` to `/usr/local/sbin/slynk-activate` (mode 755).
   - Then:

         mkdir -p /etc/caddy/slynk /srv/slynk/releases
         echo 'SLYNK_SITE=example.org' > /etc/caddy/slynk/env
         echo 'header {
         }' > /etc/caddy/slynk/headers.caddy
         systemctl daemon-reload

4. **Other names (optional).** For a name that only sends people to the site, such as
   a second domain, point its A record at the server and give it a file in
   `/etc/caddy/slynk/redirects/` (the `Caddyfile` shows one). Every address on it then
   redirects to the same address on the site, path included.

5. **The first build.** From the repo, on your own computer:

       deploy/webserver/deploy.sh my-server

   `my-server` is the server's name in your `~/.ssh/config`. Then start Caddy:

       systemctl enable --now caddy

   It gets its certificate from Let's Encrypt within a minute (which accepts their
   terms on your behalf). The name goes into the public Certificate Transparency logs,
   as every certificate's does.

## Private SSH

slynk.me's servers answer SSH only through a private WireGuard link from the admins'
own machines. If the link ever fails, the provider's web console is the way in. (The
firewall can also list fixed addresses, but then the server holds where its admins
connect from.) WireGuard ignores every
packet not signed by a key it knows, so to everyone else the servers have no SSH at
all. It works from any address, inside a VPN too.

1. **On the server:** `apt install wireguard-tools`, then write
   `/etc/wireguard/wg0.conf` (mode 600):

       [Interface]
       Address = 10.0.0.1/32
       ListenPort = 51820
       MTU = 1280
       PrivateKey = <the output of wg genkey>

       [Peer]
       PublicKey = <an admin machine's public key>
       AllowedIPs = 10.0.0.2/32

   Then run `systemctl enable --now wg-quick@wg0`.
   - Each admin machine gets a `[Peer]` and an address of its own.
   - To add one later, put it in the file and run `systemctl restart wg-quick@wg0`.
     Adding it with `wg set` alone leaves the server no route back to it.
2. **On each admin machine:** a WireGuard peer for each server.
   - `AllowedIPs` is only the server's link address, so nothing else uses the link.
   - `Endpoint` is the server's public address and port.
   - In SSH's settings, `HostName` is the link address.
   - An MTU of 1280 leaves room to run inside another VPN.
3. **The firewall** (`nftables.conf` here) lets SSH in through `wg0`, and from the
   listed addresses only.

## Everyday

- **Deploying:**
  1. Push, and let CI publish the `deploy` branch.
  2. Check it matches your own build (`deploy/README.md`).
  3. Run `deploy/webserver/deploy.sh`.
  4. Run `deploy/check-site.sh`.
- **Rolling back:** the server keeps the three newest builds. `ls /srv/slynk/releases`,
  then `slynk-activate <name>` with the one you want.
- **Logs:** Caddy keeps no record of requests. `journalctl -u caddy` shows its own
  messages (certificates, errors), and those are in memory only.
