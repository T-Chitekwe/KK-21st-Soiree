const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const http    = require('http');
const db      = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Set this to true to close RSVPs ──
// You can also set RSVP_CLOSED=true as a Render environment variable
const RSVP_CLOSED = process.env.RSVP_CLOSED === 'true' || false;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'kk-soiree-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 4 }
}));

// Keep-alive ping
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    http.get(RENDER_URL, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
}

// Seed admin on startup
(async () => {
  try {
    await db.getDb();
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'soiree2025';
    const existing  = await db.getAdmin(adminUser);
    if (!existing) {
      const hash = await bcrypt.hash(adminPass, 12);
      await db.createAdmin(adminUser, hash);
      console.log('Admin seeded: ' + adminUser);
    }
  } catch(e) { console.error('Seed error:', e.message); }
})();

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminLoggedIn) return next();
  res.redirect('/admin/login');
}

// ═══════════════════════════════════
//  USER ROUTES
// ═══════════════════════════════════

// Step 1 — Name entry
app.get('/', (req, res) => {
  res.render('index', { error: null, prefill: null });
});

app.post('/name', async (req, res) => {
  const firstName = (req.body.first_name || '').trim();
  const lastName  = (req.body.last_name  || '').trim();
  const whatsapp  = (req.body.whatsapp   || '').trim();

  if (!firstName || !lastName || !whatsapp) {
    return res.render('index', {
      error: 'Please fill in all three fields.',
      prefill: { first_name: firstName, last_name: lastName, whatsapp }
    });
  }
  if (!/^\+?[\d\s\-()]{7,20}$/.test(whatsapp)) {
    return res.render('index', {
      error: 'Please enter a valid WhatsApp number.',
      prefill: { first_name: firstName, last_name: lastName, whatsapp }
    });
  }

  // Check if this person already exists in the database (by name only)
  const existingByName = await db.findByNameOnly(firstName, lastName);

  // ── DEADLINE CHECK ──
  // If RSVPs are closed AND this is a brand new person → block them
  // and silently record them as not_attending so admin can see
  if (RSVP_CLOSED && !existingByName) {
    // Record them as not attending so they appear in admin
    await db.upsertRsvp(firstName, lastName, whatsapp, 'not_attending', null, null);
    return res.render('deadline', { firstName, lastName });
  }

  // Store in session
  req.session.firstName  = firstName;
  req.session.lastName   = lastName;
  req.session.whatsapp   = whatsapp;
  req.session.rsvpStatus = null;
  req.session.allergies  = null;
  req.session.transport  = null;
  req.session.rsvpDone   = false;

  // Check if ALL 3 fields match exactly — show overwrite prompt
  const exactMatch = await db.findByNameAndPhone(firstName, lastName, whatsapp);
  if (exactMatch) {
    return res.render('overwrite', { firstName, lastName });
  }

  // Existing name, different number — or brand new (deadline open) — proceed
  res.redirect('/rsvp');
});

// Overwrite confirmation
app.post('/name/overwrite', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  res.redirect('/rsvp');
});

// Step 2 — RSVP choice
app.get('/rsvp', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  res.render('rsvp', {
    firstName: req.session.firstName,
    lastName:  req.session.lastName,
    error: null
  });
});

app.post('/rsvp', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  const status = req.body.status;
  if (!['attending', 'not_attending'].includes(status)) {
    return res.render('rsvp', {
      firstName: req.session.firstName,
      lastName:  req.session.lastName,
      error: 'Please select an option.'
    });
  }
  req.session.rsvpStatus = status;
  if (status === 'attending') {
    res.redirect('/allergies');
  } else {
    db.upsertRsvp(req.session.firstName, req.session.lastName, req.session.whatsapp, 'not_attending', null, null)
      .then(() => { req.session.rsvpDone = true; res.redirect('/confirmation'); });
  }
});

// Step 3 — Allergies
app.get('/allergies', (req, res) => {
  if (!req.session.firstName || req.session.rsvpStatus !== 'attending') return res.redirect('/');
  res.render('allergies', { error: null });
});

app.post('/allergies', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  if (req.body.has_allergies === 'yes') {
    const detail = (req.body.allergy_detail || '').trim();
    if (!detail) return res.render('allergies', { error: 'Please describe your allergies, or choose "No allergies".' });
    req.session.allergies = detail;
  } else {
    req.session.allergies = 'none';
  }
  res.redirect('/transport');
});

// Step 4 — Transport
app.get('/transport', (req, res) => {
  if (!req.session.firstName || req.session.rsvpStatus !== 'attending') return res.redirect('/');
  res.render('transport', { error: null });
});

app.post('/transport', async (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  const transport = req.body.transport;
  if (!['yes', 'no'].includes(transport)) return res.redirect('/transport');
  req.session.transport = transport;
  await db.upsertRsvp(
    req.session.firstName, req.session.lastName, req.session.whatsapp,
    'attending', req.session.allergies, transport
  );
  req.session.rsvpDone = true;
  res.redirect('/confirmation');
});

// Step 5 — Confirmation
app.get('/confirmation', (req, res) => {
  if (!req.session.firstName || !req.session.rsvpStatus) return res.redirect('/');
  res.render('confirmation', {
    firstName: req.session.firstName,
    status:    req.session.rsvpStatus,
    allergies: req.session.allergies,
    transport: req.session.transport
  });
});

// Restart
app.get('/restart', (req, res) => req.session.destroy(() => res.redirect('/')));

// ═══════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════

app.get('/admin/login', (req, res) => {
  if (req.session.adminLoggedIn) return res.redirect('/admin/dashboard');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await db.getAdmin(username);
  if (!admin) return res.render('admin-login', { error: 'Invalid credentials.' });
  const match = await bcrypt.compare(password, admin.password);
  if (!match) return res.render('admin-login', { error: 'Invalid credentials.' });
  req.session.adminLoggedIn = true;
  req.session.adminUser     = username;
  res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const search = req.query.search || '';
  const filter = req.query.filter || 'all';
  let rsvps = search ? await db.searchRsvps(search) : await db.getAllRsvps();
  const stats = await db.getRsvpStats();

  if (filter === 'attending')          rsvps = rsvps.filter(r => r.status === 'attending');
  else if (filter === 'not_attending') rsvps = rsvps.filter(r => r.status === 'not_attending');
  else if (filter === 'transport')     rsvps = rsvps.filter(r => r.transport === 'yes');
  else if (filter === 'allergies')     rsvps = rsvps.filter(r => r.allergies && r.allergies !== 'none' && r.allergies !== '');

  res.render('admin-dashboard', {
    rsvps, stats, search, filter,
    adminUser:   req.session.adminUser,
    rsvpClosed:  RSVP_CLOSED
  });
});

app.post('/admin/delete/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!isNaN(id)) await db.deleteRsvp(id);
  res.redirect(req.get('Referrer') || '/admin/dashboard');
});

// Excel export
app.get('/admin/export', requireAdmin, async (req, res) => {
  const ExcelJS = require('exceljs');
  const sheet   = req.query.sheet || 'all';
  let allRsvps  = await db.getAllRsvps();
  let rows, filename, title;

  if (sheet === 'attending') {
    rows = allRsvps.filter(r => r.status === 'attending');
    filename = 'kk-attending.xlsx'; title = 'ATTENDING GUESTS';
  } else if (sheet === 'not_attending') {
    rows = allRsvps.filter(r => r.status === 'not_attending');
    filename = 'kk-not-attending.xlsx'; title = 'NOT ATTENDING';
  } else if (sheet === 'transport') {
    rows = allRsvps.filter(r => r.transport === 'yes');
    filename = 'kk-transport.xlsx'; title = 'GUESTS NEEDING TRANSPORT';
  } else {
    rows = allRsvps;
    filename = 'kk-all-rsvp.xlsx'; title = 'ALL RESPONSES';
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'K & K RSVP System';
  wb.created = new Date();

  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 5 }] });

  const BLACK  = '00000000'; const GOLD   = '00D4AF37'; const WHITE  = '00FFFFFF';
  const LGOLD  = '00F5ECC8'; const DKGOLD = '00A8891F';

  ws.mergeCells('A1:H1');
  const t = ws.getCell('A1');
  t.value = 'K & K — 21st Soirée RSVP Data';
  t.font  = { name: 'Georgia', size: 16, bold: true, color: { argb: GOLD } };
  t.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLACK } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 36;

  ws.mergeCells('A2:H2');
  const s = ws.getCell('A2');
  s.value = title;
  s.font  = { name: 'Calibri', size: 12, bold: true, color: { argb: WHITE } };
  s.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: DKGOLD } };
  s.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 24;

  ws.mergeCells('A3:H3');
  const m = ws.getCell('A3');
  m.value = `Exported: ${new Date().toLocaleString('en-ZA')}   |   Total records: ${rows.length}`;
  m.font  = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF888888' } };
  m.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: '00F5F5F5' } };
  m.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(3).height = 20;
  ws.getRow(4).height = 6;

  const isNotAttending = sheet === 'not_attending';
  ws.columns = isNotAttending
    ? [{ key:'num',width:5},{key:'first_name',width:18},{key:'last_name',width:18},{key:'whatsapp',width:18},{key:'status',width:16},{key:'submitted',width:22}]
    : [{ key:'num',width:5},{key:'first_name',width:18},{key:'last_name',width:18},{key:'whatsapp',width:18},{key:'status',width:16},{key:'transport',width:30},{key:'allergies',width:28},{key:'submitted',width:22}];

  const headerLabels = isNotAttending
    ? ['#','First Name','Last Name','WhatsApp','Status','Submitted']
    : ['#','First Name','Last Name','WhatsApp','Status','Transport Home','Dietary / Allergies','Submitted'];

  const headerRow = ws.getRow(5);
  headerRow.height = 28;
  headerLabels.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = label;
    cell.font  = { name: 'Calibri', size: 11, bold: true, color: { argb: WHITE } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLACK } };
    cell.alignment = { horizontal: i === 0 ? 'center' : 'left', vertical: 'middle' };
    cell.border = { bottom: { style: 'medium', color: { argb: GOLD } }, right: { style: 'thin', color: { argb: '00333333' } } };
  });

  rows.forEach((r, i) => {
    const rowFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? WHITE : LGOLD } };
    const dataRow = ws.getRow(i + 6);
    dataRow.height = 22;
    const transport  = r.transport === 'yes' ? 'Yes — needs transport to drop-off' : r.transport === 'no' ? 'No — own transport' : '—';
    const allergies  = (r.allergies && r.allergies !== 'none' && r.allergies !== '') ? r.allergies : 'None';
    const submitted  = (r.updated_at || r.created_at || '').slice(0, 16).replace('T', ' ');
    const statusLabel = r.status === 'attending' ? 'Attending' : 'Not Attending';
    const values = isNotAttending
      ? [i+1, r.first_name, r.last_name, r.whatsapp||'', statusLabel, submitted]
      : [i+1, r.first_name, r.last_name, r.whatsapp||'', statusLabel, transport, allergies, submitted];

    values.forEach((val, ci) => {
      const cell = dataRow.getCell(ci + 1);
      cell.value = val;
      cell.fill  = rowFill;
      cell.alignment = { horizontal: ci === 0 ? 'center' : 'left', vertical: 'middle', wrapText: true };
      cell.font  = { name: 'Calibri', size: 10, color: { argb: '00222222' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } }, right: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
      if (ci === 4) { cell.font = { name:'Calibri',size:10,bold:true,color:{argb:r.status==='attending'?'00276227':'00882222'}}; cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:r.status==='attending'?'00D4EDDA':'00F8D7DA'}}; }
      if (!isNotAttending && ci === 5 && r.transport === 'yes') { cell.font={name:'Calibri',size:10,bold:true,color:{argb:'00155D7A'}}; cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'00D1ECF1'}}; }
      if (!isNotAttending && ci === 6 && allergies !== 'None') { cell.font={name:'Calibri',size:10,bold:true,color:{argb:'006A3FA0'}}; cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'00EDE0F5'}}; }
    });
  });

  const lastCol = isNotAttending ? 'F' : 'H';
  const summaryRowNum = rows.length + 6;
  ws.mergeCells(`A${summaryRowNum}:${lastCol}${summaryRowNum}`);
  const sumCell = ws.getCell(`A${summaryRowNum}`);
  sumCell.value = `Total: ${rows.length} record${rows.length !== 1 ? 's' : ''}`;
  sumCell.font  = { name:'Calibri',size:10,bold:true,color:{argb:WHITE} };
  sumCell.fill  = { type:'pattern',pattern:'solid',fgColor:{argb:DKGOLD} };
  sumCell.alignment = { horizontal:'right',vertical:'middle' };
  ws.getRow(summaryRowNum).height = 22;
  ws.autoFilter = `A5:${lastCol}5`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

// Admin management
app.get('/admin/admins', requireAdmin, async (req, res) => {
  const admins = await db.getAllAdmins();
  res.render('admin-admins', {
    admins, currentAdmin: req.session.adminUser,
    success: req.query.success || null, error: req.query.error || null
  });
});

app.post('/admin/admins/add', requireAdmin, async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();
  const confirm  = (req.body.confirm_password || '').trim();
  if (!username || !password) return res.redirect('/admin/admins?error=Please fill in all fields.');
  if (password !== confirm)   return res.redirect('/admin/admins?error=Passwords do not match.');
  if (password.length < 6)    return res.redirect('/admin/admins?error=Password must be at least 6 characters.');
  const existing = await db.getAdmin(username);
  if (existing) return res.redirect('/admin/admins?error=That username already exists.');
  const hash = await bcrypt.hash(password, 12);
  await db.createAdmin(username, hash);
  res.redirect('/admin/admins?success=Admin ' + username + ' added successfully.');
});

app.post('/admin/admins/delete/:id', requireAdmin, async (req, res) => {
  const id  = parseInt(req.params.id);
  const all = await db.getAllAdmins();
  const target = all.find(a => a.id === id);
  if (target && target.username !== req.session.adminUser) await db.deleteAdmin(id);
  res.redirect('/admin/admins');
});

app.listen(PORT, () => console.log(`K&K RSVP running on port ${PORT}`));
