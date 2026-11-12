'use strict';
// What a docked camera says on its OWN screen: "Connected, checking...", "Updating the camera software", "Uploading recordings 2 of 5",
// "All done", "Needs attention". The Dock Agent writes this as a small JSON file into the camera app's folder over USB (every few seconds
// while there is something to say) and the camera app (app/lib/core/services/dock_sync.dart) shows it full screen while the file is fresh.
//
// The words come from here, so they can change without a new camera build. The camera only knows the phase (icon and colour):
//   connected | updating | uploading | done | attention
//
// Pure logic, no adb and no clock of its own: see test/screen.test.js.

const FILE = 'dock-status.json';
const TMP = '.dock-status.tmp';
const T = {
    done: 8_000,          // "All done" stays this long after the work ended
    upToDate: 4_000,      // "Up to date" after the first check when there was nothing to do
    attention: 12_000,    // an error is shown this long, once, so a camera that stays in error does not nag on every cycle
    checkMax: 25_000,     // "Connected, checking..." never stays longer than this
};

const doneText = (did) => (did.has('update') && did.has('upload') ? 'Software updated and recordings uploaded'
    : did.has('update') ? 'Camera software updated' : 'Recordings uploaded');

function create() {
    const mem = new Map();   // serial -> what this camera's window did so far
    const of = (serial, t) => {
        let m = mem.get(serial);
        if (!m) { m = { since: t, did: new Set(), until: 0, text: '', err: null, checked: false }; mem.set(serial, m); }
        return m;
    };
    return {
        // The camera left the dock: the next time it comes back it gets its "Connected" window again.
        forget(serial) { mem.delete(serial); },

        // input: { state, message, progress, check, partBytes } = the agent's status for this camera.
        //   check: 'current' (the app is the latest build) | 'other' (checked, nothing to show) | undefined (not checked yet)
        //   partBytes: bytes of the file being copied right now (so the bar moves inside a big file)
        // Returns what the screen should say, or null when it should say nothing.
        view(serial, input, t = Date.now()) {
            const { state, message, progress, check, partBytes = 0 } = input || {};
            const m = of(serial, t);
            // once anything real has been shown the camera is "known": the first-contact window never comes back (until it leaves and returns)
            if (state === 'updating' || state === 'offloading' || state === 'error') m.checked = true;
            if (state === 'updating') {
                m.did.add('update'); m.err = null; m.until = 0;
                return { phase: 'updating', title: 'Updating the camera software', detail: 'Please wait. Do not unplug the camera.' };
            }
            if (state === 'offloading') {
                m.did.add('upload'); m.err = null; m.until = 0;
                const p = progress || {}, total = p.total || 0, index = Math.max(1, Math.min(p.index || 1, total || 1));
                const share = p.bytesTotal > 0 ? Math.min(1, ((p.bytesDone || 0) + partBytes) / p.bytesTotal) : null;
                return {
                    phase: 'uploading', title: 'Uploading recordings',
                    detail: total > 1 ? `File ${index} of ${total}` : 'Please wait. Do not unplug the camera.',
                    current: index, total, percent: share === null ? null : Math.min(99, Math.floor(share * 100)),
                };
            }
            // idle from here on
            if (state === 'error') {
                if (!m.err || m.err.message !== message) m.err = { message, at: t };
                if (t - m.err.at <= T.attention) {
                    m.did.clear();
                    return { phase: 'attention', title: 'Needs attention', detail: String(message || 'Ask your supervisor.').slice(0, 90) };
                }
            } else m.err = null;
            if (m.did.size) { m.until = t + T.done; m.text = doneText(m.did); m.did.clear(); m.checked = true; }
            if (m.until > t) return { phase: 'done', title: 'All done', detail: m.text };
            if (!m.checked) {
                if (check === 'current') { m.checked = true; m.until = t + T.upToDate; m.text = 'Everything is up to date'; return { phase: 'done', title: 'All done', detail: m.text }; }
                if (check === 'other') { m.checked = true; return null; }
                if (t - m.since < T.checkMax) return { phase: 'connected', title: 'Docking station', detail: 'Connected. Checking this camera...' };
                m.checked = true;
            }
            return null;
        },
    };
}

const encode = (view, t = Date.now()) => JSON.stringify({ v: 1, ...view, ts: t });

// Shell commands for the camera. The JSON travels as base64 so no quote or space in a message can break the command; the file is
// written under a temporary name and renamed, so the camera never reads half a file.
const writeCommand = (dir, body) => `echo ${Buffer.from(body).toString('base64')} | base64 -d > ${dir}/${TMP} && mv ${dir}/${TMP} ${dir}/${FILE}`;
const clearCommand = (dir) => `rm -f ${dir}/${FILE}`;

module.exports = { create, encode, writeCommand, clearCommand, FILE, T };
