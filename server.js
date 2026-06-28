const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const http    = require('http');
const db      = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3000;

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

// ── Keep-alive ping to prevent Render free tier sleep ──
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    http.get(RENDER_URL, (res) => {
      console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', (e) => {
      console.log(`Keep-alive error: ${e.message}`);
    });
  }, 10 * 60 * 1000); // every 10 minutes
}

// Seed admin on startup
(async () => {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'soiree2025';
  const existing  = await db.getAdmin(adminUser);
  if (!existing) {
    const hash = await bcrypt.hash(adminPass, 12);
    await db.createAdmin(adminUser, hash);
    console.log(`Admin seeded — username: ${adminUser}`);
  }
})();

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminLoggedIn) return next();
  res.redirect('/admin/login');
}

// ═══════════════════════════════════
//  USER ROUTES
// ═══════════════════════════════════

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

  req.session.firstName  = firstName;
  req.session.lastName   = lastName;
  req.session.whatsapp   = whatsapp;
  req.session.rsvpStatus = null;
  req.session.allergies  = null;
  req.session.transport  = null;
  req.session.rsvpDone   = false;

  const exactMatch = await db.findByNameAndPhone(firstName, lastName, whatsapp);
  if (exactMatch) {
    return res.render('overwrite', { firstName, lastName });
  }
  res.redirect('/rsvp');
});

app.post('/name/overwrite', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  res.redirect('/rsvp');
});

app.get('/rsvp', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  res.render('rsvp', { firstName: req.session.firstName, lastName: req.session.lastName, error: null });
});

app.post('/rsvp', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  const status = req.body.status;
  if (!['attending', 'not_attending'].includes(status)) {
    return res.render('rsvp', { firstName: req.session.firstName, lastName: req.session.lastName, error: 'Please select an option.' });
  }
  req.session.rsvpStatus = status;
  if (status === 'attending') {
    res.redirect('/allergies');
  } else {
    db.upsertRsvp(req.session.firstName, req.session.lastName, req.session.whatsapp, 'not_attending', null, null)
      .then(() => { req.session.rsvpDone = true; res.redirect('/confirmation'); });
  }
});

app.get('/allergies', (req, res) => {
  if (!req.session.firstName || req.session.rsvpStatus !== 'attending') return res.redirect('/');
  res.render('allergies', { error: null });
});

app.post('/allergies', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  const hasAllergies = req.body.has_allergies;
  if (hasAllergies === 'yes') {
    const detail = (req.body.allergy_detail || '').trim();
    if (!detail) return res.render('allergies', { error: 'Please describe your allergies, or choose "No allergies".' });
    req.session.allergies = detail;
  } else {
    req.session.allergies = 'none';
  }
  res.redirect('/transport');
});

app.get('/transport', (req, res) => {
  if (!req.session.firstName || req.session.rsvpStatus !== 'attending') return res.redirect('/');
  res.render('transport', { error: null });
});

app.post('/transport', async (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  const transport = req.body.transport;
  if (!['yes', 'no'].includes(transport)) return res.redirect('/transport');
  req.session.transport = transport;
  await db.upsertRsvp(req.session.firstName, req.session.lastName, req.session.whatsapp, 'attending', req.session.allergies, transport);
  req.session.rsvpDone = true;
  res.redirect('/confirmation');
});

app.get('/confirmation', (req, res) => {
  if (!req.session.firstName || !req.session.rsvpStatus) return res.redirect('/');
  res.render('confirmation', {
    firstName: req.session.firstName,
    status:    req.session.rsvpStatus,
    allergies: req.session.allergies,
    transport: req.session.transport
  });
});

app.get('/restart', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

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

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const search = req.query.search || '';
  const filter = req.query.filter || 'all';
  let rsvps = search ? await db.searchRsvps(search) : await db.getAllRsvps();
  const stats = await db.getRsvpStats();

  if (filter === 'attending')          rsvps = rsvps.filter(r => r.status === 'attending');
  else if (filter === 'not_attending') rsvps = rsvps.filter(r => r.status === 'not_attending');
  else if (filter === 'transport')     rsvps = rsvps.filter(r => r.transport === 'yes');
  else if (filter === 'allergies')     rsvps = rsvps.filter(r => r.allergies && r.allergies !== 'none' && r.allergies !== '');

  res.render('admin-dashboard', { rsvps, stats, search, filter, adminUser: req.session.adminUser });
});

// Delete a single RSVP record
app.post('/admin/delete/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!isNaN(id)) await db.deleteRsvp(id);
  // Redirect back with same filter/search
  const ref = req.get('Referrer') || '/admin/dashboard';
  res.redirect(ref);
});

// CSV export — sheet param controls which group
app.get('/admin/export', requireAdmin, async (req, res) => {
  const sheet = req.query.sheet || 'all'; // 'attending' | 'not_attending' | 'all'
  let allRsvps = await db.getAllRsvps();

  let rows, filename, title;

  if (sheet === 'attending') {
    rows     = allRsvps.filter(r => r.status === 'attending');
    filename = 'kk-attending.csv';
    title    = 'ATTENDING GUESTS';
  } else if (sheet === 'not_attending') {
    rows     = allRsvps.filter(r => r.status === 'not_attending');
    filename = 'kk-not-attending.csv';
    title    = 'NOT ATTENDING';
  } else {
    rows     = allRsvps;
    filename = 'kk-all-rsvp.csv';
    title    = 'ALL RESPONSES';
  }

  const lines = [];

  // Title block
  lines.push(`K & K - 21st Soiree RSVP Data`);
  lines.push(`${title}`);
  lines.push(`Exported: ${new Date().toLocaleString('en-ZA')}`);
  lines.push(`Total records: ${rows.length}`);
  lines.push(``); // blank line

  // Headers
  if (sheet === 'attending' || sheet === 'all') {
    lines.push(`#,First Name,Last Name,WhatsApp,Status,Transport Home,Dietary / Allergies,Submitted`);
  } else {
    lines.push(`#,First Name,Last Name,WhatsApp,Status,Submitted`);
  }

  // Data rows
  rows.forEach((r, i) => {
    const date = (r.updated_at || r.created_at || '').slice(0, 16);
    if (sheet === 'not_attending') {
      lines.push(`${i+1},"${r.first_name}","${r.last_name}","${r.whatsapp || ''}","Not Attending","${date}"`);
    } else {
      const transport = r.transport === 'yes' ? 'Yes - needs lift home' : r.transport === 'no' ? 'No - own transport' : '—';
      const allergies = (r.allergies && r.allergies !== 'none') ? r.allergies : 'None';
      lines.push(`${i+1},"${r.first_name}","${r.last_name}","${r.whatsapp || ''}","${r.status === 'attending' ? 'Attending' : 'Not Attending'}","${transport}","${allergies}","${date}"`);
    }
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM for Excel to read correctly
  res.send('\uFEFF' + lines.join('\r\n'));
});

// ── Admin Management ──
app.get('/admin/admins', requireAdmin, async (req, res) => {
  const admins = await db.getAllAdmins();
  res.render('admin-admins', {
    admins,
    currentAdmin: req.session.adminUser,
    success: req.query.success || null,
    error:   req.query.error   || null
  });
});

app.post('/admin/admins/add', requireAdmin, async (req, res) => {
  const username  = (req.body.username         || '').trim().toLowerCase();
  const password  = (req.body.password         || '').trim();
  const confirm   = (req.body.confirm_password || '').trim();

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
  const id = parseInt(req.params.id);
  // Prevent deleting yourself
  const all    = await db.getAllAdmins();
  const target = all.find(a => a.id === id);
  if (target && target.username !== req.session.adminUser) {
    await db.deleteAdmin(id);
  }
  res.redirect('/admin/admins');
});

app.listen(PORT, () => console.log(`K&K RSVP running on http://localhost:${PORT}`));
