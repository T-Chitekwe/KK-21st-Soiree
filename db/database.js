const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH =
  process.env.RENDER
    ? '/var/data/rsvp.db'
    : path.join(__dirname, 'rsvp.db');

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS rsvps (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name   TEXT NOT NULL,
      last_name    TEXT NOT NULL,
      whatsapp     TEXT NOT NULL,
      status       TEXT NOT NULL CHECK(status IN ('attending','not_attending')),
      allergies    TEXT,
      transport    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migrate existing DBs that don't have these columns yet
  try { db.run(`ALTER TABLE rsvps ADD COLUMN whatsapp   TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE rsvps ADD COLUMN allergies  TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE rsvps ADD COLUMN transport  TEXT`); } catch(e) {}
  try { db.run(`ALTER TABLE rsvps ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`); } catch(e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function rowsToObjects(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function escape(s) { return String(s).replace(/'/g, "''"); }

// Find by name only — used to detect if name exists at all
async function findByNameOnly(firstName, lastName) {
  const d = await getDb();
  const res = d.exec(
    `SELECT * FROM rsvps
     WHERE LOWER(first_name)=LOWER('${escape(firstName)}')
       AND LOWER(last_name)=LOWER('${escape(lastName)}')
     LIMIT 1`
  );
  const rows = rowsToObjects(res);
  return rows[0] || null;
}

// Find by all 3 fields — exact match (name + whatsapp)
async function findByNameAndPhone(firstName, lastName, whatsapp) {
  const d = await getDb();
  const res = d.exec(
    `SELECT * FROM rsvps
     WHERE LOWER(first_name)=LOWER('${escape(firstName)}')
       AND LOWER(last_name)=LOWER('${escape(lastName)}')
       AND whatsapp='${escape(whatsapp)}'
     LIMIT 1`
  );
  const rows = rowsToObjects(res);
  return rows[0] || null;
}

// Upsert by name (overwrites existing record for that name)
async function upsertRsvp(firstName, lastName, whatsapp, status, allergies, transport) {
  const d = await getDb();
  const existing = await findByNameOnly(firstName, lastName);
  if (existing) {
    d.run(
      `UPDATE rsvps
       SET whatsapp=?, status=?, allergies=?, transport=?, updated_at=datetime('now')
       WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?)`,
      [whatsapp, status, allergies || null, transport || null, firstName, lastName]
    );
  } else {
    d.run(
      `INSERT INTO rsvps (first_name, last_name, whatsapp, status, allergies, transport)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [firstName, lastName, whatsapp, status, allergies || null, transport || null]
    );
  }
  save();
}

async function getAllRsvps() {
  const d = await getDb();
  const res = d.exec('SELECT * FROM rsvps ORDER BY updated_at DESC');
  return rowsToObjects(res);
}

async function searchRsvps(query) {
  const d = await getDb();
  const q = escape(query);
  const res = d.exec(
    `SELECT * FROM rsvps
     WHERE first_name LIKE '%${q}%'
        OR last_name  LIKE '%${q}%'
        OR whatsapp   LIKE '%${q}%'
     ORDER BY updated_at DESC`
  );
  return rowsToObjects(res);
}

async function getRsvpStats() {
  const d = await getDb();
  const res = d.exec(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='attending'     THEN 1 ELSE 0 END) as attending,
      SUM(CASE WHEN status='not_attending' THEN 1 ELSE 0 END) as not_attending,
      SUM(CASE WHEN transport='yes'        THEN 1 ELSE 0 END) as needs_transport,
      SUM(CASE WHEN allergies IS NOT NULL AND allergies != '' AND allergies != 'none' THEN 1 ELSE 0 END) as has_allergies
    FROM rsvps
  `);
  if (!res.length) return { total: 0, attending: 0, not_attending: 0, needs_transport: 0, has_allergies: 0 };
  const row = res[0].values[0];
  return { total: row[0], attending: row[1], not_attending: row[2], needs_transport: row[3], has_allergies: row[4] };
}

async function getAdmin(username) {
  const d = await getDb();
  const res = d.exec(`SELECT * FROM admins WHERE username='${escape(username)}' LIMIT 1`);
  const rows = rowsToObjects(res);
  return rows[0] || null;
}

async function createAdmin(username, hashedPassword) {
  const d = await getDb();
  d.run('INSERT OR IGNORE INTO admins (username, password) VALUES (?, ?)', [username, hashedPassword]);
  save();
}

async function deleteRsvp(id) {
  const d = await getDb();
  d.run(`DELETE FROM rsvps WHERE id=?`, [id]);
  save();
}

module.exports = {
  getDb, upsertRsvp,
  findByNameOnly, findByNameAndPhone,
  getAllRsvps, searchRsvps, getRsvpStats,
  getAdmin, createAdmin, deleteRsvp, getAllAdmins, deleteAdmin
};
// This line intentionally left for append — deleteRsvp added below

async function getAllAdmins() {
  const d = await getDb();
  const res = d.exec(`SELECT id, username FROM admins ORDER BY id ASC`);
  return rowsToObjects(res);
}

async function deleteAdmin(id) {
  const d = await getDb();
  d.run(`DELETE FROM admins WHERE id=?`, [id]);
  save();
}
