# Security Policy

Last updated: 2026-11-23

Report vulnerabilities privately to the Smart Way Group engineering team
(e.ahmed@smart-way.com.sa). Do not open public issues for security problems.

## What is in place
Per-camera device tokens, per-company access with a ceiling set by Smart Way, HTTPS for the website, cameras, docking stations and mobile apps,
signed and expiring stream links, a sealed (hash-chained) audit trail, and signed licences. See `docs/GUIDE.md` sections 3, 8.3d, 11 and 14.

## Two-step sign-in and company directories
* **Two-step sign-in (MFA)** is built: authenticator-app codes (TOTP, RFC 6238) and one-time recovery codes, on the web and in the apps (`docs/GUIDE.md` section 8.3j-2).
* **Sign-in with a company directory (SSO)** is not built. It lets a customer's staff sign in with the account they already use at work (Microsoft Entra ID / Active Directory, Okta, or a government identity provider), so the customer creates, blocks and removes people in one place. The plan: OpenID Connect first (Microsoft Entra ID and most modern providers), SAML 2.0 for older ones; per company, users matched by e-mail or username and given a VisionGuard role from their directory group. It needs, from each customer, the provider's details (issuer, client id and secret, or SAML metadata) and a test account.

## Known open items (hardening roadmap)
* Live video: encrypted RTMPS on port 1936 is built (`docs/DEPLOYMENT.md` section 3.0.1); plain RTMP on 1935 stays open for cameras on older apps until every camera is updated. Since 2026-11-19 a push without the camera's own key is refused (`RTMP_PUBLISH_AUTH=on`).
* The old shared camera token still works until `ALLOW_SHARED_TOKEN=false` is set (after every camera has its own token).
* Off-server, tested backups of the database and recordings (see `docs/DEPLOYMENT.md`, Backups).
* Secrets through a secret manager instead of `.env` files.
