'use strict';
// Everything the demo invents: the company, its people, its sites and the places its cameras patrol, and the support tickets.
// All of it is made up. Names are shown blurred in the demo (see public/demo.js); the values here are what the blur looks for.

const COMPANY = 'Najd Guard Services Co.';

const FIRST = ['Khalid', 'Fahad', 'Abdullah', 'Mohammed', 'Saad', 'Turki', 'Nasser', 'Faisal', 'Sultan', 'Omar', 'Ibrahim', 'Yousef', 'Majed', 'Rayan', 'Badr', 'Hamad', 'Salman', 'Bandar', 'Talal', 'Waleed', 'Ziyad', 'Mishaal', 'Abdulaziz', 'Hassan', 'Ali', 'Meshari', 'Nawaf', 'Osama'];
const FAMILY = ['Al-Harbi', 'Al-Otaibi', 'Al-Qahtani', 'Al-Dosari', 'Al-Mutairi', 'Al-Ghamdi', 'Al-Zahrani', 'Al-Shehri', 'Al-Anazi', 'Al-Subaie', 'Al-Rashid', 'Al-Shammari', 'Al-Juhani', 'Al-Balawi', 'Al-Harthi', 'Al-Malki', 'Al-Ahmadi', 'Al-Tamimi', 'Al-Yami', 'Al-Khaldi', 'Al-Sulami', 'Al-Enezi', 'Al-Maliki', 'Al-Hazmi'];

/** n different "First Family" names, in a fixed order for a given rng. */
function people(rng, n) {
    const firsts = rng.shuffle(FIRST), fams = rng.shuffle(FAMILY), out = [], seen = new Set();
    for (let i = 0; out.length < n && i < 500; i++) {
        const first = firsts[i % firsts.length], family = fams[(i * 7 + Math.floor(i / firsts.length)) % fams.length], name = `${first} ${family}`;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, username: `${first[0].toLowerCase()}.${family.replace(/-/g, '').toLowerCase()}`, first, family });
    }
    return out;
}

// Three areas of Riyadh, two sites in each, two cameras on each site. `c` = the centre of the site, `half` = the patrol loop in metres [north-south, east-west].
const REGIONS = ['Riyadh North', 'Riyadh Central', 'Riyadh East'];
const SITES = [
    { name: 'Hittin Business Park', region: 0, c: [24.7745, 46.5915], half: [150, 220], dock: 0 },
    { name: 'Al Malqa Mall', region: 0, c: [24.8120, 46.6230], half: [180, 260], dock: 0 },
    { name: 'Olaya Tower', region: 1, c: [24.7114, 46.6744], half: [140, 190], dock: 1 },
    { name: 'Central Warehouse', region: 1, c: [24.6620, 46.7290], half: [200, 280], dock: 1 },
    { name: 'Industrial Yard', region: 2, c: [24.5995, 46.8370], half: [260, 400], dock: 2 },
    { name: 'Exit 15 Checkpoint', region: 2, c: [24.7405, 46.8120], half: [160, 240], dock: 2 },
];
// One docking station for each area (ids are equipment labels, not names).
const DOCKS = [
    { id: 'DOCK-NORTH', region: 0, c: [24.7733, 46.5898] },
    { id: 'DOCK-CENTRAL', region: 1, c: [24.7098, 46.6731] },
    { id: 'DOCK-EAST', region: 2, c: [24.5983, 46.8354] },
];

// Support tickets: [subject, category, priority, status, camera, [[author: 'me' | 'staff', hours after the ticket was opened, text]]]. Two are written in Arabic.
const TICKETS = [
    ['BWC-07 battery drains faster than the other cameras', 'camera', 'normal', 'in_progress', 'BWC-07', 22, [
        ['me', 0, 'BWC-07 is at 20% after four hours on patrol while the others are at 55%. It was charged to 100% on the dock this morning. Is the battery weak?'],
        ['staff', 3, 'Thank you. We looked at its battery history: it loses about twice as much as the rest of the fleet, which points to an ageing cell. We will ship a replacement battery to you on Sunday. Until then please keep BWC-07 for short shifts.'],
        ['me', 5, 'Understood, we will use it for the gate shift only. Please send the battery to the Central Warehouse.'],
    ]],
    ['How do I add a patrol checkpoint on the map?', 'question', 'low', 'resolved', null, 40, [
        ['me', 0, 'We want an officer to pass the back gate every 30 minutes at night. Where do I set that up?'],
        ['staff', 2, 'Open the Live Dashboard, press Zones on the map, choose Checkpoint, draw a circle around the back gate and set "must be passed every" to 30 minutes. Pick the night hours under Schedule. An alert is raised when nobody passes in time.'],
        ['me', 20, 'Done, it works. Thank you!'],
    ]],
    ['SOS test from BWC-04 did not show on the second control-room screen', 'alerts', 'high', 'resolved', 'BWC-04', 96, [
        ['me', 0, 'We pressed SOS on BWC-04 during a drill. The first screen showed the alarm with a sound, the second screen only showed it after a refresh.'],
        ['staff', 1, 'Thanks for the drill. Please check that the second screen has the page open in a normal tab (a tab that is not in the background) and that the sound is switched on with one click on the page. The alarm itself always reaches every open screen.'],
        ['me', 8, 'That was it: the tab was minimised. Fixed, sorry for the noise.'],
        ['staff', 9, 'No problem at all, drills like this are exactly what we recommend. Closing the ticket.'],
    ]],
    ['Can the monthly PDF report use our logo?', 'question', 'low', 'open', null, 8, [
        ['me', 0, 'We send the monthly report to our client. Is it possible to put our company logo on the cover instead of the VisionGuard one?'],
    ]],
    ['الكاميرا BWC-12 لا تتصل بالشبكة منذ يومين', 'camera', 'high', 'open', 'BWC-12', 6, [
        ['me', 0, 'الكاميرا BWC-12 لا تظهر على الخريطة منذ يومين وهي مشحونة. الرجاء المساعدة.'],
    ]],
    ['Dock bay 4 does not charge the camera', 'docking', 'normal', 'closed', null, 140, [
        ['me', 0, 'A camera placed in bay 4 shows the connected icon but the battery stays at the same level for an hour.'],
        ['staff', 4, 'Please clean the contacts of bay 4 with a dry cloth and try bay 5. If bay 5 charges normally, the bay needs service and we will arrange a visit.'],
        ['me', 26, 'Bay 5 works fine. Please arrange the visit for bay 4.'],
        ['staff', 28, 'Visit booked for Tuesday. We close this ticket and will follow up by phone.'],
    ]],
    ['اقتراح: تصدير سجل الاستلام والتسليم لكل موظف', 'other', 'low', 'resolved', null, 200, [
        ['me', 0, 'نحتاج تصدير سجل استلام وتسليم الكاميرات لكل موظف في ملف واحد لإرساله للموارد البشرية.'],
        ['staff', 5, 'من صفحة الإرساء ثم تبويب الاستلام والتسليم يمكنك اختيار التاريخ وتنزيل ملف CSV يحتوي على كل الورديات. إذا احتجت عمودا إضافيا أخبرنا.'],
    ]],
];

const SOS_NOTES = ['drill', 'real'];   // (not shown anywhere: kept for readers of the seed)

// What the cameras say in the public chat now and then (a camera speaks as its id).
const CHAT_EN = ['Round complete, all clear.', 'Gate is secure.', 'Starting the next round.', 'Delivery truck at the loading dock, checking papers.', 'All quiet on this side.', 'Handing over to the next shift soon.', 'Visitor registered at the entrance.'];
const CHAT_AR = ['اكتملت الجولة، كل شيء سليم.', 'البوابة مؤمّنة.', 'بدء الجولة التالية.', 'الوضع هادئ في هذه الجهة.'];
const REPLY_EN = ['Copy that.', '10-4, on my way.', 'Understood, checking now.', 'Received, all clear here.'];
const REPLY_AR = ['تم، استلمت.', 'حاضر، أنا في الطريق.', 'علم، أتحقق الآن.'];

module.exports = { COMPANY, FIRST, FAMILY, people, REGIONS, SITES, DOCKS, TICKETS, SOS_NOTES, CHAT_EN, CHAT_AR, REPLY_EN, REPLY_AR };
