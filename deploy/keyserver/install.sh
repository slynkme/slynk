#!/bin/sh
# Installs slynk.me's key server on a fresh Debian 13 server, once. Run as
# root, in a folder holding this script, keyserver.service, certbot-deploy-hook
# and the built program (keyserver). See deploy/README.md, "The key server".
# Running it again updates the files and restarts the service (which saves and
# restores the waiting key halves).
set -eu
cd "$(dirname "$0")"

id keyserver >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin keyserver
install -d -m 0750 -o root -g keyserver /etc/keyserver /etc/keyserver/tls
install -m 0755 keyserver /usr/local/bin/keyserver
install -m 0644 keyserver.service /etc/systemd/system/keyserver.service
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -m 0755 certbot-deploy-hook /etc/letsencrypt/renewal-hooks/deploy/keyserver
install -d -m 0700 -o keyserver -g keyserver /var/lib/keyserver
install -d -m 0755 -o keyserver -g keyserver /var/lib/keyserver/acme

# At the very first install: an empty shutdown file, so the first start counts
# as clean, not as a crash that lost links.
if [ ! -e /var/lib/keyserver/.installed ]; then
	runuser -u keyserver -- /usr/local/bin/keyserver -init -state-dir /var/lib/keyserver
	touch /var/lib/keyserver/.installed
fi

systemctl daemon-reload
systemctl enable keyserver >/dev/null 2>&1
systemctl restart keyserver
systemctl --no-pager --lines=0 status keyserver | head -3
