# Deployment (production)

Last updated: 2026-11-23

Address: **https://visionguard.smartwaygroup.com.sa**

Production runs as an isolated Docker Compose project (`visionguard`, folder `/opt/visionguard`) on a shared Linux server, behind the server's nginx and a Let's Encrypt certificate. The same server also hosts other applications, so VisionGuard never touches their sites.

## 1. What runs where

| Port | What | Reachable from |
|---|---|---|
| 443 / 80 | nginx with TLS, proxies to the VisionGuard container on `127.0.0.1:3100` | the internet |
| 1935 | RTMP video from the cameras (bound to a dedicated IP) | the internet |
| 8000 | HTTP-FLV for live view (bound to the dedicated IP, from `docker-compose.test.yml`) | the internet |
| 3000 | plain HTTP dashboard | **closed** since 2026-11-18 (cameras, Dock Agents, apps and browsers use HTTPS) |

Files: `deploy/docker-compose.yml` (the service, healthcheck, data volume), `deploy/docker-compose.test.yml` (also publishes the FLV port on the dedicated IP; needs `RTMP_BIND_IP`), `deploy/nginx-visionguard.conf` (one `server { server_name visionguard... }` block; other sites are not touched), `deploy/server-setup.sh`, `deploy/visionguard.service` (systemd alternative, below).

## 2. Deploying a new version
From a Mac with access to the server:
1. `git archive --format=tar.gz -o /tmp/vg-deploy.tgz HEAD server deploy transcriber` (only the folders the server needs).
2. Copy it to the server (`scp`, with the deploy SSH key; you type its passphrase).
3. On the server, as the deploy account (it owns `/opt/visionguard` and is in the `docker` group, so no `sudo` is needed):
   `tar -xzf /tmp/vg-deploy.tgz -C /opt/visionguard && cd /opt/visionguard/deploy && docker compose -p visionguard -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.transcribe.yml up -d --build`
   (leave out the last `-f` file if live captions are not used). The data is in a Docker volume and `deploy/.env` is not in the archive, so both survive.
4. Check `https://visionguard.smartwaygroup.com.sa/healthz`: `{"ok":true,...}`, with `camerasOnline` back to the expected number a minute later.

Camera app builds are published separately (no server restart): `tools/publish-build.sh https://visionguard.smartwaygroup.com.sa` (GUIDE section 8.3). Cameras and docking stations pick them up by themselves.

## 3. Health and monitoring
* `GET /healthz`: database, free disk (`HEALTH_MIN_FREE_PCT`), cameras online. The Docker image has a healthcheck on it.
* `tools/health-watch.sh --install https://visionguard.smartwaygroup.com.sa` installs an outside watcher on a Mac (launchd) that alerts when the site stops answering.
* `tools/loadtest.js` simulates thousands of cameras and dashboards; run it only against a throwaway server.
* Logs: `cd /opt/visionguard/deploy && docker compose -p visionguard logs --tail 200`.

## 3.0 Who may push a live stream

Before, anybody who could reach port 1935 and knew a camera id could push a picture in its place. Now every camera gets its own publish key from the server over its signed-in socket and adds it to its RTMP address (`server/publishkey.js`). `RTMP_PUBLISH_AUTH` in `.env`:

* `warn` (default): a push without a valid key is still allowed, and the log says `without a valid camera key` (once per camera every 10 minutes). Use this until every camera runs a build that sends its key (Dashboard > Updates).
* `on`: a push without the camera's key is refused. A dashboard viewer's play link does not work for pushing either.
* `off`: no check.

**Production has run with `on` since 2026-11-19**: every camera has a build that sends its key. A camera on an older build, or a newly flashed one, cannot stream until it gets the current build (dock or network update).

The key is HMAC(secret, camera id). The secret is `PUBLISH_SECRET`, or one generated on the first start and kept in the data folder (`publish.secret`), so keys survive restarts. Changing it gives every camera a new key the next time it connects.

## 3.0.1 Encrypted live video (RTMPS)

The cameras' live video can travel encrypted. `deploy/docker-compose.rtmps.yml` adds a small nginx container (`visionguard-rtmps`) that takes **RTMPS on port 1936** with the site's Let's Encrypt certificate and passes plain RTMP to VisionGuard inside the private Docker network. With it in the command, the server sends every camera the port with its key (`push_key` carries `rtmpsPort`), and a camera with the current app then pushes to `rtmps://<domain>:1936/live/<camera>?key=...`. The publish key is still checked (section 3.0).

To switch it on:
1. In `.env`: `RTMPS_DOMAIN=visionguard.smartwaygroup.com.sa` (the certificate's domain; the files are read from `/etc/letsencrypt/live/<domain>/`, read only, and reloaded every 12 hours so renewals are picked up).
2. Open TCP 1936 on the host firewall, on the same IP as 1935 (`RTMP_BIND_IP`).
3. Add the file to the usual command: `... -f docker-compose.transcribe.yml -f docker-compose.rtmps.yml up -d --build`.
4. Check: `docker logs visionguard-rtmps` shows one line per camera connection (`sent=... received=...`), and the server log shows the push.

Cameras on an older app ignore the port and keep plain RTMP on 1935. Once every camera runs a build that knows RTMPS (Dashboard > Updates), plain 1935 can be closed to the internet (bind it to `127.0.0.1`), so only encrypted video comes in. Tested end to end with this nginx image and config, a server with `RTMP_PUBLISH_AUTH=on`, and ffmpeg pushes: encrypted with the key works, without the key it is refused (`server/test/rtmps.test.js` covers the server side).

## 3.1 Live captions (optional service)

Speech-to-text for streaming cameras runs as a separate container, never inside the VisionGuard one. To switch it on: put a long random `TRANSCRIBE_TOKEN` in `.env`, then add the third file to the usual command:

`docker compose -p visionguard -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.transcribe.yml up -d --build`

The first start downloads the Whisper model (about 480 MB, `small`) into a volume. The service is limited to 8 CPUs and 6 GB so it cannot starve the other apps on the shared host; it publishes no port. A company only gets captions after Smart Way ticks **Live captions** for it. Check: `docker logs visionguard-transcriber` ("model ready") and, while a camera streams, `curl` is not needed: the text appears under the camera on the dashboard. More in `TRANSCRIBER.md`.

## 4. Backups (what must exist)
Back up, off the server, at least: the database and its journal (`server/data/bwc.db`, `.wal`, `.shm`), `server/data/updates/`, the `.env` file, the licence keys, and (optionally, they are large) the recordings.
* A backup is only real after a **restore test**. Never rely on one nobody has restored.
* The hosting provider may offer its own backup service. Do not rely on it until the provider has confirmed what it covers, the date of the last successful backup, and a test restore.
* Planned: a nightly VisionGuard backup (database and config, recordings optional) to a second location outside this server (another server or object storage), with a monthly restore test. Not built yet.

## 4.1 Moving to a dedicated server
VisionGuard shares its server with another application. To move it: prepare a server (8 vCPU, 16 GB RAM, 500 GB NVMe, a separate volume of 2 TB or more for recordings, a dedicated IP, 1 Gbps; in-kingdom hosting if a customer needs data residency), install Docker, copy `server/data` and `.env`, start the compose project, test, then change the DNS record. Because the cameras use the **domain** (not an IP), no camera has to be touched.

## 5. Before opening to more customers
- Per-camera tokens for every camera, then `ALLOW_SHARED_TOKEN=false` (GUIDE section 14).
- RTMP encryption: built (section 3.0.1). Switch it on, update every camera, then close plain 1935 to the internet. Publish authentication is done (section 3.0).
- Off-server backups with a restore test (section 4).
- Monitoring: the outside watcher (section 3) installed.

## 6. First installation on a fresh server (systemd, without Docker)
```bash
apt install -y nginx certbot python3-certbot-nginx
# Node 22+ (SQLite is built in): https://nodejs.org
useradd -r -m -d /opt/visionguard visionguard
git clone <repo> /opt/visionguard && cd /opt/visionguard/server && npm ci --omit=dev
cp ../.env.example .env   # set BWC_TOKEN, STREAM_SECRET, ADMIN_PASSWORD, PUBLIC_URL
cp ../deploy/visionguard.service /etc/systemd/system/ && systemctl enable --now visionguard
cp ../deploy/nginx-visionguard.conf /etc/nginx/sites-available/visionguard && ln -s /etc/nginx/sites-available/visionguard /etc/nginx/sites-enabled/
certbot --nginx -d visionguard.smartwaygroup.com.sa
ufw allow 80,443,1935/tcp
```
Prerequisites: a DNS `A` record for the host, root or sudo access, a real certificate (Let's Encrypt), and firewall rules for TCP 80, 443 and 1935. Cameras use `https://visionguard.smartwaygroup.com.sa` (`config.json` / `--dart-define=BWC_SERVER`).
