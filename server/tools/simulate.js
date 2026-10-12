// Fake cameras for testing the dashboard without extra phones.
//   npm install socket.io-client
//   $env:BWC_TOKEN="yoursecret"; node tools/simulate.js 6
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const TOKEN = process.env.BWC_TOKEN || 'change-me';
const N = Number(process.argv[2]) || 5;

for (let i = 1; i <= N; i++) {
    const id = `SIM-${String(i).padStart(2, '0')}`;
    const s = io(URL, { auth: { token: TOKEN }, transports: ['websocket'] });
    let lat = 24.7136 + (Math.random() - 0.5) * 0.05;
    let lng = 46.6753 + (Math.random() - 0.5) * 0.05;
    s.on('connect', () => s.emit('camera_status', { cameraId: id, recording: false }));
    setInterval(() => {
        lat += (Math.random() - 0.5) * 0.0008;
        lng += (Math.random() - 0.5) * 0.0008;
        s.emit('camera_gps_update', { cameraId: id, lat, lng });
    }, 3000);
    if (i === 1) setTimeout(() => s.emit('camera_sos', { cameraId: id, lat, lng }), 15000);
}
console.log(`Simulating ${N} cameras. SIM-01 raises an SOS after 15 s. Ctrl+C to stop.`);