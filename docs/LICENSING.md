# VisionGuard licensing

For installations that run **on the customer's own server** (a government body, a large company). Smart Way's own hosted servers need no licence
(`LICENSE_MODE=off`, the default). Code: `server/license-core.js`, `server/license.js`, the vendor tool `tools/license/vg-license.js`, the page `/license.html`.

## 1. The idea in one picture

```
 Smart Way (licence desk, your Mac)                        Customer's server (offline is fine)
 ┌───────────────────────────────┐   renewal request (.vgreq)   ┌────────────────────────────┐
 │ private signing key (secret)  │ ◄─────────────────────────── │ License page → Request     │
 │ vg-license.js issue / renew   │                              │ knows: its installation ID │
 │ ledger: who, term, expiry     │ ───────────────────────────► │ public key → verifies      │
 └───────────────────────────────┘   licence file (.vglic)      │ License page → Install     │
                                                                 └────────────────────────────┘
```

* A **licence** is a small signed file: customer, term, limits, features. Only Smart Way can sign it (Ed25519). The server carries the matching **public** key
  and checks it **offline**, so it works inside a closed network and cannot be edited or extended by the customer.
* A licence is issued for **one installation** (its installation ID, a fingerprint shown on the License page). A licence file given to someone else is useless.
* Nothing is sent to Smart Way automatically. The customer's administrator exports a **renewal request** and sends it to us (e-mail, portal, USB).
  That is the point of control: **they come to us to renew**, every 3, 6, 12, 24 or 36 months.

## 2. Terms and what a licence contains

| Term | Use it for |
|---|---|
| **3 months** | pilot / proof of concept after the free 30-day trial |
| **6 months** | first project phase |
| **12 months** | the normal government contract (recommended default: one yearly check-in) |
| **24 / 36 months** | multi-year frameworks; the customer is locked in, but you cannot recall the licence before it ends, so price accordingly |

A term starts at 00:00 UTC on its first day and ends at 23:59:59 UTC on its last: 12 months from 10 Nov 2026 end on 9 Nov 2027.
A renewal issued before the end **continues where the old term ends** (no days lost or doubled).

| Field | Meaning |
|---|---|
| `customer`, `serial` | who it is for; `VG-2026-000001` (numbered by your ledger) |
| `installId` | the installation it is bound to (`*` = any, for testing only) |
| `graceDays` | days after the end that everything still works (default **30**) |
| `afterExpiry` | `restricted` (default) or `locked`, what happens after the grace period |
| `limits` | `cameras`, `users` (dashboard accounts), `employees` (check-out accounts), `companies`, `live` (streams at once). Missing = unlimited |
| `features` | `reports`, `ai`, `docking`, `checkout`, `mobile`. Missing = all |
| `edition`, `contact` | free text (e.g. `gov`, the customer's IT mailbox) |

## 3. The life of a licence

| State | When | What the system does |
|---|---|---|
| **trial** | no licence yet, first 30 days (`LICENSE_TRIAL_DAYS`) | everything works, up to 10 cameras (`LICENSE_TRIAL_CAMERAS`); banner counts the days down |
| **valid** | licence in force | everything works within the limits |
| **expiring** | 30 days or fewer left | as valid; amber banner for administrators (everybody at 7 days); reminders by e-mail at 60/30/14/7/3/1 days |
| **grace** | ended, inside `graceDays` | **everything still works**; red banner for every user |
| **restricted** | grace over, or no licence after the trial | **safety keeps working**, growth and export stop (see below) |
| **locked** | like restricted, only if the licence says `afterExpiry: locked` | dashboards cannot sign in; cameras and docks still deliver evidence; only the License page opens |

**Restricted mode refuses:** new companies, dashboard users, employees, cameras (and camera tokens), regions, app-update uploads, dock/check-out settings,
**PDF reports, CSV exports, the AI analysis**. A licence's limits and features are enforced the same way while it is valid.

**Never refused, in any state:** a camera connecting, GPS, **SOS and its notification**, live view, the evidence cameras and docks upload,
signing in, support tickets, installing a new licence. A body-camera system is a safety system: it must not switch itself off at an incident.

An administrator who installs a new licence ends restricted/locked mode **at once** (no restart).

## 4. Workflows

**First installation.** Install VisionGuard with `LICENSE_MODE=enforce`. The 30-day trial starts. Before it ends the customer asks for a licence:

1. Administrator opens **License**, picks the term, presses **Download request file** (or **Copy request text**) and e-mails it to `sdpt@smart-way.com.sa`.
2. You open it on your Mac: `node tools/license/vg-license.js inspect req.vgreq` (shows who asks and the signed proof it is genuine), then
   `node tools/license/vg-license.js issue --customer "Ministry of X" --term 12m --request req.vgreq --limits cameras=300,employees=800,users=40,companies=6,live=40 --edition gov --contact it@moi.gov.sa --out MOI.vglic`.
3. You send `MOI.vglic` back. The administrator drops it on **License → Install a licence**. Done, offline.

**Renewal.** Reminders start 60 days before the end. The customer sends a new request; you run
`node tools/license/vg-license.js renew VG-2026-000001 --term 12m --request req.vgreq` (same customer and limits, starts where the old term ends; add `--limits ...` to enlarge).

**Your renewal calendar.** `node tools/license/vg-license.js list --soon 90` lists every customer by expiry with *renew now / in grace / LIMITED MODE*. Run it every Sunday.

**More cameras mid-term.** Issue a new licence for the same installation with the bigger limits (`renew` with `--limits`, `--term` of the remaining time or a fresh one).

**Server replaced.** A copy of the data keeps the installation ID, so the licence keeps working. A fresh installation has a new ID: the customer sends a new request from it and you issue a new licence (that is also how we stop one licence being used on two servers).

**Lost or stolen licence file.** Harmless: it only works for that installation and ends on its date.

## 5. The licence desk (your Mac)

Files live in `~/.visionguard/license/` (or `$VG_LICENSE_DIR`): `vendor-private.pem` **secret**, `vendor-public.pem`, `ledger.jsonl` (every licence ever issued), `issued/` (a copy of every file).

```bash
node tools/license/vg-license.js keygen     # once. Already done on this Mac (key id sw-8a40c1ed)
node tools/license/vg-license.js issue --customer "..." --term 12m --request req.vgreq [--limits ...] [--features ...] [--grace 30] [--after locked] [--start 2026-12-01]
node tools/license/vg-license.js renew VG-2026-000001 --term 12m [--request req.vgreq]
node tools/license/vg-license.js inspect <file.vglic|file.vgreq>
node tools/license/vg-license.js list --soon 90
node tools/license/vg-license.js pubkey     # the line for server/license-pubkey.js
```

**Key custody.** Back up `vendor-private.pem` in two offline places (like the camera keystore). Whoever holds it can issue licences; if it is lost no renewal can ever
be issued for servers already installed. **Rotation:** add the new public key to `server/license-pubkey.js` (keep the old one), ship the update, then issue with the new key.

## 6. Settings (server `.env`)

| Variable | Default | |
|---|---|---|
| `LICENSE_MODE` | `off` | `off` = Smart Way hosted. **Customer installations: `enforce`** |
| `LICENSE_TRIAL_DAYS` | `30` | trial with no licence (`0` = no trial) |
| `LICENSE_TRIAL_CAMERAS` | `10` | camera limit during the trial |
| `LICENSE_NOTIFY` | | extra e-mail addresses for expiry reminders (Smart Way's support address always gets them; needs `SMTP_*`) |

## 7. How strong is it, honestly

* **Cannot be forged or extended by editing the file**: signature. **Cannot be moved to another installation**: the ID is inside the signed text.
* **Clock set back to dodge the end**: the server remembers the latest time it has seen (and the audit trail holds sealed timestamps); more than 2 days behind means *limited mode*.
* **The customer owns the machine.** Anyone who can edit the server's source can remove the check. Do not rely on code alone for a hostile customer: deliver the
  government build as a **compiled/obfuscated Docker image** (no readable source), keep `LICENSE_MODE=enforce` baked in, and keep the contract (licence terms, audit rights) behind it.
  A stronger, planned step: the camera and mobile apps (signed binaries you control) refuse to talk to a server that cannot show a valid licence.
* Revocation before the end is not possible offline. That is why government licences should be 12 months, not 3 years, unless the contract says otherwise.
