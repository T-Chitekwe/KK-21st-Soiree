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
}
const { createClient } = require('@libsql/client');

let client;

function getClient() {
  if (client) return client;
  if (!process.env.TURSO_URL) {
    client = createClient({ url: 'file:rsvp.db' });
  } else {
    client = createClient({
      url:       process.env.TURSO_URL,
      authToken: process.env.TURSO_TOKEN
    });
  }
  return client;
}

async function getDb() {
  const c = getClient();
  await c.execute(`
    CREATE TABLE IF NOT EXISTS rsvps (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name   TEXT NOT NULL,
      last_name    TEXT NOT NULL,
      whatsapp     TEXT NOT NULL,
      status       TEXT NOT NULL,
      allergies    TEXT,
      transport    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);
  return c;
}

async function findByNameOnly(firstName, lastName) {
  const c = await getDb();
  const res = await c.execute({
    sql:  `SELECT * FROM rsvps WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) LIMIT 1`,
    args: [firstName, lastName]
  });
  return res.rows[0] || null;
}

async function findByNameAndPhone(firstName, lastName, whatsapp) {
  const c = await getDb();
  const res = await c.execute({
    sql:  `SELECT * FROM rsvps WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) AND whatsapp=? LIMIT 1`,
    args: [firstName, lastName, whatsapp]
  });
  return res.rows[0] || null;
}

async function upsertRsvp(firstName, lastName, whatsapp, status, allergies, transport) {
  const c = await getDb();
  const existing = await findByNameOnly(firstName, lastName);
  if (existing) {
    await c.execute({
      sql:  `UPDATE rsvps SET whatsapp=?, status=?, allergies=?, transport=?, updated_at=datetime('now') WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?)`,
      args: [whatsapp, status, allergies || null, transport || null, firstName, lastName]
    });
  } else {
    await c.execute({
      sql:  `INSERT INTO rsvps (first_name, last_name, whatsapp, status, allergies, transport) VALUES (?,?,?,?,?,?)`,
      args: [firstName, lastName, whatsapp, status, allergies || null, transport || null]
    });
  }
}

async function getAllRsvps() {
  const c = await getDb();
  const res = await c.execute(`SELECT * FROM rsvps ORDER BY updated_at DESC`);
  return res.rows;
}

async function searchRsvps(query) {
  const c = await getDb();
  const q = `%${query}%`;
  const res = await c.execute({
    sql:  `SELECT * FROM rsvps WHERE first_name LIKE ? OR last_name LIKE ? OR whatsapp LIKE ? ORDER BY updated_at DESC`,
    args: [q, q, q]
  });
  return res.rows;
}

async function getRsvpStats() {
  const c = await getDb();
  const res = await c.execute(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='attending'     THEN 1 ELSE 0 END) as attending,
      SUM(CASE WHEN status='not_attending' THEN 1 ELSE 0 END) as not_attending,
      SUM(CASE WHEN transport='yes'        THEN 1 ELSE 0 END) as needs_transport,
      SUM(CASE WHEN allergies IS NOT NULL AND allergies != '' AND allergies != 'none' THEN 1 ELSE 0 END) as has_allergies
    FROM rsvps
  `);
  const row = res.rows[0];
  return {
    total:           Number(row.total)           || 0,
    attending:       Number(row.attending)       || 0,
    not_attending:   Number(row.not_attending)   || 0,
    needs_transport: Number(row.needs_transport) || 0,
    has_allergies:   Number(row.has_allergies)   || 0
  };
}

async function deleteRsvp(id) {
  const c = await getDb();
  await c.execute({ sql: `DELETE FROM rsvps WHERE id=?`, args: [id] });
}

async function getAdmin(username) {
  const c = await getDb();
  const res = await c.execute({ sql: `SELECT * FROM admins WHERE username=? LIMIT 1`, args: [username] });
  return res.rows[0] || null;
}

async function createAdmin(username, hashedPassword) {
  const c = await getDb();
  await c.execute({ sql: `INSERT OR IGNORE INTO admins (username, password) VALUES (?,?)`, args: [username, hashedPassword] });
}

async function getAllAdmins() {
  const c = await getDb();
  const res = await c.execute(`SELECT id, username FROM admins ORDER BY id ASC`);
  return res.rows;
}

async function deleteAdmin(id) {
  const c = await getDb();
  await c.execute({ sql: `DELETE FROM admins WHERE id=?`, args: [id] });
}

module.exports = {
  getDb, upsertRsvp,
  findByNameOnly, findByNameAndPhone,
  getAllRsvps, searchRsvps, getRsvpStats,
  deleteRsvp, getAdmin, createAdmin,
  getAllAdmins, deleteAdmin
};
