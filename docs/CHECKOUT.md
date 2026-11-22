# Employees and camera check-out

Every employee has their own **username and password**. To take a camera they sign in at the **check-out station** next to the dock; the system picks a camera that
is charged and ready, lights up its bay, and records who took it. The camera then stamps **date and time, camera ID and the employee's ID** on everything it records.
Code: `server/checkout.js`, `server/public/station.html`, Docking → *Check-out*, Companies → *Employees*.

## 1. Set it up (once)

1. **Companies → (company) → Employees.** Add people one by one (name, employee number) or paste a list (*Add many employees*: `Name, number` per line).
   The username defaults to the employee number; each person gets a random password. You get a **sheet of logins** (copy / CSV) shown once.
2. Make sure the **Dock Agent** is running on the dock PC (the page says *Dock online*).
3. On the dock PC (or a tablet) open **`/station.html`** full screen (F11) and leave it there. (Docking → Check-out has the link and the two settings.)

Employee accounts open **only the station**: they cannot sign in to the dashboard or the apps. Dashboard users (supervisors) are separate accounts.

## 2. What the employee does

1. Types username and password. 2. Sees **their camera** (the one they used last if it is ready, else the best online one with the fullest battery) and the dock with its **bay lit up**.
3. Presses **Take**. (*Choose another* lists the other ready cameras.) 4. Takes the camera from that bay. At the end of the shift puts it back on any dock: the shift closes by itself.

The station signs the person out after 90 seconds without a touch, locks a username after 5 wrong passwords (5 minutes), and shows nothing about anyone else.

## 3. The rules

* **Ready** = on a dock (its agent reported in the last 30 s), state *connected* or *synced* (not copying files, not updating, no error), battery ≥ **30 %** (setting), not already issued, and belongs to the employee's company (Smart Way staff may take any).
* One camera per employee. Asking again returns the same reservation.
* **reserved** → the camera is still on the dock; it lapses after **10 minutes** (setting) if nobody takes it.
* **in use** → the camera was missing from every dock for 20 s. **returned** → it sat on a dock for 5 s again. (USB hiccups do not start or end a shift.) Nothing is decided while the dock itself is offline.
* A supervisor can close any shift (*Return now*), and switching an employee off or removing them closes theirs.
* While an employee has a camera the **holder** of that camera is the employee (a name typed by hand is kept aside and comes back afterwards).

## 4. Where it shows

* **Live dashboard, map bubbles, apps:** the camera's holder (name, number, *reserved / carrying*). An **SOS remembers who carried the camera** when it was pressed.
* **Docking → Check-out:** who has what right now (since when, battery out), history with filters and **CSV**.
* **Analytics:** *On duty* gauge (cameras carried / ready now); **PDF report** section *Camera custody* (who took which camera, when, how long); every step in the **audit trail** (`camera_checkout`, `camera_picked_up`, `camera_returned`, `checkout_cancelled`, `employee_*`).

## 5. What the camera does (built in the camera app, `app/`)

**Implemented and verified on a real camera (2026-11-12).** The stamp is drawn by the camera's GL pipeline (`setOverlayText` in the `rtmp_broadcaster` plugin, text from `stampText()` in `central_link.dart`), so it is in the live stream, in every recording segment and in photos, and is updated every second:
```
2026-11-09 14:32:05
CAM BWC-05-RIY  USER 0147
GPS 24.71234, 46.67345          (GPS NO FIX when there is no recent fix)
<company name, if any>
```
`NO USER` is shown when nobody has checked the camera out. The employee number is used, or the username when there is none. Arabic names are kept in the server records, not on the picture.

How the camera gets its information:

* **`assignment`** (server to camera, on connect, on every change and on `get_assignment`): `{ active: true, id, userId, username, name, employeeNo, since, status: "reserved"|"in_use", serverTime }` or `{ active: false, serverTime }`.
* **Clock:** the camera uses `serverTime` to correct its own clock (offset), so the stamp is right even if the camera's clock is wrong.
* **Battery:** the camera sends `camera_battery { cameraId, battery: 0-100, charging: bool }` (also accepted inside `camera_status` and `camera_gps_update`) on change and at least every 2 minutes. Under 20 % and not charging raises the dashboard alert; the dock's USB reading is used while docked.
* **No network at the dock:** the Dock Agent can read `GET /api/dock/assignments` (header `x-dock-token`) and copy the assignment onto the camera over USB. This part is **not built yet** (the camera currently needs its own connection to receive the assignment).

## 6. API

| | |
|---|---|
| `GET /api/station/status` | public counts for the idle screen |
| `POST /api/station/login` `{username,password}` | → `{token, user, ready[], notReady[], suggested, holding}` |
| `POST /api/station/issue` `{token, cameraId?}` · `/return` · `/state` · `/logout` | |
| `GET /api/assignments?status=open&from&to&camera&user` · `GET /api/assignments/export.csv` | dashboards, company-scoped |
| `POST /api/assignments/:id/end` | supervisor closes a shift |
| `GET/PUT /api/checkout/settings` | minimum battery, reservation time (administrators) |
| `POST /api/admin/companies/:id/employees` `{employees:[{name,employeeNo,username?,password?}]}` · `PATCH /api/admin/users/:id` | create / edit / switch off |
