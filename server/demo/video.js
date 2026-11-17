'use strict';
// Live video for the demo cameras: no real footage, no copyrighted footage, nothing recorded anywhere.
//   1. a few looping clips are drawn by ffmpeg itself (a street seen from a walking or driving officer: scrolling skyline, a road, a little hand-held sway,
//      film grain, a "sample footage" stamp). They are made once, at build time (make-video.js) or at the first start;
//   2. when a dashboard wants to see a camera (or a camera is "recording"), the clip is published to the demo's own RTMP port under that camera's name,
//      without being re-encoded (-c copy), so a stream costs almost no processor. The page cannot tell it from a real camera.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const W = 480, H = 270, FPS = 12, SECONDS = 36;     // 36 s: every scrolling layer travels a whole number of tiles, so the loop has no visible jump
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'].find((f) => fs.existsSync(f));

// name, speed (1 walking, 2 driving), brightness, chroma (cb, cr: the tint), seed (a different skyline)
const VARIANTS = [
    { name: 'street-day', speed: 1, bright: 1.0, cb: 128, cr: 128, seed: 0.0 },
    { name: 'street-dusk', speed: 1, bright: 0.68, cb: 118, cr: 140, seed: 3.1 },
    { name: 'mall-night', speed: 1, bright: 0.44, cb: 111, cr: 111, seed: 6.2 },
    { name: 'drive-day', speed: 2, bright: 0.96, cb: 131, cr: 124, seed: 9.4 },
    { name: 'yard-overcast', speed: 1, bright: 0.86, cb: 126, cr: 131, seed: 12.6 },
    { name: 'drive-dusk', speed: 2, bright: 0.62, cb: 121, cr: 137, seed: 15.7 },
];

/** The luminance of every pixel as an ffmpeg expression (geq): sky, two layers of buildings scrolling at different speeds, a road with a dashed centre line.
 *  Written for a 640x360 picture and scaled to W x H; the scrolling layers travel a whole number of building widths in SECONDS, so the loop is seamless. */
function lumExpression(v) {
    const k = v.speed, S = v.seed, sc = H / 360, n = (x) => +(x * sc).toFixed(3);
    const F1 = n(20 * k), F2 = n(37.3333333 * k), P1 = 20 * k, P2 = 16 * k, hy = Math.round(H * 0.47), depthMax = H - hy;
    const rnd = (a, mul, big) => `mod(abs(sin(${a}*${mul}+${S})*${big}),1)`;
    const lit = `gt(${rnd(`floor((X+T*${F2})/${n(21)})*7.31+floor(Y/${n(22)})*3.17`, 1, 437.585)},0.5)*lt(mod(X+T*${F2},${n(21)}),${n(12)})*lt(mod(Y,${n(22)}),${n(12)})`;
    return [
        `st(0,Y-${hy})`,                                                              // depth below the horizon (negative = above it)
        `st(1,mod(floor((X+T*${F1})/${n(36)}),${P1}))`,                               // far skyline: which block
        `st(2,${n(28)}+${n(80)}*${rnd('ld(1)', 12.9898, 43758.5453)})`,               //   and how tall
        `st(3,mod(floor((X+T*${F2})/${n(84)}),${P2}))`,                               // near buildings: which block
        `st(4,${n(70)}+${n(115)}*${rnd('ld(3)', 39.3461, 43758.5453)})`,              //   and how tall
        `st(5,mod(X+T*${F2},${n(84)}))`,                                              //   where inside the block (a gap between two buildings)
        `st(7,ld(0)+1)`,                                                              // road: depth
        `st(8,${n(18)}+1.25*ld(7))`,                                                  //   half width, growing towards the viewer
        `st(9,abs(X-${W / 2}))`,                                                      //   distance from the middle
        `clip(${v.bright}*if(lt(ld(0),0),`
        + `if(lt(ld(5),${n(78)})*gt(Y,${hy}-ld(4)),${52}+${30}*${rnd('ld(3)', 19.31, 9876.54)}+if(${lit},95,0),`   // a near building, some windows lit
        + `if(gt(Y,${hy}-ld(2)),${92}+${26}*${rnd('ld(1)', 78.233, 12345.6789)},${150}+${55}*Y/${hy})),`         // a far building, or the sky
        + `if(lt(ld(9),ld(8)),`
        + `if(lt(ld(9),${n(1.5)}+ld(7)*0.02)*lt(mod(${n(1500)}/ld(7)-T*${7 * k},2),1),215,${62}+${30}*ld(7)/${depthMax}),`   // the road and its dashes
        + `if(lt(abs(ld(9)-ld(8)),${n(2.5)}),185,${122}+${40}*ld(7)/${depthMax}))),0,255)`,                                 // the kerb and the pavement
    ].join(';');
}

/** The ffmpeg arguments that draw one clip. */
function clipArgs(v, out) {
    const text = FONT ? `,drawtext=fontfile=${FONT}:text='VisionGuard demo - sample footage':x=10:y=h-24:fontsize=13:fontcolor=white@0.75:box=1:boxcolor=black@0.35:boxborderw=4`
        + `,drawtext=fontfile=${FONT}:text='REC':x=w-52:y=12:fontsize=14:fontcolor=red:enable='lt(mod(t,2),1.3)'` : '';
    const graph = `color=c=gray:s=${W}x${H}:r=${FPS}:d=${SECONDS},format=yuv420p,geq=lum='${lumExpression(v)}':cb=${v.cb}:cr=${v.cr},`
        + `noise=alls=6:allf=t+u,vignette=PI/5,crop=w=${Math.round(W * 0.94)}:h=${Math.round(H * 0.94)}:x='${Math.round(W * 0.03)}+${Math.round(W * 0.014)}*sin(2*PI*t)+${Math.round(W * 0.006)}*sin(4*PI*t)':y='${Math.round(H * 0.03)}+${Math.round(H * 0.017)}*sin(4*PI*t)+${Math.round(H * 0.006)}*sin(6*PI*t)',`
        + `scale=${W}:${H}${text},format=yuv420p`;
    return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', graph, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-profile:v', 'main', '-bf', '0',
        '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out];
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 600000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
});

/** Draws the clips into `dir` (loop-1.mp4 ... loop-6.mp4, sample.mp4, sample.jpg). Skips the ones that exist. */
async function generate(dir, { ffmpeg = 'ffmpeg', log = console, only } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const wanted = VARIANTS.slice(0, only || VARIANTS.length);
    for (let i = 0; i < wanted.length; i++) {
        const f = path.join(dir, `loop-${i + 1}.mp4`);
        if (fs.existsSync(f)) continue;
        const t = Date.now(), tmp = f + '.part.mp4';
        await run(ffmpeg, clipArgs(wanted[i], tmp));
        fs.renameSync(tmp, f);
        log.log(`demo video: ${wanted[i].name} drawn in ${Math.round((Date.now() - t) / 1000)} s`);
    }
    const first = path.join(dir, 'loop-1.mp4'), clip = path.join(dir, 'sample.mp4'), still = path.join(dir, 'sample.jpg');
    if (fs.existsSync(first) && !fs.existsSync(clip)) await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', first, '-t', '14', '-c', 'copy', '-movflags', '+faststart', clip]);
    if (fs.existsSync(first) && !fs.existsSync(still)) await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '6', '-i', first, '-frames:v', '1', '-q:v', '4', still]);
}

class Video {
    /** dirs: where to look for finished clips, the last one is where they are made when none are found. */
    constructor({ rtmpPort, dirs, max = 6, ffmpeg = process.env.DEMO_FFMPEG || 'ffmpeg', log = console }) {
        Object.assign(this, { rtmpPort, dirs, max, ffmpeg, log });
        this.dir = null; this.available = false; this.ready = false;
        this.procs = new Map();      // camera -> { child, started, variant }
        this.stopped = false;
        this.starting = this.init();
    }
    async init() {
        try { await run(this.ffmpeg, ['-version'], { timeout: 15000 }); this.available = true; }
        catch { this.log.warn('demo video: ffmpeg was not found, so live pictures are not available (the rest of the demo works). Use the demo image of deploy/ to get video.'); return; }
        this.dir = this.dirs.find((d) => d && fs.existsSync(path.join(d, 'loop-1.mp4'))) || null;
        if (!this.dir) {
            this.dir = this.dirs[this.dirs.length - 1];
            this.log.log(`demo video: drawing the clips into ${this.dir} (this takes a few minutes the first time)`);
            try { await generate(this.dir, { ffmpeg: this.ffmpeg, log: this.log }); } catch (e) { this.log.warn('demo video: could not draw the clips:', String(e.stderr || e.message).slice(0, 300)); this.available = false; return; }
        }
        this.ready = true;
    }
    sampleClip() {
        if (!this.dir) return null;
        const mp4 = path.join(this.dir, 'sample.mp4'), jpg = path.join(this.dir, 'sample.jpg');
        return fs.existsSync(mp4) ? { mp4, jpg: fs.existsSync(jpg) ? jpg : null } : null;
    }
    count() { return this.procs.size; }
    has(id) { return this.procs.has(id); }
    /** Start publishing a clip as the picture of camera `id` (nothing happens when it already is, or when there is no ffmpeg). */
    start(id, variant = 0) {
        if (!this.ready || this.stopped) return false;
        const hit = this.procs.get(id); if (hit) { hit.touched = Date.now(); return true; }
        while (this.procs.size >= this.max) {   // the stream that has run longest makes room
            const oldest = [...this.procs.entries()].sort((a, b) => a[1].started - b[1].started)[0];
            if (!oldest) break; this.stop(oldest[0]);
        }
        const n = (variant % VARIANTS.length) + 1, file = path.join(this.dir, `loop-${n}.mp4`);
        if (!fs.existsSync(file)) return false;
        const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', file, '-c', 'copy', '-flvflags', 'no_duration_filesize', '-f', 'flv', `rtmp://127.0.0.1:${this.rtmpPort}/live/${id}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        const rec = { child, started: Date.now(), touched: Date.now(), variant, err: '' };
        child.stderr.on('data', (d) => { rec.err = (rec.err + d).slice(-400); });
        child.on('error', () => this.procs.delete(id));
        child.on('exit', () => {
            if (this.procs.get(id) === rec) { this.procs.delete(id); if (!this.stopped && rec.restart !== false) setTimeout(() => { if (!this.procs.has(id) && this.wanted?.has(id)) this.start(id, variant); }, 2500).unref(); }
        });
        this.procs.set(id, rec);
        return true;
    }
    stop(id) {
        const rec = this.procs.get(id); if (!rec) return;
        rec.restart = false; this.procs.delete(id);
        try { rec.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    stopAll() { this.stopped = true; for (const id of [...this.procs.keys()]) this.stop(id); }
}

module.exports = { Video, generate, clipArgs, lumExpression, VARIANTS, W, H, FPS, SECONDS };
