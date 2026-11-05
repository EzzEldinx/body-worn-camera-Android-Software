#!/usr/bin/env bash
# VisionGuard first-time setup on a shared Ubuntu host. Run as an admin: sudo bash server-setup.sh <dedicated-ip> [--test-http]
# - does NOT touch nginx, existing containers, or existing firewall rules (it only adds one port if ufw is active)
# - expects the release tarball at /home/deploy/visionguard.tar.gz (copied with scp)
set -euo pipefail
IP="${1:?usage: sudo bash server-setup.sh <dedicated-ip> [--test-http]}"
TEST="${2:-}"
APP=/opt/visionguard

echo "== 1/5 deploy user -> docker group (takes effect on next login)"
usermod -aG docker deploy

echo "== 2/5 app directory"
install -d -o deploy -g deploy "$APP"
sudo -u deploy tar -xzf /home/deploy/visionguard.tar.gz -C "$APP"

echo "== 3/5 configuration (kept if it already exists)"
ENVF="$APP/deploy/.env"
if [ ! -f "$ENVF" ]; then
  sudo -u deploy bash -c "umask 077; cat > '$ENVF' <<ENV
BWC_TOKEN=\$(openssl rand -hex 24)
STREAM_SECRET=\$(openssl rand -hex 24)
DOCK_TOKEN=\$(openssl rand -hex 24)
ADMIN_PASSWORD=\$(openssl rand -hex 12)
RTMP_BIND_IP=$IP
ENV"
  echo "   created $ENVF (secrets generated; read them with: sudo -u deploy cat $ENVF)"
fi

echo "== 4/5 firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 1935/tcp comment 'VisionGuard RTMP'
  [ "$TEST" = "--test-http" ] && ufw allow 3000/tcp comment 'VisionGuard TEST http'
else
  echo "   ufw is not active: make sure TCP 1935 (and 3000 for the test) is open in the provider firewall"
fi

echo "== 5/5 start (isolated compose project 'visionguard')"
cd "$APP/deploy"
FILES=(-f docker-compose.yml)
[ "$TEST" = "--test-http" ] && FILES+=(-f docker-compose.test.yml)
docker compose -p visionguard "${FILES[@]}" up -d --build
sleep 5
docker ps --filter name=visionguard --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -s -o /dev/null -w "local health: HTTP %{http_code}\n" http://127.0.0.1:3100/login.html
echo "Done. Existing services were not modified."
