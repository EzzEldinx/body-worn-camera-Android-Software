# Deployment (production)

Target address: **https://visionguard.smartwaygroup.com.sa**

## Prerequisites (checklist)
- [ ] DNS: an `A` record for `visionguard` pointing to the production server
- [ ] SSH/root access to the server (VisionGuard needs a long-running Node.js process, so plain shared hosting is not enough)
- [ ] A real TLS certificate (Let's Encrypt), not self-signed
- [ ] Firewall: allow TCP 80, 443 and 1935 (RTMP video from cameras)

## Install (Ubuntu/Debian, as root)
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
Then set cameras' `server` to `https://visionguard.smartwaygroup.com.sa` (cameras.json / `--dart-define=BWC_SERVER`).

## Before going live
- Per-camera tokens for every camera, then `ALLOW_SHARED_TOKEN=false` (see GUIDE section 14).
- RTMP publish authentication (follow-up) because port 1935 is public.
- Back up `server/data/` daily.

## Docker (recommended on a shared host)
`deploy/docker-compose.yml` runs VisionGuard as an isolated Compose project (own network, own data volume, ports
3100/8100 on localhost, RTMP 1935 on a dedicated IP). nginx gets one extra `server { server_name visionguard... }` block
(see `deploy/nginx-visionguard.conf`); existing sites are not touched. `docker compose -p visionguard up -d --build`.
