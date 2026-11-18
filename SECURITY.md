# Security Policy

Report vulnerabilities privately to the Smart Way Group engineering team
(e.ahmed@smart-way.com.sa). Do not open public issues for security problems.

## What is in place
Per-camera device tokens, per-company access with a ceiling set by Smart Way, HTTPS for the website, cameras, docking stations and mobile apps,
signed and expiring stream links, a sealed (hash-chained) audit trail, and signed licences. See `docs/GUIDE.md` sections 3, 8.3d, 11 and 14.

## Known open items (hardening roadmap)
* RTMP video (port 1935) is neither encrypted nor checked with the camera token yet.
* The old shared camera token still works until `ALLOW_SHARED_TOKEN=false` is set (after every camera has its own token).
* Off-server, tested backups of the database and recordings (see `docs/DEPLOYMENT.md`, Backups).
* Secrets through a secret manager instead of `.env` files.
