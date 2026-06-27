const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const path    = require('path');
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

// Step 1 — Name + WhatsApp entry
app.get('/', (req, res) => {
  res.render('index', { error: null, prefill: null });
});

app.post('/name', async (req, res) => {
  const firstName = (req.body.first_name || '').trim();
  const lastName  = (req.body.last_name  || '').trim();
  const whatsapp  = (req.body.whatsapp   || '').trim();

  // All fields required
  if (!firstName || !lastName || !whatsapp) {
    return res.render('index', {
      error: 'Please fill in all three fields.',
      prefill: { first_name: firstName, last_name: lastName, whatsapp }
    });
  }

  // Basic phone validation — at least 7 digits
  if (!/^\+?[\d\s\-()]{7,20}$/.test(whatsapp)) {
    return res.render('index', {
      error: 'Please enter a valid WhatsApp number.',
      prefill: { first_name: firstName, last_name: lastName, whatsapp }
    });
  }

  // Store in session
  req.session.firstName  = firstName;
  req.session.lastName   = lastName;
  req.session.whatsapp   = whatsapp;
  req.session.rsvpStatus = null;
  req.session.allergies  = null;
  req.session.transport  = null;
  req.session.rsvpDone   = false;

  // Check if ALL 3 fields match an existing record
  const exactMatch = await db.findByNameAndPhone(firstName, lastName, whatsapp);
  if (exactMatch) {
    // Show overwrite confirmation page
    return res.render('overwrite', { firstName, lastName });
  }

  // No match — proceed normally
  res.redirect('/rsvp');
});

// User confirms they want to overwrite their existing record
app.post('/name/overwrite', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  // Session already has their details — just continue to RSVP
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
      .then(() => {
        req.session.rsvpDone = true;
        res.redirect('/confirmation');
      });
  }
});

// Step 3 — Allergies (attending only)
app.get('/allergies', (req, res) => {
  if (!req.session.firstName || req.session.rsvpStatus !== 'attending') return res.redirect('/');
  res.render('allergies', { error: null });
});

app.post('/allergies', (req, res) => {
  if (!req.session.firstName) return res.redirect('/');
  const hasAllergies = req.body.has_allergies;
  if (hasAllergies === 'yes') {
    const detail = (req.body.allergy_detail || '').trim();
    if (!detail) {
      return res.render('allergies', { error: 'Please describe your allergies, or choose "No allergies".' });
    }
    req.session.allergies = detail;
  } else {
    req.session.allergies = 'none';
  }
  res.redirect('/transport');
});

// Step 4 — Transport (attending only)
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
    req.session.firstName,
    req.session.lastName,
    req.session.whatsapp,
    'attending',
    req.session.allergies,
    transport
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

// Restart — clears session
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
  if (!match)  return res.render('admin-login', { error: 'Invalid credentials.' });
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

  if (filter === 'attending')      rsvps = rsvps.filter(r => r.status === 'attending');
  else if (filter === 'not_attending') rsvps = rsvps.filter(r => r.status === 'not_attending');
  else if (filter === 'transport') rsvps = rsvps.filter(r => r.transport === 'yes');
  else if (filter === 'allergies') rsvps = rsvps.filter(r => r.allergies && r.allergies !== 'none' && r.allergies !== '');

  res.render('admin-dashboard', { rsvps, stats, search, filter, adminUser: req.session.adminUser });
});

app.get('/admin/export', requireAdmin, async (req, res) => {
  const rsvps = await db.getAllRsvps();
  const lines = ['ID,First Name,Last Name,WhatsApp,Status,Transport,Allergies/Dietary,Submitted At'];
  rsvps.forEach(r => {
    lines.push(`${r.id},"${r.first_name}","${r.last_name}","${r.whatsapp || ''}","${r.status}","${r.transport || '—'}","${r.allergies || 'none'}","${r.updated_at || r.created_at}"`);
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kk-rsvp-responses.csv"');
  res.send(lines.join('\n'));
});

app.listen(PORT, () => console.log(`K&K RSVP running on http://localhost:${PORT}`));
