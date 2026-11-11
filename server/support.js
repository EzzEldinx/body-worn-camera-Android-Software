// Help & Support: tickets with a conversation thread, e-mailed to the support desk.
//   Customers open and follow their own tickets (company admins see their company's); Smart Way staff see and answer all of them.
//   E-mail needs SMTP_HOST (+ SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM); without it tickets are still stored and shown to staff, and the page says so.
const nodemailer = require('nodemailer');
const auditlog = require('./auditlog');

const CATEGORIES = ['question', 'camera', 'docking', 'live', 'alerts', 'account', 'app', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

function createMailer({ env = process.env, transport = null } = {}) {
    const to = env.SUPPORT_EMAIL || 'sdpt@smart-way.com.sa';
    const configured = !!(transport || env.SMTP_HOST);
    const tx = transport || (env.SMTP_HOST ? nodemailer.createTransport({
        host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 587, secure: Number(env.SMTP_PORT) === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
    }) : null);
    const from = env.SMTP_FROM || (env.SMTP_USER && env.SMTP_USER.includes('@') ? env.SMTP_USER : 'visionguard@smart-way.com.sa');
    return {
        to, configured,
        async send(subject, text, recipients) {
            if (!tx) return { sent: false, reason: 'E-mail is not configured on the server (SMTP_HOST).' };
            try { await tx.sendMail({ from: `VisionGuard <${from}>`, to: recipients || to, subject, text }); return { sent: true }; }
            catch (e) { return { sent: false, reason: String(e.message || e).slice(0, 200) }; }
        },
    };
}

function register(app, ctx) {
    const { db, needUser, isStaff, str, cams, canSee, companyName, mailer = createMailer(), publicUrl = process.env.PUBLIC_URL || '' } = ctx;
    db.exec(`CREATE TABLE IF NOT EXISTS tickets(
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT NOT NULL, company_id INTEGER, subject TEXT NOT NULL, category TEXT NOT NULL,
        priority TEXT NOT NULL, camera_id TEXT, status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, updated INTEGER NOT NULL, emailed INTEGER NOT NULL DEFAULT 0, mail_note TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS ticket_messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author TEXT NOT NULL, staff INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, ts INTEGER NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS tickets_company ON tickets(company_id, updated)');
    db.exec('CREATE INDEX IF NOT EXISTS ticket_msgs ON ticket_messages(ticket_id, ts)');

    const refOf = (id) => 'VG-' + String(id).padStart(5, '0');
    const mayOpen = (u, t) => isStaff(u) || t.user_id === u.id || (u.role === 'admin' && u.companyId != null && t.company_id === u.companyId);
    const shape = (t) => ({ id: t.id, ref: refOf(t.id), subject: t.subject, category: t.category, priority: t.priority, cameraId: t.camera_id, status: t.status, by: t.username,
        company: t.company_id ? companyName(t.company_id) : null, created: t.created, updated: t.updated, emailed: !!t.emailed, mailNote: t.mail_note || null,
        replies: db.prepare('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id = ?').get(t.id).n - 1 });
    const link = (t) => (publicUrl ? `\n\nOpen: ${publicUrl.replace(/\/$/, '')}/help.html#t=${t.id}` : '');

    app.get('/api/support/info', needUser, (req, res) => res.json({ email: mailer.to, emailConfigured: mailer.configured, staff: isStaff(req.user), categories: CATEGORIES, priorities: PRIORITIES }));

    app.post('/api/tickets', needUser, async (req, res) => {
        const u = req.user, b = req.body || {};
        const subject = String(b.subject || '').trim().slice(0, 120), description = String(b.description || '').trim().slice(0, 4000);
        const category = CATEGORIES.includes(b.category) ? b.category : 'question', priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
        if (subject.length < 3) return res.status(400).json({ error: 'Write a short subject (at least 3 characters).' });
        if (description.length < 10) return res.status(400).json({ error: 'Describe the problem in a few words (at least 10 characters).' });
        if (db.prepare('SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND created > ?').get(u.id, Date.now() - 3600000).n >= 10) return res.status(429).json({ error: 'Too many tickets in the last hour. Please add your details to an open ticket.' });
        let cameraId = b.cameraId ? str(String(b.cameraId)) : null;
        if (cameraId && !(cams.has(cameraId) && canSee(u, cameraId))) cameraId = null;
        const now = Date.now();
        const id = Number(db.prepare('INSERT INTO tickets(user_id,username,company_id,subject,category,priority,camera_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(u.id, u.username, u.companyId || null, subject, category, priority, cameraId, now, now).lastInsertRowid);
        db.prepare('INSERT INTO ticket_messages(ticket_id,author,staff,body,ts) VALUES(?,?,?,?,?)').run(id, u.name || u.username, isStaff(u) ? 1 : 0, description, now);
        auditlog.add(db, u.username, 'ticket_created', cameraId, { ref: refOf(id), subject, priority, category });
        const r = await mailer.send(`[${refOf(id)}] ${priority.toUpperCase()}: ${subject}`,
            `New support ticket ${refOf(id)}\n\nFrom: ${u.name || u.username} (${u.username})\nCompany: ${u.companyId ? companyName(u.companyId) : 'Smart Way'}\nCategory: ${category}\nPriority: ${priority}\nCamera: ${cameraId || '-'}\n\n${description}${link({ id })}`);
        db.prepare('UPDATE tickets SET emailed = ?, mail_note = ? WHERE id = ?').run(r.sent ? 1 : 0, r.sent ? null : r.reason, id);
        res.json({ ok: true, ref: refOf(id), id, emailed: r.sent, note: r.sent ? null : r.reason });
    });

    app.get('/api/tickets', needUser, (req, res) => {
        const u = req.user, st = STATUSES.includes(req.query.status) ? req.query.status : null;
        const rows = db.prepare(`SELECT * FROM tickets ${st ? 'WHERE status = ?' : ''} ORDER BY updated DESC LIMIT 500`).all(...(st ? [st] : [])).filter((t) => mayOpen(u, t));
        res.json({ tickets: rows.map(shape) });
    });
    app.get('/api/tickets/:id', needUser, (req, res) => {
        const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
        if (!t || !mayOpen(req.user, t)) return res.status(404).json({ error: 'Ticket not found.' });
        res.json({ ...shape(t), messages: db.prepare('SELECT author, staff, body, ts FROM ticket_messages WHERE ticket_id = ? ORDER BY ts, id').all(t.id).map((m) => ({ author: m.author, staff: !!m.staff, body: m.body, ts: m.ts })) });
    });
    app.post('/api/tickets/:id/messages', needUser, async (req, res) => {
        const u = req.user, t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
        if (!t || !mayOpen(u, t)) return res.status(404).json({ error: 'Ticket not found.' });
        const body = String(req.body?.body || '').trim().slice(0, 4000);
        if (body.length < 2) return res.status(400).json({ error: 'Write your reply.' });
        const now = Date.now(), staff = isStaff(u);
        db.prepare('INSERT INTO ticket_messages(ticket_id,author,staff,body,ts) VALUES(?,?,?,?,?)').run(t.id, u.name || u.username, staff ? 1 : 0, body, now);
        const status = staff ? (t.status === 'open' ? 'in_progress' : t.status) : (['resolved', 'closed'].includes(t.status) ? 'open' : t.status);   // a customer's reply reopens it
        db.prepare('UPDATE tickets SET updated = ?, status = ? WHERE id = ?').run(now, status, t.id);
        auditlog.add(db, u.username, staff ? 'ticket_answered' : 'ticket_reply', t.camera_id, { ref: refOf(t.id) });
        if (!staff) await mailer.send(`[${refOf(t.id)}] Reply: ${t.subject}`, `${u.name || u.username} (${t.company_id ? companyName(t.company_id) : 'Smart Way'}) replied:\n\n${body}${link(t)}`);
        res.json({ ok: true, status });
    });
    app.post('/api/tickets/:id/status', needUser, (req, res) => {
        const u = req.user, t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
        if (!t || !mayOpen(u, t)) return res.status(404).json({ error: 'Ticket not found.' });
        const status = String(req.body?.status || '');
        if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
        if (!isStaff(u) && !['open', 'closed'].includes(status)) return res.status(403).json({ error: 'Only Smart Way support can set this status.' });
        db.prepare('UPDATE tickets SET status = ?, updated = ? WHERE id = ?').run(status, Date.now(), t.id);
        auditlog.add(db, u.username, `ticket_${status}`, t.camera_id, { ref: refOf(t.id) });
        res.json({ ok: true, status });
    });
}

module.exports = { register, createMailer, CATEGORIES, PRIORITIES, STATUSES };
