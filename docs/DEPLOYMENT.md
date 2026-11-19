# Deployment (production)

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
1. `git archive --format=tar.gz -o /tmp/visionguard.tar.gz HEAD`
2. Copy it to the server (`scp`, with your SSH key).
3. On the server: unpack into `/opt/visionguard`, then
   `cd /opt/visionguard/deploy && sudo docker compose -p visionguard -f docker-compose.yml -f docker-compose.test.yml up -d --build`
4. Check `https://visionguard.smartwaygroup.com.sa/healthz`: `{"ok":true,...}`, with `camerasOnline` back to the expected number a minute later.

Camera app builds are published separately (no server restart): `tools/publish-build.sh https://visionguard.smartwaygroup.com.sa` (GUIDE section 8.3). Cameras and docking stations pick them up by themselves.

## 3. Health and monitoring
* `GET /healthz`: database, free disk (`HEALTH_MIN_FREE_PCT`), cameras online. The Docker image has a healthcheck on it.
* `tools/health-watch.sh --install https://visionguard.smartwaygroup.com.sa` installs an outside watcher on a Mac (launchd) that alerts when the site stops answering.
* `tools/loadtest.js` simulates thousands of cameras and dashboards; run it only against a throwaway server.
* Logs: `cd /opt/visionguard/deploy && sudo docker compose -p visionguard logs --tail 200`.

## 3.1 Live captions (optional service)

Speech-to-text for streaming cameras runs as a separate container, never inside the VisionGuard one. To switch it on: put a long random `TRANSCRIBE_TOKEN` in `.env`, then add the third file to the usual command:

`docker compose -p visionguard -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.transcribe.yml up -d --build`

The first start downloads the Whisper model (about 480 MB, `small`) into a volume. The service is limited to 2 CPUs and 3 GB so it cannot starve the other apps on the shared host; it publishes no port. A company only gets captions after Smart Way ticks **Live captions** for it. Check: `docker logs visionguard-transcriber` ("model ready") and, while a camera streams, `curl` is not needed: the text appears under the camera on the dashboard. More in `transcriber/README.md`.

## 4. Backups (what must exist)
Back up, off the server, at least: the database and its journal (`server/data/bwc.db`, `.wal`, `.shm`), `server/data/updates/`, the `.env` file, the licence keys, and (optionally, they are large) the recordings.
* A backup is only real after a **restore test**. Never rely on one nobody has restored.
* The hosting provider may offer its own backup service. Do not rely on it until the provider has confirmed what it covers, the date of the last successful backup, and a test restore.
* Planned: a nightly VisionGuard backup (database and config, recordings optional) to a second location outside this server (another server or object storage), with a monthly restore test. Not built yet.

## 4.1 Moving to a dedicated server
VisionGuard shares its server with another application. To move it: prepare a server (8 vCPU, 16 GB RAM, 500 GB NVMe, a separate volume of 2 TB or more for recordings, a dedicated IP, 1 Gbps; in-kingdom hosting if a customer needs data residency), install Docker, copy `server/data` and `.env`, start the compose project, test, then change the DNS record. Because the cameras use the **domain** (not an IP), no camera has to be touched.

## 5. Before opening to more customers
- Per-camera tokens for every camera, then `ALLOW_SHARED_TOKEN=false` (GUIDE section 14).
- RTMP publish authentication and encryption (open item, because port 1935 is public).
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
