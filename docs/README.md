# VisionGuard documentation

All guides live in this folder. Last reviewed: 2026-11-23. Every document shows its own **Last updated** date at the top; "reviewed ... still current" means it was checked against the code on that day and nothing had changed.

| Document | Read it to... | Audience |
|---|---|---|
| [GUIDE.md](GUIDE.md) | run and support the whole system: dashboard, cameras, updates, docking, geofences, reports, problems, security | Operations, support |
| [DEPLOYMENT.md](DEPLOYMENT.md) | deploy and monitor the production server, backups, moving to a dedicated server | Engineers |
| [CAMERA_APP.md](CAMERA_APP.md) | build, configure and publish the camera app | Engineers |
| [CAMERA_SIGNING.md](CAMERA_SIGNING.md) | protect and use the camera signing key, migrate old cameras | Engineers (confidential practice) |
| [DOCK_AGENT.md](DOCK_AGENT.md) | install and run the docking station agent, storage folders | Engineers, installers |
| [CHECKOUT.md](CHECKOUT.md) | employees and camera check-out, the stamp on the picture, the API | Operations, engineers |
| [LICENSING.md](LICENSING.md) | issue and renew licences for customer-hosted installations | Smart Way staff |
| [MOBILE_APP.md](MOBILE_APP.md) | the owner app (iPhone, iPad, Android, Mac): design, API, status | Engineers, product |
| [STORE_PUBLISHING.md](STORE_PUBLISHING.md) | put the owner app in the App Store and Google Play | Engineers |
| [STORE_LISTING.md](STORE_LISTING.md) | the store listing text (English and Arabic) | Product |
| [TRANSCRIBER.md](TRANSCRIBER.md) | the live captions service (speech-to-text): how it works, settings, measured speed, limits | Engineers |
| [How to use VisionGuard.pdf](<How to use VisionGuard.pdf>) | the plain-language handover guide for the people who run VisionGuard every day (exported 2026-11-17 from the shared Docs document; **needs a refresh** for Profile and access, Choose folder, the company ceiling, the HTTPS switch, live captions, the Mac app and the Chat tab) | Non-programmers |
| [client-brochure/](client-brochure) | the client guide for customers (PDF, and the HTML source it is built from) | Customers, sales |

Other files in the repository root: `README.md` (overview and quick start), `SECURITY.md` (reporting vulnerabilities and the hardening list), `CONTRIBUTING.md`. Each code folder (`app/`, `client/`, `server/`, `dock-agent/`, `transcriber/`) has a short README that points here. `app/packages/rtmp_broadcaster/` (the camera plugin) keeps its own README, CHANGELOG and AGENTS.md.

## Keeping the documents current
Update the document in the same change as the feature. After a feature, check at least: GUIDE.md (how it is used), the client brochure (what a customer sees), and the relevant technical document. The client brochure PDF is rendered from its HTML with headless Chrome:
```bash
cd docs/client-brochure
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer --print-to-pdf=VisionGuard-Client-Guide.pdf "file://$PWD/VisionGuard-Client-Guide.html"
```
