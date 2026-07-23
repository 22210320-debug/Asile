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
  catch { return { orders: [], tickets: [], scanHistory: [], vipCodes: [], waitlistEntries: [], managedEvents: [] }; }
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

function isTransientDbError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('timeout')
    || message.includes('connection terminated')
    || message.includes('connection closed')
    || message.includes('terminating connection');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pgQuery(sql, params = []) {
  const attempts = Math.max(1, Number(process.env.DATABASE_QUERY_RETRIES || 2));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getPool().query(sql, params);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      console.warn(`Postgres query retry ${attempt}/${attempts}:`, err.message);
      await wait(250 * attempt);
    }
  }
  throw lastError;
}

async function initDb() {
  if (!usePostgres()) return;
  if (initPromise) return initPromise;
  initPromise = pgQuery(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      event_id TEXT,
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
    CREATE TABLE IF NOT EXISTS vip_codes (
      code TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS waitlist_entries (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'waitlisted',
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS managed_events (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'draft',
      event_date DATE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders ((data->>'status'));
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_attendee_name ON tickets(attendee_name);
    CREATE INDEX IF NOT EXISTS idx_tickets_attendee_first_last ON tickets(attendee_first_name, attendee_last_name);
    CREATE INDEX IF NOT EXISTS idx_scan_history_scanned_at ON scan_history (scanned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_waitlist_status_created_at ON waitlist_entries (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_entries (email);
    CREATE INDEX IF NOT EXISTS idx_waitlist_phone ON waitlist_entries (phone);
    CREATE INDEX IF NOT EXISTS idx_managed_events_status_date ON managed_events (status, event_date ASC);
  `).then(async () => {
    await pgQuery('ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_id TEXT');
    await pgQuery('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_id TEXT');
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_orders_event_id ON orders (event_id, created_at DESC)');
    await pgQuery('CREATE INDEX IF NOT EXISTS idx_tickets_event_id ON tickets (event_id, created_at DESC)');
    const defaultEventId = process.env.EVENT_ID || 'sunset-house-party-2026';
    await pgQuery(
      `UPDATE orders
       SET event_id=$1::text,
           data=CASE WHEN COALESCE(data->>'eventId', '') = '' THEN data || jsonb_build_object('eventId', $1::text) ELSE data END
       WHERE event_id IS NULL`,
      [defaultEventId]
    );
    await pgQuery(
      `UPDATE tickets t
       SET event_id=COALESCE(o.event_id, $1::text),
           data=CASE WHEN COALESCE(t.data->>'eventId', '') = '' THEN t.data || jsonb_build_object('eventId', COALESCE(o.event_id, $1::text)) ELSE t.data END
       FROM orders o
       WHERE t.order_id=o.id AND t.event_id IS NULL`,
      [defaultEventId]
    );
    await pgQuery(
      `UPDATE tickets
       SET event_id=$1::text,
           data=CASE WHEN COALESCE(data->>'eventId', '') = '' THEN data || jsonb_build_object('eventId', $1::text) ELSE data END
       WHERE event_id IS NULL`,
      [defaultEventId]
    );
  }).catch(err => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function readDb() {
  if (!usePostgres()) {
    try { return JSON.parse(await fs.readFile(dbFile, 'utf8')); }
    catch { const fresh = { orders: [], tickets: [], scanHistory: [], vipCodes: [], waitlistEntries: [], managedEvents: [] }; await writeDb(fresh); return fresh; }
  }
  await initDb();
  const [orders, tickets, scanHistory, vipCodes] = await Promise.all([
    pgQuery('SELECT data FROM orders ORDER BY created_at DESC'),
    pgQuery('SELECT data FROM tickets ORDER BY created_at DESC'),
    pgQuery('SELECT ticket_id, scanned_by, result, scanned_at FROM scan_history ORDER BY scanned_at DESC LIMIT 200'),
    pgQuery('SELECT data FROM vip_codes ORDER BY created_at DESC')
  ]);
  return {
    orders: orders.rows.map(r => r.data),
    tickets: tickets.rows.map(r => r.data),
    scanHistory: scanHistory.rows.map(r => ({ ticketId: r.ticket_id, scannedBy: r.scanned_by, result: r.result, scannedAt: r.scanned_at })),
    vipCodes: vipCodes.rows.map(r => r.data)
  };
}

const WAITLIST_STATUSES = ['waitlisted', 'contacted', 'invited', 'confirmed', 'removed'];
const MANAGED_EVENT_STATUSES = ['draft', 'published', 'archived'];

function cleanManagedEventStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return MANAGED_EVENT_STATUSES.includes(status) ? status : 'draft';
}

function sortManagedEvents(events = []) {
  return events.slice().sort((a, b) => {
    const dateA = String(a.eventDate || '9999-12-31');
    const dateB = String(b.eventDate || '9999-12-31');
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}

async function listManagedEvents({ publicOnly = false } = {}) {
  if (!usePostgres()) {
    const db = await readJsonFile();
    const events = Array.isArray(db.managedEvents) ? db.managedEvents : [];
    return sortManagedEvents(publicOnly ? events.filter(event => event.status === 'published') : events);
  }
  await initDb();
  const result = publicOnly
    ? await pgQuery("SELECT data FROM managed_events WHERE status='published' ORDER BY event_date ASC NULLS LAST, created_at DESC")
    : await pgQuery('SELECT data FROM managed_events ORDER BY event_date ASC NULLS LAST, created_at DESC');
  return result.rows.map(row => row.data);
}

async function getManagedEvent(eventId) {
  if (!eventId) return null;
  if (!usePostgres()) {
    const db = await readJsonFile();
    return (db.managedEvents || []).find(event => event.id === eventId) || null;
  }
  await initDb();
  const result = await pgQuery('SELECT data FROM managed_events WHERE id=$1', [eventId]);
  return result.rows[0]?.data || null;
}

async function upsertManagedEvent(event) {
  const now = new Date().toISOString();
  const incoming = {
    ...event,
    status: cleanManagedEventStatus(event.status),
    createdAt: event.createdAt || now,
    updatedAt: now
  };

  if (!usePostgres()) {
    let saved;
    dbWriteQueue = dbWriteQueue.then(async () => {
      const db = await readJsonFile();
      db.managedEvents = db.managedEvents || [];
      const index = db.managedEvents.findIndex(item => item.id === incoming.id);
      if (index >= 0) {
        saved = { ...db.managedEvents[index], ...incoming, createdAt: db.managedEvents[index].createdAt || now };
        db.managedEvents[index] = saved;
      } else {
        saved = incoming;
        db.managedEvents.unshift(saved);
      }
      await fs.writeFile(dbFile, JSON.stringify(db, null, 2));
    });
    await dbWriteQueue;
    return saved;
  }

  await initDb();
  const existing = await getManagedEvent(incoming.id);
  const saved = { ...incoming, createdAt: existing?.createdAt || incoming.createdAt || now };
  await pgQuery(
    `INSERT INTO managed_events (id, status, event_date, data)
     VALUES ($1, $2, $3::date, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, event_date=EXCLUDED.event_date, data=EXCLUDED.data, updated_at=NOW()`,
    [saved.id, saved.status, saved.eventDate || null, JSON.stringify(saved)]
  );
  return saved;
}

function cleanWaitlistStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return WAITLIST_STATUSES.includes(status) ? status : '';
}

function waitlistMatchesSearch(entry, query) {
  if (!query) return true;
  return [entry.id, entry.fullName, entry.phone, entry.email, entry.instagramUsername]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(query));
}

async function upsertWaitlistEntry(entry) {
  const now = new Date().toISOString();
  const incoming = {
    ...entry,
    email: String(entry.email || '').trim().toLowerCase(),
    phone: String(entry.phone || '').trim(),
    status: cleanWaitlistStatus(entry.status) || 'waitlisted',
    createdAt: entry.createdAt || now,
    updatedAt: now
  };

  if (!usePostgres()) {
    let outcome;
    dbWriteQueue = dbWriteQueue.then(async () => {
      const db = await readJsonFile();
      db.waitlistEntries = db.waitlistEntries || [];
      const matches = db.waitlistEntries.filter(item => item.email === incoming.email || item.phone === incoming.phone);
      if (matches.length > 1) {
        outcome = { error: 'conflicting_duplicate' };
        return;
      }
      if (matches.length === 1) {
        const existing = matches[0];
        const updated = { ...existing, ...incoming, id: existing.id, status: existing.status || 'waitlisted', createdAt: existing.createdAt || now, updatedAt: now };
        db.waitlistEntries[db.waitlistEntries.indexOf(existing)] = updated;
        outcome = { entry: updated, created: false };
      } else {
        db.waitlistEntries.unshift(incoming);
        outcome = { entry: incoming, created: true };
      }
      await fs.writeFile(dbFile, JSON.stringify(db, null, 2));
    });
    await dbWriteQueue;
    return outcome;
  }

  await initDb();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const matches = await client.query(
      'SELECT id, data, status, created_at FROM waitlist_entries WHERE email=$1 OR phone=$2 FOR UPDATE',
      [incoming.email, incoming.phone]
    );
    if (matches.rowCount > 1) {
      await client.query('ROLLBACK');
      return { error: 'conflicting_duplicate' };
    }
    if (matches.rowCount === 1) {
      const existing = matches.rows[0];
      const updated = {
        ...existing.data,
        ...incoming,
        id: existing.id,
        status: existing.status || existing.data.status || 'waitlisted',
        createdAt: existing.data.createdAt || existing.created_at?.toISOString?.() || now,
        updatedAt: now
      };
      await client.query(
        'UPDATE waitlist_entries SET email=$2, phone=$3, status=$4, data=$5::jsonb, updated_at=NOW() WHERE id=$1',
        [existing.id, updated.email, updated.phone, updated.status, JSON.stringify(updated)]
      );
      await client.query('COMMIT');
      return { entry: updated, created: false };
    }
    await client.query(
      'INSERT INTO waitlist_entries (id, email, phone, status, data) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [incoming.id, incoming.email, incoming.phone, incoming.status, JSON.stringify(incoming)]
    );
    await client.query('COMMIT');
    return { entry: incoming, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return { error: 'duplicate_race' };
    throw err;
  } finally {
    client.release();
  }
}

async function readWaitlistDashboard({ limit = 50, offset = 0, search = '', status = '' } = {}) {
  const cleanSearch = normalizeSearch(search);
  const selectedStatus = cleanWaitlistStatus(status);
  if (!usePostgres()) {
    const db = await readDb();
    const all = (db.waitlistEntries || []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const filtered = all.filter(entry => waitlistMatchesSearch(entry, cleanSearch) && (!selectedStatus || entry.status === selectedStatus));
    const today = new Date().toISOString().slice(0, 10);
    return {
      entries: filtered.slice(offset, offset + limit),
      total: filtered.length,
      totalAll: all.length,
      newToday: all.filter(entry => String(entry.createdAt || '').slice(0, 10) === today).length
    };
  }
  await initDb();
  const params = [];
  const clauses = [];
  if (cleanSearch) {
    params.push(`%${cleanSearch}%`);
    clauses.push(`(id ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length} OR data->>'fullName' ILIKE $${params.length} OR data->>'instagramUsername' ILIKE $${params.length})`);
  }
  if (selectedStatus) {
    params.push(selectedStatus);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const entriesParams = [...params, limit, offset];
  const [entries, total, totals] = await Promise.all([
    pgQuery(`SELECT data FROM waitlist_entries ${where} ORDER BY created_at DESC LIMIT $${entriesParams.length - 1} OFFSET $${entriesParams.length}`, entriesParams),
    pgQuery(`SELECT COUNT(*)::int AS count FROM waitlist_entries ${where}`, params),
    pgQuery("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS new_today FROM waitlist_entries")
  ]);
  return {
    entries: entries.rows.map(row => row.data),
    total: total.rows[0]?.count || 0,
    totalAll: totals.rows[0]?.total || 0,
    newToday: totals.rows[0]?.new_today || 0
  };
}

async function updateWaitlistStatus(id, status) {
  const cleanStatus = cleanWaitlistStatus(status);
  if (!id || !cleanStatus) return null;
  const now = new Date().toISOString();
  if (!usePostgres()) {
    const db = await readDb();
    const index = (db.waitlistEntries || []).findIndex(entry => entry.id === id);
    if (index < 0) return null;
    db.waitlistEntries[index] = { ...db.waitlistEntries[index], status: cleanStatus, updatedAt: now };
    await writeDb(db);
    return db.waitlistEntries[index];
  }
  await initDb();
  const result = await pgQuery(
    "UPDATE waitlist_entries SET status=$2, data=jsonb_set(data, '{status}', to_jsonb($2::text)) || jsonb_build_object('updatedAt', $3), updated_at=NOW() WHERE id=$1 RETURNING data",
    [id, cleanStatus, now]
  );
  return result.rows[0]?.data || null;
}

async function exportWaitlistEntries() {
  if (!usePostgres()) {
    const db = await readDb();
    return (db.waitlistEntries || []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }
  await initDb();
  const result = await pgQuery('SELECT data FROM waitlist_entries ORDER BY created_at DESC');
  return result.rows.map(row => row.data);
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function isActiveReservationOrder(order) {
  const inactive = ['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'];
  if (!order || inactive.includes(order.status)) return false;
  if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
    const created = new Date(order.createdAt || 0).getTime();
    return Boolean(created) && Date.now() - created < 30 * 60 * 1000;
  }
  return true;
}

function vipCodeUsageFromOrders(orders = [], code = '') {
  const key = String(code || '').trim().toUpperCase();
  return (orders || [])
    .filter(order => isActiveReservationOrder(order) && String(order.vipCode || '').trim().toUpperCase() === key)
    .reduce((sum, order) => sum + Number(order.qty || 0), 0);
}

function orderMatchesSearch(order, query) {
  if (!query) return true;
  const attendeeText = (order.attendees || [])
    .map(attendee => [attendee.name, attendee.firstName, attendee.lastName].filter(Boolean).join(' '))
    .join(' ');
  return [order.id, order.buyerName, order.buyerEmail, attendeeText]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(query));
}

function cleanOrderStatus(value) {
  const status = String(value || '').trim();
  const allowed = new Set([
    'awaiting_payment_authorization',
    'pending_admin_approval',
    'approved_captured',
    'denied_released',
    'authorization_expired',
    'payment_error',
    'cancelled',
    'checkout_started'
  ]);
  return allowed.has(status) ? status : '';
}

function orderMatchesStatus(order, status) {
  return !status || order.status === status;
}

function ticketMatchesSearch(ticket, query) {
  if (!query) return true;
  return [ticket.id, ticket.orderId, ticket.attendeeName, ticket.attendeeFirstName, ticket.attendeeLastName, ticket.buyerName, ticket.buyerEmail]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(query));
}

function orderFilterWhere(searchIndex, statusIndex, eventIndex = 0) {
  const clauses = [];
  if (eventIndex) clauses.push(`event_id = $${eventIndex}`);
  if (searchIndex) {
    clauses.push(`(
      id ILIKE $${searchIndex}
      OR data->>'buyerName' ILIKE $${searchIndex}
      OR data->>'buyerEmail' ILIKE $${searchIndex}
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(data->'attendees', '[]'::jsonb)) AS attendee
        WHERE attendee->>'name' ILIKE $${searchIndex}
           OR attendee->>'firstName' ILIKE $${searchIndex}
           OR attendee->>'lastName' ILIKE $${searchIndex}
      )
    )`);
  }
  if (statusIndex) clauses.push(`data->>'status' = $${statusIndex}`);
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function ticketSearchWhere(index, prefix = 'WHERE') {
  return `
    ${prefix} (
      id ILIKE $${index}
      OR COALESCE(order_id, '') ILIKE $${index}
      OR COALESCE(attendee_name, '') ILIKE $${index}
      OR COALESCE(attendee_first_name, '') ILIKE $${index}
      OR COALESCE(attendee_last_name, '') ILIKE $${index}
      OR data->>'buyerName' ILIKE $${index}
      OR data->>'buyerEmail' ILIKE $${index}
    )
  `;
}

async function readAdminDashboard({ orderLimit = 10, orderOffset = 0, orderSearch = '', orderStatus = '', ticketLimit = 10, ticketOffset = 0, ticketSearch = '', scanLimit = 10, scanOffset = 0, eventId = '', legacyEventName = '' } = {}) {
  const cleanOrderSearch = normalizeSearch(orderSearch);
  const selectedOrderStatus = cleanOrderStatus(orderStatus);
  const cleanTicketSearch = normalizeSearch(ticketSearch);
  if (!usePostgres()) {
    const db = await readDb();
    const defaultEventId = process.env.EVENT_ID || 'sunset-house-party-2026';
    const matchesEvent = item => !eventId || item.eventId === eventId || (!item.eventId && item.eventName === legacyEventName) || (!item.eventId && !item.eventName && eventId === defaultEventId);
    const eventOrders = (db.orders || []).filter(matchesEvent);
    const eventTickets = (db.tickets || []).filter(matchesEvent);
    const issuedTickets = eventTickets.filter(ticket => ['valid', 'used'].includes(ticket.status));
    const searchedOrders = eventOrders.filter(order => orderMatchesSearch(order, cleanOrderSearch) && orderMatchesStatus(order, selectedOrderStatus));
    const searchedTickets = issuedTickets.filter(ticket => ticketMatchesSearch(ticket, cleanTicketSearch));
    const activeOrders = eventOrders.filter(order => {
      const inactive = ['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'];
      if (inactive.includes(order.status)) return false;
      if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
        const created = new Date(order.createdAt || 0).getTime();
        return Date.now() - created < 30 * 60 * 1000;
      }
      return true;
    });
    const vipCodes = (db.vipCodes || []).filter(matchesEvent).map(code => ({
      ...code,
      usedTickets: vipCodeUsageFromOrders(eventOrders, code.code),
      remainingTickets: Math.max(0, Number(code.maxTickets || 0) - vipCodeUsageFromOrders(eventOrders, code.code))
    }));
    return {
      orders: searchedOrders.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(orderOffset, orderOffset + orderLimit),
      tickets: searchedTickets.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(ticketOffset, ticketOffset + ticketLimit).map(ticket => ({ ...ticket, qrDataUrl: undefined })),
      scanHistory: (db.scanHistory || []).filter(scan => eventTickets.some(ticket => ticket.id === scan.ticketId)).slice().sort((a, b) => new Date(b.scannedAt || 0) - new Date(a.scannedAt || 0)).slice(scanOffset, scanOffset + scanLimit),
      allOrders: eventOrders,
      allTickets: eventTickets,
      vipCodes,
      approvedCount: issuedTickets.length,
      orderCount: searchedOrders.length,
      ticketCount: searchedTickets.length,
      scanCount: (db.scanHistory || []).filter(scan => eventTickets.some(ticket => ticket.id === scan.ticketId)).length,
      stats: {
        approvedCount: issuedTickets.length,
        awaitingPaymentCount: eventOrders.filter(order => order.status === 'awaiting_payment_authorization').length,
        stuckOrderCount: eventOrders.filter(order => {
          if (['payment_error', 'cancelled'].includes(order.status)) return true;
          if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
            const created = new Date(order.createdAt || 0).getTime();
            return !created || Date.now() - created >= 30 * 60 * 1000;
          }
          return false;
        }).length,
        remainingSoldOrPending: activeOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0),
        pendingCount: eventOrders
          .filter(order => order.status === 'pending_admin_approval')
          .reduce((sum, order) => sum + (order.attendees || []).length, 0)
      }
    };
  }
  await initDb();
  const ticketSearchSql = cleanTicketSearch ? ticketSearchWhere(4, 'AND') : '';
  const ticketCountSearchSql = cleanTicketSearch ? ticketSearchWhere(2, 'AND') : '';
  const orderSearchParams = [eventId, orderLimit, orderOffset];
  let orderSearchIndex = 0;
  let orderStatusIndex = 0;
  if (cleanOrderSearch) {
    orderSearchParams.push(`%${cleanOrderSearch}%`);
    orderSearchIndex = orderSearchParams.length;
  }
  if (selectedOrderStatus) {
    orderSearchParams.push(selectedOrderStatus);
    orderStatusIndex = orderSearchParams.length;
  }
  const orderSearchSql = orderFilterWhere(orderSearchIndex, orderStatusIndex, 1);
  const orderCountParams = [eventId];
  let orderCountSearchIndex = 0;
  let orderCountStatusIndex = 0;
  if (cleanOrderSearch) {
    orderCountParams.push(`%${cleanOrderSearch}%`);
    orderCountSearchIndex = orderCountParams.length;
  }
  if (selectedOrderStatus) {
    orderCountParams.push(selectedOrderStatus);
    orderCountStatusIndex = orderCountParams.length;
  }
  const orderCountSearchSql = orderFilterWhere(orderCountSearchIndex, orderCountStatusIndex, 1);
  const ticketSearchParams = cleanTicketSearch ? [eventId, ticketLimit, ticketOffset, `%${cleanTicketSearch}%`] : [eventId, ticketLimit, ticketOffset];
  const ticketCountParams = cleanTicketSearch ? [eventId, `%${cleanTicketSearch}%`] : [eventId];
  const [orders, tickets, scanHistory, orderCount, ticketCount, scanCount, orderStats, vipCodes] = await Promise.all([
    pgQuery(`SELECT data FROM orders ${orderSearchSql} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, orderSearchParams),
    pgQuery(`SELECT data - 'qrDataUrl' AS data FROM tickets WHERE event_id=$1 AND status IN ('valid', 'used') ${ticketSearchSql} ORDER BY created_at DESC LIMIT $2 OFFSET $3`, ticketSearchParams),
    pgQuery('SELECT sh.ticket_id, sh.scanned_by, sh.result, sh.scanned_at FROM scan_history sh JOIN tickets t ON t.id=sh.ticket_id WHERE t.event_id=$1 ORDER BY sh.scanned_at DESC LIMIT $2 OFFSET $3', [eventId, scanLimit, scanOffset]),
    pgQuery(`SELECT COUNT(*)::int AS count FROM orders ${orderCountSearchSql}`, orderCountParams),
    pgQuery(`SELECT COUNT(*)::int AS count FROM tickets WHERE event_id=$1 AND status IN ('valid', 'used') ${ticketCountSearchSql}`, ticketCountParams),
    pgQuery('SELECT COUNT(*)::int AS count FROM scan_history sh JOIN tickets t ON t.id=sh.ticket_id WHERE t.event_id=$1', [eventId]),
    pgQuery(`
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
        ,
        (
          SELECT COUNT(*)::int
          FROM tickets
          WHERE event_id=$2 AND status IN ('valid', 'used')
            AND LOWER(COALESCE(data->>'gender', gender, '')) = 'female'
        ) + (
          SELECT COUNT(*)::int
          FROM orders o
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'attendees', '[]'::jsonb)) attendee
          WHERE o.event_id=$2 AND o.data->>'status' = 'pending_admin_approval'
            AND LOWER(COALESCE(attendee->>'gender', '')) = 'female'
        ) AS female_count,
        (
          SELECT COUNT(*)::int
          FROM tickets
          WHERE event_id=$2 AND status IN ('valid', 'used')
            AND LOWER(COALESCE(data->>'gender', gender, '')) = 'male'
        ) + (
          SELECT COUNT(*)::int
          FROM orders o
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'attendees', '[]'::jsonb)) attendee
          WHERE o.event_id=$2 AND o.data->>'status' = 'pending_admin_approval'
            AND LOWER(COALESCE(attendee->>'gender', '')) = 'male'
        ) AS male_count
      FROM orders
      WHERE event_id=$2
    `, [['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'], eventId]),
    pgQuery(`
      SELECT
        vc.data ||
        jsonb_build_object(
          'usedTickets', COALESCE(SUM(
            CASE WHEN NOT (o.data->>'status' = ANY($1::text[]))
              AND (
                o.data->>'status' NOT IN ('checkout_started', 'awaiting_payment_authorization')
                OR o.created_at > NOW() - INTERVAL '30 minutes'
              )
              THEN COALESCE((o.data->>'qty')::int, 0)
              ELSE 0
            END
          ), 0)::int,
          'remainingTickets', GREATEST(0, COALESCE((vc.data->>'maxTickets')::int, 0) - COALESCE(SUM(
            CASE WHEN NOT (o.data->>'status' = ANY($1::text[]))
              AND (
                o.data->>'status' NOT IN ('checkout_started', 'awaiting_payment_authorization')
                OR o.created_at > NOW() - INTERVAL '30 minutes'
              )
              THEN COALESCE((o.data->>'qty')::int, 0)
              ELSE 0
            END
          ), 0)::int)
        ) AS data
      FROM vip_codes vc
      LEFT JOIN orders o ON UPPER(o.data->>'vipCode') = vc.code AND o.event_id=$2
      WHERE COALESCE(vc.data->>'eventId', $3) = $2
      GROUP BY vc.code, vc.data, vc.created_at
      ORDER BY vc.created_at DESC
      LIMIT 50
    `, [['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'], eventId, process.env.EVENT_ID || 'sunset-house-party-2026'])
  ]);
  const statsRow = orderStats.rows[0] || {};
  return {
    orders: orders.rows.map(r => r.data),
    tickets: tickets.rows.map(r => r.data),
    scanHistory: scanHistory.rows.map(r => ({ ticketId: r.ticket_id, scannedBy: r.scanned_by, result: r.result, scannedAt: r.scanned_at })),
    allOrders: [],
    allTickets: [],
    vipCodes: vipCodes.rows.map(r => r.data),
    approvedCount: ticketCount.rows[0]?.count || 0,
    orderCount: orderCount.rows[0]?.count || 0,
    ticketCount: ticketCount.rows[0]?.count || 0,
    scanCount: scanCount.rows[0]?.count || 0,
    stats: {
      approvedCount: ticketCount.rows[0]?.count || 0,
      awaitingPaymentCount: statsRow.awaiting_payment_count || 0,
      stuckOrderCount: statsRow.stuck_order_count || 0,
      remainingSoldOrPending: statsRow.remaining_sold_or_pending || 0,
      pendingCount: statsRow.pending_count || 0,
      femaleCount: statsRow.female_count || 0,
      maleCount: statsRow.male_count || 0
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
        `INSERT INTO orders (id, event_id, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, data = EXCLUDED.data, updated_at = NOW()`,
        [order.id, order.eventId || process.env.EVENT_ID || 'sunset-house-party-2026', JSON.stringify(order)]
      );
    }
    for (const ticket of data.tickets || []) {
      await client.query(
        `INSERT INTO tickets (id, order_id, event_id, status, attendee_name, attendee_first_name, attendee_last_name, gender, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, event_id=EXCLUDED.event_id, status = EXCLUDED.status, attendee_name = EXCLUDED.attendee_name, attendee_first_name = EXCLUDED.attendee_first_name, attendee_last_name = EXCLUDED.attendee_last_name, gender = EXCLUDED.gender, data = EXCLUDED.data, updated_at = NOW()`,
        [ticket.id, ticket.orderId || null, ticket.eventId || process.env.EVENT_ID || 'sunset-house-party-2026', ticket.status || 'valid', ticket.attendeeName || null, ticket.attendeeFirstName || null, ticket.attendeeLastName || null, ticket.gender || null, JSON.stringify(ticket)]
      );
    }
    for (const vipCode of data.vipCodes || []) {
      await client.query(
        `INSERT INTO vip_codes (code, data, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [String(vipCode.code || '').trim().toUpperCase(), JSON.stringify({ ...vipCode, code: String(vipCode.code || '').trim().toUpperCase() })]
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
    `INSERT INTO orders (id, event_id, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, data = EXCLUDED.data, updated_at = NOW()`,
    [order.id, order.eventId || process.env.EVENT_ID || 'sunset-house-party-2026', JSON.stringify(order)]
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
    `INSERT INTO tickets (id, order_id, event_id, status, attendee_name, attendee_first_name, attendee_last_name, gender, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, event_id=EXCLUDED.event_id, status = EXCLUDED.status, attendee_name = EXCLUDED.attendee_name, attendee_first_name = EXCLUDED.attendee_first_name, attendee_last_name = EXCLUDED.attendee_last_name, gender = EXCLUDED.gender, data = EXCLUDED.data, updated_at = NOW()`,
    [ticket.id, ticket.orderId || null, ticket.eventId || process.env.EVENT_ID || 'sunset-house-party-2026', ticket.status || 'valid', ticket.attendeeName || null, ticket.attendeeFirstName || null, ticket.attendeeLastName || null, ticket.gender || null, JSON.stringify(ticket)]
  );
}

async function upsertVipCode(vipCode) {
  const code = String(vipCode.code || '').trim().toUpperCase();
  if (!code) throw new Error('VIP code is required');
  const data = {
    ...vipCode,
    code,
    maxTickets: Math.max(1, Number(vipCode.maxTickets || 1)),
    active: vipCode.active !== false,
    createdAt: vipCode.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!usePostgres()) {
    const db = await readDb();
    db.vipCodes = db.vipCodes || [];
    const index = db.vipCodes.findIndex(item => String(item.code || '').toUpperCase() === code);
    if (index >= 0) db.vipCodes[index] = data;
    else db.vipCodes.unshift(data);
    await writeDb(db);
    return data;
  }
  await initDb();
  await pgQuery(
    `INSERT INTO vip_codes (code, data, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [code, JSON.stringify(data)]
  );
  return data;
}

async function setVipCodeActive(codeValue, active) {
  const code = String(codeValue || '').trim().toUpperCase();
  if (!code) return;
  if (!usePostgres()) {
    const db = await readDb();
    db.vipCodes = (db.vipCodes || []).map(item => String(item.code || '').toUpperCase() === code ? { ...item, active, updatedAt: new Date().toISOString() } : item);
    await writeDb(db);
    return;
  }
  await initDb();
  await pgQuery(
    `UPDATE vip_codes
     SET data = jsonb_set(data || jsonb_build_object('updatedAt', to_jsonb(NOW()::text)), '{active}', to_jsonb($2::boolean)),
         updated_at = NOW()
     WHERE code = $1`,
    [code, active]
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
  const attempts = Math.max(1, Number(process.env.DATABASE_QUERY_RETRIES || 2));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let client;
    try {
      client = await getPool().connect();
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
      lastError = err;
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* Connection may already be closed. */ }
      }
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      console.warn(`Check-in retry ${attempt}/${attempts}:`, err.message);
      await wait(250 * attempt);
    } finally {
      if (client) client.release();
    }
  }
  throw lastError;
}

async function readRecentScans({ limit = 10 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  if (!usePostgres()) {
    const db = await readDb();
    const ticketsById = new Map((db.tickets || []).map(ticket => [ticket.id, ticket]));
    return (db.scanHistory || [])
      .slice()
      .sort((a, b) => new Date(b.scannedAt || 0) - new Date(a.scannedAt || 0))
      .slice(0, safeLimit)
      .map(scan => {
        const ticket = ticketsById.get(scan.ticketId);
        return {
          ...scan,
          attendeeName: ticket?.attendeeName || '',
          eventName: ticket?.eventName || '',
          ticketStatus: ticket?.status || ''
        };
      });
  }
  await initDb();
  const result = await pgQuery(
    `SELECT sh.ticket_id, sh.scanned_by, sh.result, sh.scanned_at,
            t.attendee_name, t.status AS ticket_status, t.data->>'eventName' AS event_name
     FROM scan_history sh
     LEFT JOIN tickets t ON t.id=sh.ticket_id
     ORDER BY sh.scanned_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map(row => ({
    ticketId: row.ticket_id,
    scannedBy: row.scanned_by,
    result: row.result,
    scannedAt: row.scanned_at,
    attendeeName: row.attendee_name || '',
    eventName: row.event_name || '',
    ticketStatus: row.ticket_status || ''
  }));
}

async function resetTicketCheckIn(ticketId, adminName) {
  if (!usePostgres()) {
    const db = await readDb();
    const ticket = (db.tickets || []).find(item => item.id === ticketId);
    if (!ticket) return { ticket: null, result: 'not_found' };
    if (ticket.status !== 'used') return { ticket, result: 'not_checked_in' };
    ticket.status = 'valid';
    delete ticket.usedAt;
    delete ticket.usedBy;
    db.scanHistory = db.scanHistory || [];
    db.scanHistory.unshift({ ticketId, scannedBy: adminName, result: 'check_in_reset', scannedAt: new Date().toISOString() });
    await writeDb(db);
    return { ticket, result: 'reset' };
  }
  await initDb();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const update = await client.query(
      `UPDATE tickets
       SET status='valid',
           data=(data - 'usedAt' - 'usedBy') || jsonb_build_object('status', 'valid'),
           updated_at=NOW()
       WHERE id=$1 AND status='used'
       RETURNING data`,
      [ticketId]
    );
    let ticket = update.rows[0]?.data || null;
    let result = 'reset';
    if (!ticket) {
      const existing = await client.query('SELECT data, status FROM tickets WHERE id=$1', [ticketId]);
      ticket = existing.rows[0]?.data || null;
      result = ticket ? 'not_checked_in' : 'not_found';
    } else {
      await client.query('INSERT INTO scan_history (ticket_id, scanned_by, result) VALUES ($1, $2, $3)', [ticketId, adminName, 'check_in_reset']);
    }
    await client.query('COMMIT');
    return { ticket, result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function removeScannerTestTickets(batch) {
  const marker = String(batch || '').trim();
  if (!marker) return { ordersDeleted: 0, ticketsDeleted: 0 };
  if (!usePostgres()) {
    const db = await readDb();
    const ticketIds = (db.tickets || []).filter(ticket => ticket.scannerTestBatch === marker).map(ticket => ticket.id);
    const orderIds = (db.orders || []).filter(order => order.scannerTestBatch === marker).map(order => order.id);
    db.tickets = (db.tickets || []).filter(ticket => !ticketIds.includes(ticket.id));
    db.orders = (db.orders || []).filter(order => !orderIds.includes(order.id));
    db.scanHistory = (db.scanHistory || []).filter(scan => !ticketIds.includes(scan.ticketId));
    await writeDb(db);
    return { ordersDeleted: orderIds.length, ticketsDeleted: ticketIds.length };
  }
  await initDb();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tickets = await client.query("SELECT id FROM tickets WHERE data->>'scannerTestBatch'=$1", [marker]);
    const ticketIds = tickets.rows.map(row => row.id);
    if (ticketIds.length) await client.query('DELETE FROM scan_history WHERE ticket_id = ANY($1::text[])', [ticketIds]);
    const deletedTickets = ticketIds.length
      ? await client.query('DELETE FROM tickets WHERE id = ANY($1::text[])', [ticketIds])
      : { rowCount: 0 };
    const deletedOrders = await client.query("DELETE FROM orders WHERE data->>'scannerTestBatch'=$1", [marker]);
    await client.query('COMMIT');
    return { ordersDeleted: deletedOrders.rowCount || 0, ticketsDeleted: deletedTickets.rowCount || 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
      db.vipCodes = db.vipCodes || [];
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
    const [orders, tickets, vipCodes] = await Promise.all([
      client.query('SELECT data FROM orders'),
      client.query('SELECT data FROM tickets'),
      client.query('SELECT data FROM vip_codes')
    ]);
    const db = { orders: orders.rows.map(r => r.data), tickets: tickets.rows.map(r => r.data), scanHistory: [], vipCodes: vipCodes.rows.map(r => r.data) };
    const outcome = await validateAndBuild(db);
    if (outcome.error) { await client.query('ROLLBACK'); return outcome; }
    if (outcome.order) {
      await client.query(
        `INSERT INTO orders (id, event_id, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET event_id=EXCLUDED.event_id, data = EXCLUDED.data, updated_at = NOW()`,
        [outcome.order.id, outcome.order.eventId || process.env.EVENT_ID || 'sunset-house-party-2026', JSON.stringify(outcome.order)]
      );
    }
    for (const t of outcome.tickets || []) {
      await client.query(
        `INSERT INTO tickets (id, order_id, event_id, status, attendee_name, attendee_first_name, attendee_last_name, gender, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, event_id=EXCLUDED.event_id, status = EXCLUDED.status, attendee_name = EXCLUDED.attendee_name, attendee_first_name = EXCLUDED.attendee_first_name, attendee_last_name = EXCLUDED.attendee_last_name, gender = EXCLUDED.gender, data = EXCLUDED.data, updated_at = NOW()`,
        [t.id, t.orderId || null, t.eventId || outcome.order?.eventId || process.env.EVENT_ID || 'sunset-house-party-2026', t.status || 'valid', t.attendeeName || null, t.attendeeFirstName || null, t.attendeeLastName || null, t.gender || null, JSON.stringify(t)]
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

// Targeted single-order reads so per-order admin routes don't load the whole
// orders/tickets tables into memory on every request (the cause of query
// timeouts under load). Postgres uses indexed lookups; the JSON file falls
// back to an in-memory scan for local development.
async function getOrderById(orderId) {
  if (!orderId) return null;
  if (!usePostgres()) {
    const db = await readJsonFile();
    return db.orders.find(o => o.id === orderId) || null;
  }
  await initDb();
  const r = await pgQuery('SELECT data FROM orders WHERE id = $1', [orderId]);
  return r.rows[0]?.data || null;
}

async function getTicketsByOrderId(orderId) {
  if (!orderId) return [];
  if (!usePostgres()) {
    const db = await readJsonFile();
    return (db.tickets || []).filter(t => t.orderId === orderId);
  }
  await initDb();
  const r = await pgQuery('SELECT data FROM tickets WHERE order_id = $1 ORDER BY created_at DESC', [orderId]);
  return r.rows.map(row => row.data);
}

async function getPendingOrdersWithIssuedTickets(limit = 200) {
  if (!usePostgres()) {
    const db = await readJsonFile();
    const issuedOrderIds = new Set((db.tickets || [])
      .filter(ticket => ['valid', 'used'].includes(ticket.status))
      .map(ticket => ticket.orderId)
      .filter(Boolean));
    return (db.orders || [])
      .filter(order => order.status === 'pending_admin_approval' && issuedOrderIds.has(order.id))
      .slice(0, limit);
  }
  await initDb();
  const r = await pgQuery(`
    SELECT o.data
    FROM orders o
    WHERE o.data->>'status' = 'pending_admin_approval'
      AND EXISTS (
        SELECT 1
        FROM tickets t
        WHERE t.order_id = o.id
          AND t.status IN ('valid', 'used')
      )
    ORDER BY o.created_at DESC
    LIMIT $1
  `, [limit]);
  return r.rows.map(row => row.data);
}

async function getAwaitingPaymentOrders(limit = 50) {
  if (!usePostgres()) {
    const db = await readJsonFile();
    return (db.orders || [])
      .filter(order => order.status === 'awaiting_payment_authorization' && order.stripeSessionId)
      .slice(0, limit);
  }
  await initDb();
  const r = await pgQuery(`
    SELECT data
    FROM orders
    WHERE data->>'status' = 'awaiting_payment_authorization'
      AND COALESCE(data->>'stripeSessionId', '') <> ''
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return r.rows.map(row => row.data);
}

async function getTicketById(ticketId) {
  if (!ticketId) return null;
  if (!usePostgres()) {
    const db = await readJsonFile();
    return (db.tickets || []).find(t => t.id === ticketId) || null;
  }
  await initDb();
  const r = await pgQuery('SELECT data FROM tickets WHERE id = $1', [ticketId]);
  return r.rows[0]?.data || null;
}

async function ticketIdExists(ticketId) {
  if (!ticketId) return false;
  if (!usePostgres()) {
    const db = await readJsonFile();
    return (db.tickets || []).some(t => t.id === ticketId);
  }
  await initDb();
  const r = await pgQuery('SELECT 1 FROM tickets WHERE id = $1 LIMIT 1', [ticketId]);
  return r.rowCount > 0;
}

async function getSoldOrPendingCount(eventId = '', legacyEventName = '') {
  const inactive = ['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'];
  if (!usePostgres()) {
    const db = await readJsonFile();
    return (db.orders || []).reduce((sum, order) => {
      if (eventId && order.eventId !== eventId && (order.eventId || order.eventName !== legacyEventName)) return sum;
      if (inactive.includes(order.status)) return sum;
      if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
        const created = new Date(order.createdAt || 0).getTime();
        if (!created || Date.now() - created >= 30 * 60 * 1000) return sum;
      }
      return sum + Number(order.qty || 0);
    }, 0);
  }
  await initDb();
  const result = await pgQuery(`
    SELECT COALESCE(SUM(
      CASE WHEN NOT (data->>'status' = ANY($1::text[]))
        AND (
          data->>'status' NOT IN ('checkout_started', 'awaiting_payment_authorization')
          OR created_at > NOW() - INTERVAL '30 minutes'
        )
        THEN COALESCE((data->>'qty')::int, 0)
        ELSE 0
      END
    ), 0)::int AS count
    FROM orders
    WHERE ($2 = '' OR data->>'eventId' = $2 OR (COALESCE(data->>'eventId', '') = '' AND data->>'eventName' = $3))
  `, [inactive, eventId, legacyEventName]);
  return result.rows[0]?.count || 0;
}

module.exports = { initDb, readDb, readAdminDashboard, writeDb, upsertOrder, upsertTicket, upsertVipCode, setVipCodeActive, deleteOrders, deleteTickets, deleteOrderWithTickets, resetEventData, safeCheckIn, resetTicketCheckIn, readRecentScans, removeScannerTestTickets, usePostgres, getPool, reserveAtomic, getOrderById, getTicketsByOrderId, getPendingOrdersWithIssuedTickets, getAwaitingPaymentOrders, getTicketById, ticketIdExists, getSoldOrPendingCount, upsertWaitlistEntry, readWaitlistDashboard, updateWaitlistStatus, exportWaitlistEntries, WAITLIST_STATUSES, MANAGED_EVENT_STATUSES, listManagedEvents, getManagedEvent, upsertManagedEvent };
