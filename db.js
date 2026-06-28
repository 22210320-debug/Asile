const fs = require('fs/promises');
const path = require('path');

const dbFile = path.join(__dirname, 'db.json');
let dbWriteQueue = Promise.resolve();
let pool = null;
let initPromise = null;

function usePostgres() { return Boolean(process.env.DATABASE_URL); }
function getPool() {
  if (!usePostgres()) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  }
  return pool;
}

async function initDb() {
  if (!usePostgres()) return;
  if (initPromise) return initPromise;
  const p = getPool();
  initPromise = p.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      status TEXT NOT NULL DEFAULT 'valid',
      attendee_name TEXT,
      attendee_first_name TEXT,
      attendee_last_name TEXT,
      gender TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scan_history (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT REFERENCES tickets(id),
      scanned_by TEXT,
      result TEXT NOT NULL,
      scanned_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders ((data->>'status'));
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_attendee_name ON tickets(attendee_name);
    CREATE INDEX IF NOT EXISTS idx_tickets_attendee_first_last ON tickets(attendee_first_name, attendee_last_name);
  `);
  return initPromise;
}

async function readDb() {
  if (!usePostgres()) {
    try { return JSON.parse(await fs.readFile(dbFile, 'utf8')); }
    catch { const fresh = { orders: [], tickets: [], scanHistory: [] }; await writeDb(fresh); return fresh; }
  }
  await initDb();
  const p = getPool();
  const [orders, tickets, scanHistory] = await Promise.all([
    p.query('SELECT data FROM orders ORDER BY created_at DESC'),
    p.query('SELECT data FROM tickets ORDER BY created_at DESC'),
    p.query('SELECT ticket_id, scanned_by, result, scanned_at FROM scan_history ORDER BY scanned_at DESC LIMIT 200')
  ]);
  return {
    orders: orders.rows.map(r => r.data),
    tickets: tickets.rows.map(r => r.data),
    scanHistory: scanHistory.rows.map(r => ({ ticketId: r.ticket_id, scannedBy: r.scanned_by, result: r.result, scannedAt: r.scanned_at }))
  };
}

async function writeDb(data) {
  if (!usePostgres()) {
    dbWriteQueue = dbWriteQueue.then(() => fs.writeFile(dbFile, JSON.stringify(data, null, 2)));
    return dbWriteQueue;
  }
  await initDb();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const order of data.orders || []) {
      await client.query(
        `INSERT INTO orders (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [order.id, JSON.stringify(order)]
      );
    }
    for (const ticket of data.tickets || []) {
      await client.query(
        `INSERT INTO tickets (id, order_id, status, attendee_name, attendee_first_name, attendee_last_name, gender, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, status = EXCLUDED.status, attendee_name = EXCLUDED.attendee_name, attendee_first_name = EXCLUDED.attendee_first_name, attendee_last_name = EXCLUDED.attendee_last_name, gender = EXCLUDED.gender, data = EXCLUDED.data, updated_at = NOW()`,
        [ticket.id, ticket.orderId || null, ticket.status || 'valid', ticket.attendeeName || null, ticket.attendeeFirstName || null, ticket.attendeeLastName || null, ticket.gender || null, JSON.stringify(ticket)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function upsertOrder(order) {
  if (!usePostgres()) {
    const db = await readDb();
    const index = db.orders.findIndex(o => o.id === order.id);
    if (index >= 0) db.orders[index] = order;
    else db.orders.push(order);
    await writeDb(db);
    return;
  }
  await initDb();
  const p = getPool();
  await p.query(
    `INSERT INTO orders (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [order.id, JSON.stringify(order)]
  );
}

async function upsertTicket(ticket) {
  if (!usePostgres()) {
    const db = await readDb();
    const index = db.tickets.findIndex(t => t.id === ticket.id);
    if (index >= 0) db.tickets[index] = ticket;
    else db.tickets.push(ticket);
    await writeDb(db);
    return;
  }
  await initDb();
  const p = getPool();
  await p.query(
    `INSERT INTO tickets (id, order_id, status, attendee_name, attendee_first_name, attendee_last_name, gender, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, status = EXCLUDED.status, attendee_name = EXCLUDED.attendee_name, attendee_first_name = EXCLUDED.attendee_first_name, attendee_last_name = EXCLUDED.attendee_last_name, gender = EXCLUDED.gender, data = EXCLUDED.data, updated_at = NOW()`,
    [ticket.id, ticket.orderId || null, ticket.status || 'valid', ticket.attendeeName || null, ticket.attendeeFirstName || null, ticket.attendeeLastName || null, ticket.gender || null, JSON.stringify(ticket)]
  );
}

async function safeCheckIn(ticketId, adminName) {
  if (!usePostgres()) {
    const db = await readDb();
    const ticket = db.tickets.find(t => t.id === ticketId);
    let result = 'not_found';
    if (ticket && ticket.status === 'valid') { ticket.status = 'used'; ticket.usedAt = new Date().toISOString(); ticket.usedBy = adminName; result = 'checked_in'; }
    else if (ticket) result = 'already_used';
    db.scanHistory = db.scanHistory || [];
    db.scanHistory.unshift({ ticketId, scannedBy: adminName, result, scannedAt: new Date().toISOString() });
    await writeDb(db);
    return { ticket, result };
  }
  await initDb();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const update = await client.query(
      `UPDATE tickets SET status='used', data=jsonb_set(jsonb_set(data, '{status}', '"used"'), '{usedAt}', to_jsonb(NOW()::text)) || jsonb_build_object('usedBy', $2), updated_at=NOW()
       WHERE id=$1 AND status='valid' RETURNING data`, [ticketId, adminName]
    );
    let result = 'checked_in';
    let ticket;
    if (update.rowCount) ticket = update.rows[0].data;
    else {
      const existing = await client.query('SELECT data FROM tickets WHERE id=$1', [ticketId]);
      ticket = existing.rows[0]?.data;
      result = ticket ? 'already_used' : 'not_found';
    }
    await client.query('INSERT INTO scan_history (ticket_id, scanned_by, result) VALUES ($1, $2, $3)', [ticketId, adminName, result]);
    await client.query('COMMIT');
    return { ticket, result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

module.exports = { initDb, readDb, writeDb, upsertOrder, upsertTicket, safeCheckIn, usePostgres };
