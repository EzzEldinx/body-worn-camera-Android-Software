'use strict';
// A small seeded random generator (mulberry32). The demo's history is generated from a seed, so the charts look alive and believable
// but every run (and every test) gets the same numbers.
function make(seed) {
    let a = (Number(seed) || 1) >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const r = {
        next,
        /** an integer from lo to hi, both included */
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        /** a number from lo up to hi */
        float: (lo, hi) => lo + next() * (hi - lo),
        chance: (p) => next() < p,
        pick: (list) => list[Math.floor(next() * list.length)],
        /** a number around `mean`, mostly within `sd` (Box-Muller), never below `min` */
        gauss: (mean, sd, min = -Infinity) => {
            const u = Math.max(1e-9, next()), v = next();
            return Math.max(min, mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
        },
        /** a Poisson-distributed count (small means only) */
        poisson: (mean) => { const L = Math.exp(-mean); let k = 0, p = 1; do { k++; p *= next(); } while (p > L); return k - 1; },
        /** index chosen by weights */
        weighted: (weights) => { const sum = weights.reduce((s, w) => s + w, 0); let x = next() * sum; for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; } return weights.length - 1; },
        shuffle: (list) => { const l = list.slice(); for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return l; },
        hex: (bytes) => Array.from({ length: bytes }, () => Math.floor(next() * 256).toString(16).padStart(2, '0')).join(''),
    };
    return r;
}
module.exports = { make };
