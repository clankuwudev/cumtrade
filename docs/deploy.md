# Deploying cumTrade

From a fresh Ubuntu VM to a running site, then how to deploy, roll back,
check and remove it. Every release is built on your own machine from a
commit, copied over SSH and switched on atomically; the server never pulls,
builds or fetches code.

## What runs where

| Where | What |
|---|---|
| Your machine | The repository. `deploy/deploy.sh` builds a release from a commit and ships it. The deploy key. |
| The server | Caddy (TLS, the page, static files, proxy), Node 22 in `/opt/node22`, the `clank-hosted` service. No git, no npm, no `src/self/`. |

| Path on the server | Owner | What |
|---|---|---|
| `/srv/clank/releases/<sha>/` | `clank-deploy`, read-only to others | One release per commit, the last five kept |
| `/srv/clank/releases/<sha>/page/` | the same | The four pages, each with its policy, which Caddy serves: the landing (`landing.html`, `landing-policy.txt`), the app (`index.html`, `policy.txt`), cumAI (`ai.html`, `ai-policy.txt`) and the docs (`docs.html`, `docs-policy.txt`) |
| `/srv/clank/releases/<sha>/release-manifest.json` | the same | The hashes of the page and of every file under `/v/<sha>/` |
| `/srv/clank/current` | `clank-deploy` | Symlink to the live release |
| `/var/lib/clank/` | `clank-web` | Chart history and the chain index (`index.sqlite`), the only things the service writes |
| `/etc/clank/hosted.env` | root, `0600` | The service's environment |
| `/etc/clank/site.d/*.caddy` | root | Per-machine Caddy settings: staging's password, a rehearsal's local TLS |
| `/etc/clank/redirects.d/redirects.caddy` | root | Optional: `deploy/redirects.caddy`, hosts that only redirect to the site |
| `/usr/local/bin/clank-activate` | root | `deploy/activate.sh` |

`clank-web` runs Node and cannot write the files it serves. `clank-deploy` owns
the releases and can restart the service, and nothing else, as root.

**Node never writes a page.** Caddy serves four pages from the live release,
each with its own policy file and headers fixed in the Caddyfile:
- the landing at `/`, from `page/landing.html`, with `page/landing-policy.txt`;
- the app at `/trade` and `/console`, from `page/index.html`, with
  `page/policy.txt`;
- cumAI at `/ai`, from `page/ai.html`, with `page/ai-policy.txt`;
- the project docs at `/docs`, from `page/docs.html`, with `page/docs-policy.txt`.

`/os`, `/cumOS`, `/cumos` and `/terminal` answer 301 to `/trade`. Node answers only
`/healthz`, `/events` and `/api/*`, and Caddy makes whatever it answers inert:
a sandboxing policy with no script, `nosniff`, no script or stylesheet types,
and no cookies. So a compromised Node process can lie in its API answers,
which the page's verifier is there to catch, but it cannot change the page,
its policy or any script, and it cannot serve a page of its own on the
site's origin, where the trading wallet keeps its session.

## Deploy access

**Whoever can deploy can ship a page that empties every logged-in trading
wallet.** Every web wallet has this trust model, which is why the site says
"trading money only". So deploy access is kept as narrow as it can be:

- **It is one SSH key, on the operator's machine,** protected by a
  passphrase, or held on a hardware key (`ssh-keygen -t ed25519-sk`). It is
  the only key in `~clank-deploy/.ssh/authorized_keys`. Set
  `PasswordAuthentication no` in the server's `sshd_config`.
- **Only the operator's machine builds and ships.** `deploy/deploy.sh`
  builds the release there, from a commit, and copies it over SSH. Nothing
  on the server pulls, builds or fetches code.
- **No CI job can deploy.** The published repository's CI runs checks
  and tests only. It has no deploy step, no SSH key, no server address and
  no secret that reaches the server. Do not add one: a CI secret that can
  deploy is a second way in, held by a third party.
- **`clank-deploy` can do one thing as root:** restart `clank-hosted`
  (`deploy/clank-deploy.sudoers`). It cannot change Caddy's config, which is
  root's, or reload Caddy. The page's policy reaches Caddy
  as a file in the release, read on each request, not as config.
- **Anyone can check what was deployed** against the source: see
  [Check the live site against the source](#check-the-live-site-against-the-source).
  If a deploy key is ever stolen, that check is how a changed page is seen.

## Before you start

- **A hostname.** Point its A (and AAAA) record at the VM.
- **An RPC key for the site alone,** with a spending alert at the provider.
- **SSH access** to an Ubuntu 22.04 or 24.04 VM with ports 80 and 443 open.
  The provider is your choice.

## 1. Node 22

The service runs `/opt/node22/bin/node` by path, so any system Node is left
alone.

```bash
cd /tmp
V=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | sed -n 's/.*node-\(v22[0-9.]*\)-linux-x64\.tar\.xz$/\1/p')
curl -fsSLO "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-linux-x64.tar.xz\$" | sha256sum -c -
sudo mkdir -p /opt/node22 && sudo tar -xJf "node-$V-linux-x64.tar.xz" -C /opt/node22 --strip-components=1
/opt/node22/bin/node --version
```

## 2. Caddy

From Caddy's official apt repository
([caddyserver.com/docs/install](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

The Caddyfile reads the page's policy with Caddy's `{file.*}` placeholder,
which older Caddy releases do not have. The rehearsal used Caddy 2.11.4, and
this repository installs a current one. A Caddy that left the placeholder
unexpanded would send it as the policy, which browsers ignore: the live
check after every deploy (step 5) compares the policy byte for byte, and
would fail.

## 3. Users, directories, service

From a copy of the repository's `deploy/` directory on the server (scp it
across, then delete it when done):

```bash
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin clank-web
sudo useradd --create-home --shell /bin/bash clank-deploy   # add your SSH public key to ~clank-deploy/.ssh/authorized_keys

sudo install -d -o clank-deploy -g clank-deploy -m 755 /srv/clank /srv/clank/releases
sudo install -d -o clank-web -g clank-web -m 700 /var/lib/clank
sudo install -d -m 755 /etc/clank /etc/clank/site.d

sudo install -m 755 deploy/activate.sh /usr/local/bin/clank-activate
sudo install -m 644 deploy/clank-hosted.service /etc/systemd/system/clank-hosted.service
sudo install -m 440 deploy/clank-deploy.sudoers /etc/sudoers.d/clank-deploy && sudo visudo -cf /etc/sudoers.d/clank-deploy

sudo install -m 600 deploy/hosted.env.example /etc/clank/hosted.env
sudoedit /etc/clank/hosted.env        # PUBLIC_ORIGIN=https://<hostname>, RPC_URL, WS_URL, LOGS_RPC_URL, INDEX_DB
sudo systemctl daemon-reload && sudo systemctl enable clank-hosted
```

The service starts with the first deploy (step 5). Until `current` exists it
fails and retries, which is expected.

## 4. Caddy's site

```bash
sudo install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl edit caddy     # add:  [Service]  Environment=SITE_HOST=<hostname>

# Private staging: a password on everything but /healthz, and noindex.
caddy hash-password           # type the password; copy the hash
sudo install -m 640 -g caddy deploy/site.d/staging-private.caddy.example /etc/clank/site.d/staging-private.caddy
sudoedit /etc/clank/site.d/staging-private.caddy   # replace STAGING_USER and STAGING_PASSWORD_HASH

# As caddy, not root: validating opens the access log, and a root-owned log
# file stops the service from starting.
sudo -u caddy env SITE_HOST=<hostname> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl restart caddy
```

Caddy obtains the certificate the first time the hostname is requested.

The Caddyfile ends by importing `/etc/clank/gateway.d/*.caddy` and
`/etc/clank/redirects.d/*.caddy`. With nothing there it serves the site
alone, and Caddy logs a warning about each empty pattern.

**Behind Cloudflare.** The Caddyfile's global options trust
Cloudflare's published ranges and read the visitor from `CF-Connecting-IP`.
The site's Node proxy then passes exactly that address as `X-Forwarded-For`,
so the rate limits see visitors, not Cloudflare. Install it and validate it
while the records are still grey (DNS only), where it changes nothing; only
then turn them orange. Refresh the ranges from
www.cloudflare.com/ips-v4 and ips-v6 when Cloudflare announces a change.
test:release pins the list, so it changes together with the test, with the
new fetch date in the Caddyfile's comment.

## 5. Deploy

From your machine, in the repository, with the commit you want live checked in:

```bash
deploy/deploy.sh clank-deploy@<host>                 # HEAD
deploy/deploy.sh clank-deploy@<host> --ref <commit>  # anything else
```

It builds `releases/hosted-<sha>.tar.gz` (`npm run release:hosted`), copies it
to the server, and `clank-activate` runs these steps:
1. Unpacks the release. It refuses one with no page, an empty policy, no
   manifest, or an `app.html` among the files served under `/v/`.
2. Switches `current`. From this moment Caddy serves the new page, with the
   new policy: it reads both from `current` on each request.
3. Restarts the service.
4. Waits up to 30s for `/healthz`.
5. If it never answers, switches back to the previous release and exits 1.

Then check the live site against the commit you deployed:

```bash
npm run verify:live -- https://<hostname>
```

## 6. Roll back, look

```bash
deploy/deploy.sh clank-deploy@<host> rollback   # to the release deployed before the current one
deploy/deploy.sh clank-deploy@<host> status
ssh <host> journalctl -u clank-hosted -n 100    # the service's log: no addresses, no URLs with queries
```

Rolling back twice returns to where you started: each rollback switches to the
most recent other release.

## 7. Check it

Run these after the first deploy.

```bash
H=<hostname>
curl -sI https://$H/healthz                     # 200, Strict-Transport-Security, and a policy ending in "sandbox"
curl -s -o /dev/null -w '%{http_code}\n' https://$H/            # 401 without the password
curl -sI -u user:pass https://$H/ | grep -i 'x-robots-tag\|content-security-policy\|cross-origin-opener\|cache-control'
SHA=$(curl -s -u user:pass https://$H/ | sed -n 's#.*src="/v/\([0-9a-f]*\)/js/main.js".*#\1#p')
curl -sI -u user:pass https://$H/v/$SHA/js/main.js | grep -i 'cache-control\|x-content-type'   # immutable, nosniff
curl -s -o /dev/null -w '%{http_code}\n' -u user:pass https://$H/v/$SHA/app.html              # 404: the page is never served from /v/
CLANK_VERIFY_AUTH=user:pass npm run verify:live -- https://$H                                  # everything, byte for byte

# On the server:
find /srv/clank -path '*src/self*'                                   # nothing
sudo -u clank-web touch /srv/clank/current/src/web/public/x          # Permission denied
curl -s -u user:pass "https://$H/api/ledger?address=0xabc" >/dev/null; sudo tail -n 1 /var/log/caddy/clank-access.log   # uri without "?", no IP
```

## 8. The uptime check

Point an external monitor at `https://<hostname>/healthz`, which needs no
password, checking every minute. It should alert **a named person** within 5
minutes of a failure. Who that is, and what "down" means, is a pre-launch gate
that a person decides. This document doesn't name one.

## Check the live site against the source

Anyone can do this, not only the operator. The page's footer shows the
commit it was built from, and `scripts/verify-live.mjs` rebuilds that
release from the source and compares:

```bash
npm run verify:live -- https://<hostname>
# or: node scripts/verify-live.mjs https://<hostname> [--repo <dir>] [--ref <ref>]
```

It checks, byte for byte by SHA-256:
- all four pages at every path they answer on: the landing at `/`, the
  app at `/trade` and `/console`, cumAI at `/ai` and the docs at `/docs`, with every header each
  must carry, its policy included. It reads the release's sha from the app
  at `/trade`;
- that `/os`, `/cumOS`, `/cumos` and `/terminal` answer 301 to `/trade`;
- every file under `/v/<sha>/`: the modules, the stylesheet, the fonts and
  the vendored wallet SDK;
- the live `/release-manifest.json`.

It also checks that no page's source (`/v/<sha>/app.html`,
`/v/<sha>/landing/index.html`, `/v/<sha>/ai/index.html`, `/v/<sha>/docs/index.html`) is served, and that what Node
answers carries the sandboxing policy. It exits 1 and names every
difference. It needs Node 22, git, and `npm ci` in the checkout: it reads
the policy from `src/server/http.ts` at that commit with TypeScript.

- **Private staging:** `CLANK_VERIFY_AUTH=user:pass npm run verify:live -- https://<hostname>`.
- **The published repository** has one commit of its own, not the deployed
  one. Compare its content with `--ref HEAD`; the output says it compared
  content only. The SDK bundle is not published: `vendor/wallet.js` is
  checked against the published `wallet.js.sha256`, and its `LICENSES.txt`
  needs `npm run vendor:wallet` first.
- **A commit this checkout does not have:** `git fetch`, or it says so and
  stops.

## Rehearsing on your own machine

The same steps run in a local Linux environment (WSL with systemd enabled, as
root), with three differences:

- **TLS:** there is no public DNS name, so Caddy signs with its own CA.
  Install `deploy/site.d/local-tls.caddy.example` as
  `/etc/clank/site.d/local-tls.caddy` and set `SITE_HOST` to a made-up name
  such as `h1-rehearsal.test`. Then query it with
  `curl --resolve h1-rehearsal.test:443:127.0.0.1 --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt https://h1-rehearsal.test/…`.
- **No SSH:** build on the Windows side (`npm run release:hosted`), then in
  the Linux shell run
  `deploy/deploy.sh --local --tarball /mnt/c/…/releases/hosted-<sha>.tar.gz`.
- **Stream tests:** every connection through a local proxy is the client
  127.0.0.1, which may hold 24 event streams. Keep a stream test under
  that.
- **The live check:** from the Linux shell, with the repository reachable,
  `NODE_EXTRA_CA_CERTS=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt node scripts/verify-live.mjs https://h1-rehearsal.test --resolve h1-rehearsal.test:443:127.0.0.1`.
- **Without the system units:** the site can be rehearsed with a user-level Caddy
  on a spare port, running this Caddyfile with only its paths, upstream port
  and log pointed at a scratch copy of the release, plus a global block
  with `admin off` and `auto_https off`, and Node from that release as the
  same user. Validate such a copy as that user, never the installed
  Caddyfile as root (step 4).

## Removing it

```bash
sudo deploy/uninstall.sh            # the site: its service, user, releases, history and config
sudo deploy/uninstall.sh --all      # and Caddy with its apt source, and /opt/node22
```
