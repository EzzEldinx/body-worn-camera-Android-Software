// Camera packages sold to companies. `maxCameras` caps how many cameras a company may own;
// `maxLive` is the default cap on cameras streaming live at the same time (admin may override).
const PACKAGES = [
    { maxCameras: 20, maxLive: 8 },
    { maxCameras: 60, maxLive: 20 },
    { maxCameras: 100, maxLive: 30 },
    { maxCameras: 500, maxLive: 100 },
    { maxCameras: 1000, maxLive: 200 },
    { maxCameras: 3000, maxLive: 500 },
];

const findPackage = (maxCameras) => PACKAGES.find((p) => p.maxCameras === Number(maxCameras)) || null;

// Normalise a package request. `undefined`/null/'' => unlimited (legacy company, no package set).
function parsePackage(maxCameras, maxLive) {
    if (maxCameras === undefined || maxCameras === null || maxCameras === '') return { maxCameras: null, maxLive: null };
    const pkg = findPackage(maxCameras);
    if (!pkg) return { error: 'Unknown package.' };
    let live = pkg.maxLive;
    if (maxLive !== undefined && maxLive !== null && maxLive !== '') {
        live = Number(maxLive);
        if (!Number.isInteger(live) || live < 1 || live > pkg.maxCameras) return { error: `Live limit must be between 1 and ${pkg.maxCameras}.` };
    }
    return { maxCameras: pkg.maxCameras, maxLive: live };
}

const canAddCamera = (company, used) => !company?.maxCameras || used < company.maxCameras;
const canGoLive = (company, liveNow) => !company?.maxLive || liveNow < company.maxLive;

module.exports = { PACKAGES, findPackage, parsePackage, canAddCamera, canGoLive };
