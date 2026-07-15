const crypto = require('crypto');
const { usePostgres, getPool, readDb, writeDb } = require('./db');

const MARKETING_STATUSES = ['subscribed', 'not_subscribed', 'unsubscribed', 'unknown'];
const CUSTOMER_STATUSES = ['active', 'vip', 'inactive', 'review'];
const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'];
let schemaPromise = null;
let customerSyncPromise = null;

function uid(prefix) { return `${prefix}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`; }
function clean(value, max = 5000) { return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ').slice(0, max); }
function normalizeEmail(value) { const email = clean(value, 254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''; }
function normalizePhone(value) { return clean(value, 32).replace(/[\s().-]/g, ''); }
function iso(value) { const date = new Date(value || 0); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function minDate(...values) { return values.filter(Boolean).sort()[0] || new Date().toISOString(); }
function maxDate(...values) { return values.filter(Boolean).sort().at(-1) || new Date().toISOString(); }
function sourceLabel(types) { return types.has('ticket_order') && types.has('waitlist_entry') ? 'Both' : (types.has('ticket_order') ? 'Ticket buyer' : 'Priority Access'); }
function safeMarketingStatus(value) { return MARKETING_STATUSES.includes(value) ? value : 'unknown'; }
function safeCustomerStatus(value) { return CUSTOMER_STATUSES.includes(value) ? value : 'active'; }

async function ensureCustomerMarketingSchema() {
  if (!usePostgres()) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = getPool().query(`
    CREATE TABLE IF NOT EXISTS customer_profiles (
      id TEXT PRIMARY KEY,
      email_normalized TEXT UNIQUE,
      phone_normalized TEXT UNIQUE,
      marketing_status TEXT NOT NULL DEFAULT 'unknown',
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customer_sources (
      customer_id TEXT NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (source_type, source_id)
    );
    CREATE TABLE IF NOT EXISTS marketing_consent_history (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      consent_source TEXT NOT NULL,
      source_ref TEXT,
      wording TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_consent_source_ref ON marketing_consent_history (source_ref) WHERE source_ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS customer_notes (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      admin_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customer_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      admin_name TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customer_duplicate_candidates (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      candidate_customer_ids JSONB NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      UNIQUE (source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_customer_profiles_marketing ON customer_profiles (marketing_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_sources_customer ON customer_sources (customer_id);
    CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes (customer_id, created_at DESC);
  `).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function localState(db) {
  db.customerMarketing = db.customerMarketing || {};
  const state = db.customerMarketing;
  state.profiles = state.profiles || [];
  state.sources = state.sources || [];
  state.consents = state.consents || [];
  state.notes = state.notes || [];
  state.campaigns = state.campaigns || [];
  state.auditLogs = state.auditLogs || [];
  state.duplicateCandidates = state.duplicateCandidates || [];
  return state;
}

async function loadState() {
  if (!usePostgres()) {
    const db = await readDb();
    const state = localState(db);
    state.orders = db.orders || [];
    state.waitlistEntries = db.waitlistEntries || [];
    state.tickets = db.tickets || [];
    return { local: true, db, state };
  }
  await ensureCustomerMarketingSchema();
  const [profiles, sources, consents, notes, campaigns, auditLogs, duplicateCandidates, orders, waitlist, tickets] = await Promise.all([
    getPool().query('SELECT id, email_normalized, phone_normalized, marketing_status, data, created_at, updated_at FROM customer_profiles ORDER BY created_at DESC'),
    getPool().query('SELECT customer_id, source_type, source_id, created_at FROM customer_sources'),
    getPool().query('SELECT id, customer_id, status, consent_source, source_ref, wording, occurred_at FROM marketing_consent_history ORDER BY occurred_at DESC'),
    getPool().query('SELECT id, customer_id, note, admin_name, created_at FROM customer_notes ORDER BY created_at DESC'),
    getPool().query('SELECT data FROM marketing_campaigns ORDER BY created_at DESC'),
    getPool().query('SELECT action, admin_name, metadata, created_at FROM customer_audit_logs ORDER BY created_at DESC LIMIT 200'),
    getPool().query('SELECT source_type, source_id, candidate_customer_ids, reason, created_at FROM customer_duplicate_candidates WHERE resolved_at IS NULL'),
    getPool().query('SELECT data FROM orders ORDER BY created_at DESC'),
    getPool().query('SELECT data FROM waitlist_entries ORDER BY created_at DESC'),
    getPool().query("SELECT data - 'qrDataUrl' AS data FROM tickets ORDER BY created_at DESC")
  ]);
  return {
    local: false,
    state: {
      profiles: profiles.rows.map(row => ({ ...row.data, id: row.id, email: row.email_normalized || row.data.email || '', phone: row.phone_normalized || row.data.phone || '', marketingStatus: row.marketing_status, createdAt: row.data.createdAt || row.created_at?.toISOString(), updatedAt: row.data.updatedAt || row.updated_at?.toISOString() })),
      sources: sources.rows.map(row => ({ customerId: row.customer_id, sourceType: row.source_type, sourceId: row.source_id, createdAt: row.created_at?.toISOString() })),
      consents: consents.rows.map(row => ({ id: row.id, customerId: row.customer_id, status: row.status, source: row.consent_source, sourceRef: row.source_ref, wording: row.wording, occurredAt: row.occurred_at?.toISOString() })),
      notes: notes.rows.map(row => ({ id: row.id, customerId: row.customer_id, note: row.note, adminName: row.admin_name, createdAt: row.created_at?.toISOString() })),
      campaigns: campaigns.rows.map(row => row.data),
      auditLogs: auditLogs.rows.map(row => ({ action: row.action, adminName: row.admin_name, metadata: row.metadata, createdAt: row.created_at?.toISOString() })),
      duplicateCandidates: duplicateCandidates.rows.map(row => ({ sourceType: row.source_type, sourceId: row.source_id, customerIds: row.candidate_customer_ids, reason: row.reason, createdAt: row.created_at?.toISOString() })),
      orders: orders.rows.map(row => row.data),
      waitlistEntries: waitlist.rows.map(row => row.data),
      tickets: tickets.rows.map(row => row.data)
    }
  };
}

async function persistLocal(context) { await writeDb(context.db); }

async function saveProfile(profile, context) {
  const index = context.state.profiles.findIndex(item => item.id === profile.id);
  if (index >= 0) context.state.profiles[index] = profile; else context.state.profiles.push(profile);
  if (context.local) {
    await persistLocal(context);
    return profile;
  }
  await getPool().query(
    `INSERT INTO customer_profiles (id, email_normalized, phone_normalized, marketing_status, data, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET email_normalized=EXCLUDED.email_normalized, phone_normalized=EXCLUDED.phone_normalized, marketing_status=EXCLUDED.marketing_status, data=EXCLUDED.data, updated_at=NOW()`,
    [profile.id, profile.email || null, profile.phone || null, profile.marketingStatus, JSON.stringify(profile)]
  );
  return profile;
}

async function recordDuplicate(context, sourceType, sourceId, customerIds, reason) {
  if (context.state.duplicateCandidates.some(item => item.sourceType === sourceType && item.sourceId === sourceId)) return;
  const candidate = { sourceType, sourceId, customerIds, reason, createdAt: new Date().toISOString() };
  if (context.local) {
    context.state.duplicateCandidates.push(candidate);
    await persistLocal(context);
  } else {
    await getPool().query(
      `INSERT INTO customer_duplicate_candidates (source_type, source_id, candidate_customer_ids, reason)
       VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (source_type, source_id) DO NOTHING`,
      [sourceType, sourceId, JSON.stringify(customerIds), reason]
    );
  }
}

async function findOrCreateCustomer(context, identity, sourceType, sourceId) {
  const email = normalizeEmail(identity.email);
  const phone = normalizePhone(identity.phone);
  if (!email && !phone) return null;
  const matches = context.state.profiles.filter(profile => (email && profile.email === email) || (phone && profile.phone === phone));
  if (matches.length > 1) {
    await recordDuplicate(context, sourceType, sourceId, matches.map(profile => profile.id), 'Email and phone match different existing customers.');
    return null;
  }
  const now = new Date().toISOString();
  const existing = matches[0];
  const profile = existing ? {
    ...existing,
    fullName: clean(identity.fullName, 100) || existing.fullName || '',
    email: email || existing.email || '',
    phone: phone || existing.phone || '',
    instagramUsername: clean(identity.instagramUsername, 31).replace(/^@+/, '').toLowerCase() || existing.instagramUsername || '',
    customerStatus: safeCustomerStatus(existing.customerStatus),
    marketingStatus: safeMarketingStatus(existing.marketingStatus),
    updatedAt: existing.updatedAt || now
  } : {
    id: uid('CUS'),
    fullName: clean(identity.fullName, 100),
    email,
    phone,
    instagramUsername: clean(identity.instagramUsername, 31).replace(/^@+/, '').toLowerCase(),
    customerStatus: 'active',
    marketingStatus: 'unknown',
    createdAt: now,
    updatedAt: now
  };
  const changed = !existing || ['fullName', 'email', 'phone', 'instagramUsername', 'customerStatus', 'marketingStatus'].some(key => profile[key] !== existing[key]);
  if (changed) {
    profile.updatedAt = now;
    await saveProfile(profile, context);
  }
  if (!context.state.sources.some(item => item.sourceType === sourceType && item.sourceId === sourceId)) {
    const source = { customerId: profile.id, sourceType, sourceId, createdAt: now };
    context.state.sources.push(source);
    if (context.local) await persistLocal(context);
    else await getPool().query('INSERT INTO customer_sources (customer_id, source_type, source_id) VALUES ($1,$2,$3) ON CONFLICT (source_type, source_id) DO NOTHING', [profile.id, sourceType, sourceId]);
  }
  return profile;
}

async function recordConsent(context, profile, consent) {
  const sourceRef = clean(consent.sourceRef, 180);
  if (!profile || !sourceRef || context.state.consents.some(item => item.sourceRef === sourceRef)) return;
  const status = safeMarketingStatus(consent.status);
  const history = { customerId: profile.id, status, source: clean(consent.source, 80), sourceRef, wording: clean(consent.wording, 1000), occurredAt: iso(consent.occurredAt) || new Date().toISOString() };
  context.state.consents.push(history);
  if (context.local) await persistLocal(context);
  else await getPool().query('INSERT INTO marketing_consent_history (customer_id,status,consent_source,source_ref,wording,occurred_at) VALUES ($1,$2,$3,$4,$5,$6)', [history.customerId, history.status, history.source, history.sourceRef, history.wording || null, history.occurredAt]);
  if (profile.marketingStatus !== 'unsubscribed' && status !== 'unknown' && profile.marketingStatus !== 'subscribed') {
    profile.marketingStatus = status;
    profile.updatedAt = new Date().toISOString();
    await saveProfile(profile, context);
  }
}

async function syncCustomerDirectoryNow() {
  const context = await loadState();
  const orders = context.local ? context.db.orders || [] : context.state.orders || [];
  const waitlistEntries = context.local ? context.db.waitlistEntries || [] : context.state.waitlistEntries || [];
  for (const order of orders) {
    const profile = await findOrCreateCustomer(context, { fullName: order.buyerName, email: order.buyerEmail }, 'ticket_order', order.id);
    const consentState = Object.prototype.hasOwnProperty.call(order, 'marketingConsent') ? (order.marketingConsent ? 'subscribed' : 'not_subscribed') : 'unknown';
    await recordConsent(context, profile, {
      status: consentState,
      source: 'ticket_checkout',
      sourceRef: `ticket_order:${order.id}`,
      wording: order.marketingConsentWording || '',
      occurredAt: order.marketingConsentAt || order.createdAt
    });
  }
  for (const entry of waitlistEntries) {
    const profile = await findOrCreateCustomer(context, { fullName: entry.fullName, email: entry.email, phone: entry.phone, instagramUsername: entry.instagramUsername }, 'waitlist_entry', entry.id);
    await recordConsent(context, profile, {
      status: entry.consent ? 'subscribed' : 'not_subscribed',
      source: entry.consentSource || 'priority_access',
      sourceRef: `waitlist_entry:${entry.id}`,
      wording: entry.consentWording || '',
      occurredAt: entry.consentAt || entry.createdAt
    });
  }
  return loadState();
}

// Admin pages can request customer data at the same time. Keep the import from
// ticket and waitlist records single-filed so two requests never create the
// same profile concurrently and trip the unique email/phone constraints.
function syncCustomerDirectory() {
  if (customerSyncPromise) return customerSyncPromise;
  customerSyncPromise = syncCustomerDirectoryNow().finally(() => {
    customerSyncPromise = null;
  });
  return customerSyncPromise;
}

function buildCustomerRecords(state) {
  const orders = state.orders || [];
  const waitlistEntries = state.waitlistEntries || [];
  const tickets = state.tickets || [];
  const ordersById = new Map(orders.map(order => [order.id, order]));
  const waitlistById = new Map(waitlistEntries.map(entry => [entry.id, entry]));
  const ticketByOrder = new Map();
  for (const ticket of tickets) ticketByOrder.set(ticket.orderId, [...(ticketByOrder.get(ticket.orderId) || []), ticket]);
  return state.profiles.map(profile => {
    const sources = state.sources.filter(source => source.customerId === profile.id);
    const types = new Set(sources.map(source => source.sourceType));
    const ticketOrders = sources.filter(source => source.sourceType === 'ticket_order').map(source => ordersById.get(source.sourceId)).filter(Boolean);
    const priorityEntries = sources.filter(source => source.sourceType === 'waitlist_entry').map(source => waitlistById.get(source.sourceId)).filter(Boolean);
    const approvedOrders = ticketOrders.filter(order => order.status === 'approved_captured');
    const eventNames = [...new Set(approvedOrders.map(order => order.eventName || 'Asile event'))];
    const ticketCount = approvedOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0);
    const totalSpent = approvedOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
    const attendedCount = approvedOrders.reduce((sum, order) => sum + (ticketByOrder.get(order.id) || []).filter(ticket => ticket.status === 'used').length, 0);
    const ticketsByOrder = Object.fromEntries(ticketOrders.map(order => [order.id, ticketByOrder.get(order.id) || []]));
    const dates = [profile.createdAt, profile.updatedAt, ...ticketOrders.map(order => order.createdAt), ...priorityEntries.map(entry => entry.createdAt)].filter(Boolean);
    const uncertain = state.duplicateCandidates.some(candidate => sources.some(source => source.sourceType === candidate.sourceType && source.sourceId === candidate.sourceId));
    return {
      ...profile,
      source: sourceLabel(types),
      sourceTypes: types,
      ticketOrders,
      ticketsByOrder,
      priorityEntries,
      events: eventNames,
      eventCount: eventNames.length,
      attendedCount,
      ticketCount,
      totalSpent,
      dateFirstAdded: minDate(...dates),
      mostRecentActivity: maxDate(...dates),
      marketingHistory: state.consents.filter(item => item.customerId === profile.id),
      notes: state.notes.filter(item => item.customerId === profile.id),
      uncertainDuplicate: uncertain
    };
  });
}

async function listCustomers(options = {}) {
  const context = await syncCustomerDirectory();
  let records = buildCustomerRecords(context.state);
  const search = clean(options.search, 120).toLowerCase();
  const source = clean(options.source, 30);
  const marketingStatus = safeMarketingStatus(options.marketingStatus) === 'unknown' && options.marketingStatus !== 'unknown' ? '' : options.marketingStatus;
  const customerStatus = clean(options.customerStatus, 30);
  const event = clean(options.event, 120);
  if (search) records = records.filter(record => [record.fullName, record.email, record.phone, record.instagramUsername].some(value => String(value || '').toLowerCase().includes(search)));
  if (source) records = records.filter(record => record.source === source);
  if (marketingStatus) records = records.filter(record => record.marketingStatus === marketingStatus);
  if (customerStatus) records = records.filter(record => record.customerStatus === customerStatus);
  if (event) records = records.filter(record => record.events.includes(event));
  const sort = ['oldest', 'spending', 'events'].includes(options.sort) ? options.sort : 'newest';
  records.sort((a, b) => {
    if (sort === 'oldest') return new Date(a.dateFirstAdded) - new Date(b.dateFirstAdded);
    if (sort === 'spending') return b.totalSpent - a.totalSpent || new Date(b.mostRecentActivity) - new Date(a.mostRecentActivity);
    if (sort === 'events') return b.eventCount - a.eventCount || b.ticketCount - a.ticketCount;
    return new Date(b.mostRecentActivity) - new Date(a.mostRecentActivity);
  });
  const pageSize = Math.min(Math.max(Number(options.limit) || 50, 1), 100000);
  const page = Math.max(Number(options.page) || 1, 1);
  return {
    customers: records.slice((page - 1) * pageSize, page * pageSize),
    total: records.length,
    page,
    pageSize,
    allEvents: [...new Set(buildCustomerRecords(context.state).flatMap(record => record.events))].sort(),
    duplicateCount: context.state.duplicateCandidates.length,
    duplicateCandidates: context.state.duplicateCandidates
  };
}

async function getCustomerProfile(customerId) {
  const context = await syncCustomerDirectory();
  return buildCustomerRecords(context.state).find(record => record.id === customerId) || null;
}

async function updateCustomerStatus(customerId, status) {
  const context = await loadState();
  const profile = context.state.profiles.find(item => item.id === customerId);
  if (!profile) return null;
  profile.customerStatus = safeCustomerStatus(status);
  profile.updatedAt = new Date().toISOString();
  await saveProfile(profile, context);
  return profile;
}

async function addCustomerNote(customerId, note, adminName) {
  const text = clean(note, 2000);
  if (!text) return null;
  const context = await loadState();
  const entry = { id: uid('NOTE'), customerId, note: text, adminName: clean(adminName, 100) || 'Admin', createdAt: new Date().toISOString() };
  context.state.notes.unshift(entry);
  if (context.local) await persistLocal(context);
  else await getPool().query('INSERT INTO customer_notes (customer_id,note,admin_name) VALUES ($1,$2,$3)', [customerId, entry.note, entry.adminName]);
  return entry;
}

async function unsubscribeEmail(email, source = 'unsubscribe_link') {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const context = await loadState();
  let profile = context.state.profiles.find(item => item.email === normalized);
  if (!profile) {
    profile = { id: uid('CUS'), fullName: '', email: normalized, phone: '', instagramUsername: '', customerStatus: 'active', marketingStatus: 'unsubscribed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  } else {
    profile.marketingStatus = 'unsubscribed';
    profile.updatedAt = new Date().toISOString();
  }
  await saveProfile(profile, context);
  await recordConsent(context, profile, { status: 'unsubscribed', source, sourceRef: `${source}:${normalized}:${Date.now()}`, wording: 'Marketing unsubscribe request', occurredAt: new Date().toISOString() });
  return profile;
}

async function audit(action, adminName, metadata = {}) {
  const safe = { count: Number(metadata.count || 0), campaignId: clean(metadata.campaignId, 80), audience: clean(metadata.audience, 80) };
  const context = await loadState();
  const entry = { action: clean(action, 100), adminName: clean(adminName, 100), metadata: safe, createdAt: new Date().toISOString() };
  context.state.auditLogs.unshift(entry);
  if (context.local) await persistLocal(context);
  else await getPool().query('INSERT INTO customer_audit_logs (action,admin_name,metadata) VALUES ($1,$2,$3::jsonb)', [entry.action, entry.adminName || null, JSON.stringify(safe)]);
}

async function saveCampaign(campaign) {
  const context = await loadState();
  const now = new Date().toISOString();
  const data = {
    id: campaign.id || uid('CMP'),
    name: clean(campaign.name, 120),
    subject: clean(campaign.subject, 180),
    body: clean(campaign.body, 10000),
    senderName: clean(campaign.senderName, 100),
    replyTo: normalizeEmail(campaign.replyTo),
    audience: clean(campaign.audience, 80) || 'all_subscribed',
    selectedEvent: clean(campaign.selectedEvent, 160),
    status: CAMPAIGN_STATUSES.includes(campaign.status) ? campaign.status : 'draft',
    createdBy: clean(campaign.createdBy, 100),
    createdAt: campaign.createdAt || now,
    updatedAt: now,
    recipientCount: Number(campaign.recipientCount || 0),
    successfullySent: Number(campaign.successfullySent || 0),
    failed: Number(campaign.failed || 0)
  };
  if (!data.name || !data.subject || !data.body || !data.senderName || !data.replyTo) throw new Error('Campaign name, subject, body, sender name, and reply-to address are required.');
  const index = context.state.campaigns.findIndex(item => item.id === data.id);
  if (index >= 0) context.state.campaigns[index] = data; else context.state.campaigns.unshift(data);
  if (context.local) await persistLocal(context);
  else await getPool().query(`INSERT INTO marketing_campaigns (id,data,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`, [data.id, JSON.stringify(data)]);
  return data;
}

async function listCampaigns() {
  const context = await loadState();
  return context.state.campaigns.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

async function eligibleMarketingCustomers(audience = 'all_subscribed', selectedEvent = '') {
  const all = await listCustomers({ limit: 100000 });
  return all.customers.filter(customer => {
    if (customer.marketingStatus !== 'subscribed' || !customer.email) return false;
    if (audience === 'ticket_buyers') return customer.sourceTypes.has('ticket_order');
    if (audience === 'priority_access') return customer.sourceTypes.has('waitlist_entry');
    if (audience === 'event') return customer.events.includes(selectedEvent);
    return true;
  }).filter((customer, index, list) => list.findIndex(item => item.email === customer.email) === index);
}

module.exports = { ensureCustomerMarketingSchema, syncCustomerDirectory, listCustomers, getCustomerProfile, updateCustomerStatus, addCustomerNote, unsubscribeEmail, audit, saveCampaign, listCampaigns, eligibleMarketingCustomers, normalizeEmail, MARKETING_STATUSES, CUSTOMER_STATUSES, CAMPAIGN_STATUSES };
