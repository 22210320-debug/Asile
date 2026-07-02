const fs = require('fs/promises');
const path = require('path');

const dbFile = path.join(__dirname, 'db.json');
let dbWriteQueue = Promise.resolve();
let pool = null;
let initPromise = null;

// Single, app-wide key for the reservation advisory lock so that capacity and
// duplicate-name checks are serialized against concurrent reservations.
const RESERVE_LOCK_KEY = 728492;

async function readJsonFile() {
  try { return JSON.parse(await fs.readFile(dbFile, 'utf8')); }
  catch { return { orders: [], tickets: [], scanHistory: [] }; }
}

function usePostgres() { return Boolean(process.env.DATABASE_URL); }
function getPool() {
  if (!usePostgres()) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 8000),
      query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 10000),
      statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 10000)
    });
    // Managed Postgres (DigitalOcean) silently drops idle connections. Without
    // this listener, pg re-emits that as an 'error' on the pool with no handler,
    // which crashes the whole Node process -> intermittent 502s. Log and let the
    // pool discard the dead client and reconnect on the next query.
    pool.on('error', err => console.error('Postgres idle client error (recovered):', err.message));
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

async function readAdminDashboard({ orderLimit = 10, orderOffset = 0, ticketLimit = 10, ticketOffset = 0, scanLimit = 10, scanOffset = 0 } = {}) {
  if (!usePostgres()) {
    const db = await readDb();
    const issuedTickets = (db.tickets || []).filter(ticket => ['valid', 'used'].includes(ticket.status));
    const activeOrders = (db.orders || []).filter(order => {
      const inactive = ['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'];
      if (inactive.includes(order.status)) return false;
      if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
        const created = new Date(order.createdAt || 0).getTime();
        return Date.now() - created < 30 * 60 * 1000;
      }
      return true;
    });
    return {
      orders: (db.orders || []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(orderOffset, orderOffset + orderLimit),
      tickets: issuedTickets.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(ticketOffset, ticketOffset + ticketLimit).map(ticket => ({ ...ticket, qrDataUrl: undefined })),
      scanHistory: (db.scanHistory || []).slice().sort((a, b) => new Date(b.scannedAt || 0) - new Date(a.scannedAt || 0)).slice(scanOffset, scanOffset + scanLimit),
      allOrders: db.orders || [],
      allTickets: db.tickets || [],
      approvedCount: issuedTickets.length,
      orderCount: (db.orders || []).length,
      ticketCount: issuedTickets.length,
      scanCount: (db.scanHistory || []).length,
      stats: {
        approvedCount: issuedTickets.length,
        awaitingPaymentCount: (db.orders || []).filter(order => order.status === 'awaiting_payment_authorization').length,
        stuckOrderCount: (db.orders || []).filter(order => {
          if (['payment_error', 'cancelled'].includes(order.status)) return true;
          if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
            const created = new Date(order.createdAt || 0).getTime();
            return !created || Date.now() - created >= 30 * 60 * 1000;
          }
          return false;
        }).length,
        remainingSoldOrPending: activeOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0),
        pendingCount: (db.orders || [])
          .filter(order => order.status === 'pending_admin_approval')
          .reduce((sum, order) => sum + (order.attendees || []).length, 0)
      }
    };
  }
  await initDb();
  const p = getPool();
  const [orders, tickets, scanHistory, orderCount, ticketCount, scanCount, orderStats] = await Promise.all([
    p.query('SELECT data FROM orders ORDER BY created_at DESC LIMIT $1 OFFSET $2', [orderLimit, orderOffset]),
    p.query(`SELECT data - 'qrDataUrl' AS data FROM tickets WHERE status IN ('valid', 'used') ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [ticketLimit, ticketOffset]),
    p.query('SELECT ticket_id, scanned_by, result, scanned_at FROM scan_history ORDER BY scanned_at DESC LIMIT $1 OFFSET $2', [scanLimit, scanOffset]),
    p.query('SELECT COUNT(*)::int AS count FROM orders'),
    p.query(`SELECT COUNT(*)::int AS count FROM tickets WHERE status IN ('valid', 'used')`),
    p.query('SELECT COUNT(*)::int AS count FROM scan_history'),
    p.query(`
      SELECT
        COUNT(*) FILTER (WHERE data->>'status' = 'awaiting_payment_authorization')::int AS awaiting_payment_count,
        COUNT(*) FILTER (
          WHERE data->>'status' IN ('payment_error', 'cancelled')
             OR (data->>'status' IN ('checkout_started', 'awaiting_payment_authorization') AND created_at <= NOW() - INTERVAL '30 minutes')
        )::int AS stuck_order_count,
        COALESCE(SUM(
          CASE WHEN data->>'status' = 'pending_admin_approval'
            THEN jsonb_array_length(COALESCE(data->'attendees', '[]'::jsonb))
            ELSE 0
          END
        ), 0)::int AS pending_count,
        COALESCE(SUM(
          CASE WHEN NOT (data->>'status' = ANY($1::text[]))
            AND (
              data->>'status' NOT IN ('checkout_started', 'awaiting_payment_authorization')
              OR created_at > NOW() - INTERVAL '30 minutes'
            )
            THEN COALESCE((data->>'qty')::int, 0)
            ELSE 0
          END
        ), 0)::int AS remaining_sold_or_pending
      FROM orders
    `, [['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired']])
  ]);
  const statsRow = orderStats.rows[0] || {};
  return {
    orders: orders.rows.map(r => r.data),
    tickets: tickets.rows.map(r => r.data),
    scanHistory: scanHistory.rows.map(r => ({ ticketId: r.ticket_id, scannedBy: r.scanned_by, result: r.result, scannedAt: r.scanned_at })),
    allOrders: [],
    allTickets: [],
    approvedCount: ticketCount.rows[0]?.count || 0,
    orderCount: orderCount.rows[0]?.count || 0,
    ticketCount: ticketCount.rows[0]?.count || 0,
    scanCount: scanCount.rows[0]?.count || 0,
    stats: {
      approvedCount: ticketCount.rows[0]?.count || 0,
      awaitingPaymentCount: statsRow.awaiting_payment_count || 0,
      stuckOrderCount: statsRow.stuck_order_count || 0,
      remainingSoldOrPending: statsRow.remaining_sold_or_pending || 0,
      pendingCount: statsRow.pending_count || 0
    }
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

async function deleteOrders(orderIds = []) {
  const ids = orderIds.filter(Boolean);
  if (!ids.length) return 0;
  if (!usePostgres()) {
    const db = await readDb();
    const before = db.orders.length;
    db.orders = db.orders.filter(order => !ids.includes(order.id));
    await writeDb(db);
    return before - db.orders.length;
  }
  await initDb();
  const p = getPool();
  const result = await p.query('DELETE FROM orders WHERE id = ANY($1::text[])', [ids]);
  return result.rowCount || 0;
}

async function deleteTickets(ticketIds = []) {
  const ids = ticketIds.filter(Boolean);
  if (!ids.length) return 0;
  if (!usePostgres()) {
    const db = await readDb();
    const before = db.tickets.length;
    db.tickets = db.tickets.filter(ticket => !ids.includes(ticket.id));
    db.scanHistory = (db.scanHistory || []).filter(scan => !ids.includes(scan.ticketId));
    await writeDb(db);
    return before - db.tickets.length;
  }
  await initDb();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM scan_history WHERE ticket_id = ANY($1::text[])', [ids]);
    const result = await client.query('DELETE FROM tickets WHERE id = ANY($1::text[])', [ids]);
    await client.query('COMMIT');
    return result.rowCount || 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteOrderWithTickets(orderId) {
  if (!orderId) return { ordersDeleted: 0, ticketsDeleted: 0 };
  if (!usePostgres()) {
    const db = await readDb();
    const beforeOrders = db.orders.length;
    const beforeTickets = db.tickets.length;
    const ticketIds = db.tickets.filter(ticket => ticket.orderId === orderId).map(ticket => ticket.id);
    db.orders = db.orders.filter(order => order.id !== orderId);
    db.tickets = db.tickets.filter(ticket => ticket.orderId !== orderId);
    db.scanHistory = (db.scanHistory || []).filter(scan => !ticketIds.includes(scan.ticketId));
    await writeDb(db);
    return { ordersDeleted: beforeOrders - db.orders.length, ticketsDeleted: beforeTickets - db.tickets.length };
  }
  await initDb();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const ticketIds = await client.query('SELECT id FROM tickets WHERE order_id=$1', [orderId]);
    const ids = ticketIds.rows.map(row => row.id);
    if (ids.length) await client.query('DELETE FROM scan_history WHERE ticket_id = ANY($1::text[])', [ids]);
    const tickets = await client.query('DELETE FROM tickets WHERE order_id=$1', [orderId]);
    const orders = await client.query('DELETE FROM orders WHERE id=$1', [orderId]);
    await client.query('COMMIT');
    return { ordersDeleted: orders.rowCount || 0, ticketsDeleted: tickets.rowCount || 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function resetEventData() {
  if (!usePostgres()) {
    await writeDb({ orders: [], tickets: [], scanHistory: [] });
    return;
  }
  await initDb();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM scan_history');
    await client.query('DELETE FROM tickets');
    await client.query('DELETE FROM orders');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

// Atomically validate-and-commit a reservation so two simultaneous buyers can
// never oversell capacity or double-book the same attendee name.
// `validateAndBuild(freshDb)` is run against the latest data while the write is
// held exclusive. It returns `{ error }` to reject, or `{ order, tickets }` to
// persist. The whole thing is one Postgres transaction (guarded by an advisory
// lock), or a serialized step on the JSON write queue for local development.
async function reserveAtomic(validateAndBuild) {
  if (!usePostgres()) {
    let outcome = { error: 'unknown' };
    dbWriteQueue = dbWriteQueue.then(async () => {
      const db = await readJsonFile();
      outcome = await validateAndBuild(db);
      if (outcome.error) return;
      if (outcome.order) {
        const i = db.orders.findIndex(o => o.id === outcome.order.id);
        if (i >= 0) db.orders[i] = outcome.order; else db.orders.push(outcome.order);
      }
      for (const t of outcome.tickets || []) {
        const i = db.tickets.findIndex(x => x.id === t.id);
        if (i >= 0) db.tickets[i] = t; else db.tickets.push(t);
      }
      await fs.writeFile(dbFile, JSON.stringify(db, null, 2));
    });
    await dbWriteQueue;
    return outcome;
  }
  await initDb();
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [RESERVE_LOCK_KEY]);
    const [orders, tickets] = await Promise.all([
      client.query('SELECT data FROM orders'),
      client.query('SELECT data FROM tickets')
    ]);
    const db = { orders: orders.rows.map(r => r.data), tickets: tickets.rows.map(r => r.data), scanHistory: [] };
    const outcome = await validateAndBuild(db);
    if (outcome.error) { await client.query('ROLLBACK'); return outcome; }
    if (outcome.order) {
      await client.query(
        `INSERT INTO orders (id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [outcome.order.id, JSON.stringify(outcome.order)]
      );
    }
    for (const t of outcome.tickets || []) {
      await client.query(
        `INSERT INTO tickets (id, order_id, status, attendee_name, attendee_first_name, attendee_last_name, gender, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, status = EXCLUDED.status, attendee_name = EXCLUDED.attendee_name, attendee_first_name = EXCLUDED.attendee_first_name, attendee_last_name = EXCLUDED.attendee_last_name, gender = EXCLUDED.gender, data = EXCLUDED.data, updated_at = NOW()`,
        [t.id, t.orderId || null, t.status || 'valid', t.attendeeName || null, t.attendeeFirstName || null, t.attendeeLastName || null, t.gender || null, JSON.stringify(t)]
      );
    }
    await client.query('COMMIT');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initDb, readDb, readAdminDashboard, writeDb, upsertOrder, upsertTicket, deleteOrders, deleteTickets, deleteOrderWithTickets, resetEventData, safeCheckIn, usePostgres, getPool, reserveAtomic };
