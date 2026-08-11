require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const { ensureCustomerMarketingSchema, listCustomers, getCustomerProfile, updateCustomerStatus, addCustomerNote, unsubscribeEmail, audit, saveCampaign, listCampaigns, eligibleMarketingCustomers, normalizeEmail, MARKETING_STATUSES, CUSTOMER_STATUSES } = require('./customer-marketing');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY, { timeout: Number(process.env.STRIPE_TIMEOUT_MS || 10000) }) : null;
const { initDb, readDb, readAdminDashboard, upsertOrder, upsertTicket, upsertVipCode, setVipCodeActive, deleteOrders, deleteTickets, deleteOrderWithTickets, safeCheckIn, resetTicketCheckIn, readRecentScans, removeScannerTestTickets, usePostgres, getPool, reserveAtomic, getOrderById, getTicketsByOrderId, getPendingOrdersWithIssuedTickets, getAwaitingPaymentOrders, getTicketById, ticketIdExists, getSoldOrPendingCount, upsertWaitlistEntry, readWaitlistDashboard, updateWaitlistStatus, exportWaitlistEntries, WAITLIST_STATUSES, MANAGED_EVENT_STATUSES, listManagedEvents, getManagedEvent, upsertManagedEvent } = require('./db');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const EVENT_NAME = process.env.EVENT_NAME || 'Sunset House Party';
const CURRENT_EVENT_ID = process.env.EVENT_ID || 'sunset-house-party-2026';
const COMPANY_NAME = process.env.COMPANY_NAME || "ASIL'E";
const EVENT_LOCATION = process.env.EVENT_LOCATION || 'Cremisan';
const EVENT_DATE = process.env.EVENT_DATE || 'July 24, 2026';
const EVENT_TIME = process.env.EVENT_TIME || '5:30 PM–11:00 PM';
const EVENT_START_AT = process.env.EVENT_START_AT || '2026-07-24T17:30:00';
const EVENT_THEME = process.env.EVENT_THEME || 'House Music & Sunset Party';
const DRESS_CODE = process.env.DRESS_CODE || 'All White';
const MIN_AGE = Number(process.env.MIN_AGE || 18);
const CAPACITY = Number(process.env.TICKET_LIMIT || 500);
const TICKET_PRICE = Number(process.env.TICKET_PRICE || 8000); // 8000 agorot = 80.00 ILS/NIS
const CURRENCY = (process.env.CURRENCY || 'ils').toLowerCase();
const MAP_URL = process.env.MAP_URL || 'https://www.google.com/maps?q=Cremisan';
const WHATSAPP_1 = process.env.WHATSAPP_1 || '972568576684';
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://www.instagram.com/events.asile?igsh=cXduejFvbHB4bjRo';
const BAR_PARTNER = process.env.BAR_PARTNER || 'Double Shake';
const EVENT_BEVERAGE_PARTNER_LABEL = 'Bar';
const SPONSOR_NAME = process.env.SPONSOR_NAME || 'Carlsberg';
const SPONSOR_LOGO_URL = process.env.SPONSOR_LOGO_URL || '/public/carlsberg-logo.jpeg';
const DJ_NAME = process.env.DJ_NAME || 'DJ Loco';
const DJ_IMAGE_URL = process.env.DJ_IMAGE_URL || '/public/dj-loco.jpeg';
const SITE_IMAGE_URL = process.env.SITE_IMAGE_URL || `${BASE_URL}/public/favicon.png?v=20260715b`;
const PAYMENT_METHODS = ['Apple Pay', 'Google Pay', 'Visa', 'Mastercard'];
const PAYMENT_PROVIDER_LABEL = process.env.PAYMENT_PROVIDER_LABEL || 'Stripe';
const PHOTO_BOOTH_PARTNER = process.env.PHOTO_BOOTH_PARTNER || 'Picka pic photo booth';
const VIP_RESERVE_PATH = '/private-reserve-asile-2026';
const WAITLIST_PATH = '/waitlist';
const TICKET_MARKETING_CONSENT_WORDING = 'Keep me updated about future Asile events, ticket releases, and exclusive announcements.';
const PRIORITY_ACCESS_CONSENT_WORDING = 'I agree to receive event updates and Priority List announcements from Asile Events. I understand that joining the list does not guarantee a ticket or admission.';
const WAITLIST_RATE_WINDOW_MS = Number(process.env.WAITLIST_RATE_WINDOW_MS || 15 * 60 * 1000);
const WAITLIST_RATE_LIMIT = Number(process.env.WAITLIST_RATE_LIMIT || 5);
const ASILE_LOGO_PATH = path.join(__dirname, 'public', 'favicon.png');
const waitlistAttempts = new Map();
const sensitiveAttempts = new Map();
const SCANNER_TEST_BATCH = 'scanner-test-v1';

const eventInfo = { EVENT_NAME, COMPANY_NAME, EVENT_LOCATION, EVENT_DATE, EVENT_TIME, EVENT_START_AT, EVENT_THEME, DRESS_CODE, MIN_AGE, CAPACITY, TICKET_PRICE, CURRENCY, MAP_URL, WHATSAPP_1, INSTAGRAM_URL, BAR_PARTNER, EVENT_BEVERAGE_PARTNER_LABEL, SPONSOR_NAME, SPONSOR_LOGO_URL, DJ_NAME, DJ_IMAGE_URL, SITE_IMAGE_URL, PAYMENT_METHODS, PAYMENT_PROVIDER_LABEL, PHOTO_BOOTH_PARTNER };

function currentEventContext() {
  return { id: CURRENT_EVENT_ID, kind: 'current', ...eventInfo, eventPath: '/', reservePath: '/reserve', privateReservePath: VIP_RESERVE_PATH };
}

function managedEventContext(event) {
  return {
    id: event.id,
    kind: 'managed',
    EVENT_NAME: event.name,
    COMPANY_NAME,
    EVENT_LOCATION: event.location,
    EVENT_DATE: event.eventDate,
    EVENT_TIME: event.eventTime || 'Time to be announced',
    EVENT_START_AT: `${event.eventDate}T12:00:00`,
    EVENT_THEME: event.theme || 'Asile experience',
    DRESS_CODE: event.dressCode || 'To be announced',
    MIN_AGE: Number(event.minimumAge || MIN_AGE),
    CAPACITY: Number(event.capacity || 0),
    TICKET_PRICE: Number(event.ticketPrice || 0),
    EVENT_DESCRIPTION: event.description || '',
    EVENT_CAPACITY_LABEL: event.capacityLabel || '',
    EVENT_ENTRY_POLICY: event.entryPolicy || '',
    EVENT_MUSIC_DESCRIPTION: event.musicDescription || '',
    EVENT_CONCEPT: event.concept || '',
    EVENT_PARTNERS: Array.isArray(event.partners) ? event.partners : [],
    EVENT_BEVERAGE_PARTNER_LABEL: event.beveragePartnerLabel || 'Bar',
    CURRENCY,
    MAP_URL: event.mapUrl || MAP_URL,
    WHATSAPP_1,
    INSTAGRAM_URL,
    BAR_PARTNER: event.barPartner || BAR_PARTNER,
    SPONSOR_NAME: event.sponsorName || SPONSOR_NAME,
    SPONSOR_LOGO_URL: Object.hasOwn(event, 'sponsorLogoUrl') ? event.sponsorLogoUrl : SPONSOR_LOGO_URL,
    DJ_NAME: event.djName || DJ_NAME,
    DJ_IMAGE_URL: event.imageUrl || DJ_IMAGE_URL,
    SITE_IMAGE_URL,
    PAYMENT_METHODS,
    PAYMENT_PROVIDER_LABEL,
    PHOTO_BOOTH_PARTNER,
    eventPath: `/events/${encodeURIComponent(event.id)}`,
    reservePath: `/events/${encodeURIComponent(event.id)}/reserve`,
    privateReservePath: `/events/${encodeURIComponent(event.id)}/private-reserve`
  };
}

async function getEventContext(eventId) {
  if (!eventId || eventId === CURRENT_EVENT_ID) return currentEventContext();
  const event = await getManagedEvent(eventId);
  return event && event.status === 'published' ? managedEventContext(event) : null;
}

async function getAdminEventContext(eventId) {
  if (!eventId || eventId === CURRENT_EVENT_ID) return currentEventContext();
  const event = await getManagedEvent(eventId);
  return event ? managedEventContext(event) : null;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use('/public', express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true
}));
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.png'), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }
  });
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.set('trust proxy', 1);

// Keep admin sessions out of the main database by default. Supabase/managed
// Postgres connection hiccups should not break the public site or admin page
// before the route can even load. Set SESSION_STORE=postgres only if shared
// sessions across multiple app instances are more important than this isolation.
let sessionStore;
if (process.env.SESSION_STORE === 'postgres' && usePostgres()) {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: getPool(),
    createTableIfMissing: true,
    disableTouch: true,
    pruneSessionInterval: false,
    ttl: Number(process.env.SESSION_TTL_SECONDS || 7 * 24 * 60 * 60)
  });
}
const adminSession = session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
});
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/scanner')) return adminSession(req, res, next);
  return next();
});
app.use('/admin', (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});
app.use('/scanner', (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

function id(size = 12) { return crypto.randomBytes(size).toString('hex').slice(0, size).toUpperCase(); }
function money(amount = TICKET_PRICE) { return `${(amount / 100).toFixed(0)} NIS`; }
function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function cleanText(value, maxLength = 120) { return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ').slice(0, maxLength); }
function nameKey(value) { return cleanName(value).toLowerCase(); }
function combineName(first, last) { return cleanName(`${cleanName(first)} ${cleanName(last)}`); }
function asArray(value) { return Array.isArray(value) ? value : (value ? [value] : []); }
function isActiveOrder(order) {
  const inactive = ['denied_released', 'cancelled', 'rejected_refunded', 'payment_error', 'authorization_expired'];
  if (inactive.includes(order.status)) return false;
  // Do not hold names/capacity forever if someone starts checkout and never pays.
  if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
    const created = new Date(order.createdAt || 0).getTime();
    return Date.now() - created < 30 * 60 * 1000;
  }
  return true;
}
function isStuckOrder(order) {
  if (!order) return false;
  if (['payment_error', 'cancelled'].includes(order.status)) return true;
  if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
    const created = new Date(order.createdAt || 0).getTime();
    return !created || Date.now() - created >= 30 * 60 * 1000;
  }
  return false;
}
function isIssuedTicket(ticket) {
  return ['valid', 'used'].includes(ticket.status);
}
function isNameBlockingOrder(order) {
  return ['pending_admin_approval', 'approved_captured'].includes(order.status);
}
function belongsToEvent(item, event) {
  return item?.eventId === event.id
    || (!item?.eventId && item?.eventName === event.EVENT_NAME)
    || (!item?.eventId && !item?.eventName && event.id === CURRENT_EVENT_ID);
}
function soldOrPendingCount(db, event) {
  return db.orders.filter(order => belongsToEvent(order, event) && isActiveOrder(order)).reduce((sum, o) => sum + Number(o.qty || 0), 0);
}
function usedNameKeys(db, event) {
  const fromTickets = db.tickets.filter(ticket => belongsToEvent(ticket, event) && isIssuedTicket(ticket)).map(t => nameKey(t.attendeeName || t.buyerName));
  const fromOrders = db.orders.filter(order => belongsToEvent(order, event) && isNameBlockingOrder(order)).flatMap(o => (o.attendees || []).map(a => nameKey(a.name || combineName(a.firstName, a.lastName))));
  return new Set([...fromTickets, ...fromOrders].filter(Boolean));
}
function normalizeGender(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['male', 'm'].includes(v)) return 'Male';
  if (['female', 'f'].includes(v)) return 'Female';
  return '';
}
function normalizeVipCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9_-]/g, '');
}
function vipCodeUsage(db, code, event) {
  const key = normalizeVipCode(code);
  return (db.orders || [])
    .filter(order => belongsToEvent(order, event) && isActiveOrder(order) && normalizeVipCode(order.vipCode) === key)
    .reduce((sum, order) => sum + Number(order.qty || 0), 0);
}
function adminStats(db, approvedCountOverride, event = currentEventContext()) {
  const activeTickets = db.tickets.filter(isIssuedTicket);
  const pendingAttendees = db.orders
    .filter(o => o.status === 'pending_admin_approval')
    .flatMap(o => o.attendees || []);
  const ratioPeople = [
    ...activeTickets.map(ticket => ({ gender: ticket.gender })),
    ...pendingAttendees
  ];
  const femaleCount = ratioPeople.filter(person => normalizeGender(person.gender) === 'Female').length;
  const maleCount = ratioPeople.filter(person => normalizeGender(person.gender) === 'Male').length;
  return {
    approvedCount: typeof approvedCountOverride === 'number' ? approvedCountOverride : activeTickets.length,
    awaitingPaymentCount: db.orders.filter(o => o.status === 'awaiting_payment_authorization').length,
    stuckOrderCount: db.orders.filter(isStuckOrder).length,
    remaining: Math.max(0, event.CAPACITY - soldOrPendingCount(db, event)),
    pendingCount: pendingAttendees.length,
    femaleCount,
    maleCount
  };
}
function dashboardStats(stats, event = currentEventContext()) {
  if (!stats) return null;
  const femaleCount = stats.femaleCount || 0;
  const maleCount = stats.maleCount || 0;
  const ratioTotal = femaleCount + maleCount;
  return {
    approvedCount: stats.approvedCount || 0,
    awaitingPaymentCount: stats.awaitingPaymentCount || 0,
    stuckOrderCount: stats.stuckOrderCount || 0,
    remaining: Math.max(0, event.CAPACITY - Number(stats.remainingSoldOrPending || 0)),
    pendingCount: stats.pendingCount || 0,
    femaleCount,
    maleCount,
    femalePercent: ratioTotal ? Math.round((femaleCount / ratioTotal) * 100) : 0,
    malePercent: ratioTotal ? Math.round((maleCount / ratioTotal) * 100) : 0
  };
}
function orderStatusLabel(status) {
  const labels = {
    checkout_started: 'Checkout started',
    awaiting_payment_authorization: 'Awaiting payment',
    pending_admin_approval: 'Ready for approval',
    approved_captured: 'Approved',
    denied_released: 'Rejected',
    cancelled: 'Cancelled',
    payment_error: 'Payment error',
    authorization_expired: 'Expired'
  };
  return labels[status] || status;
}
function statusClass(status) {
  return `status-pill status-${String(status || 'unknown').replace(/[^a-z0-9_-]/gi, '-')}`;
}
function pageNumber(value) {
  const parsed = Number(value || 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
function pageMeta(page, total, pageSize) {
  const pageCount = Math.max(1, Math.ceil(Number(total || 0) / pageSize));
  return { page, pageSize, total, pageCount, hasOlder: page < pageCount, hasNewer: page > 1 };
}
function adminPageUrl(currentPages, key, page, searches = {}) {
  const params = new URLSearchParams();
  const nextPages = { ...currentPages, [key]: page };
  if (nextPages.ordersPage > 1) params.set('ordersPage', nextPages.ordersPage);
  if (nextPages.ticketsPage > 1) params.set('ticketsPage', nextPages.ticketsPage);
  if (nextPages.scansPage > 1) params.set('scansPage', nextPages.scansPage);
  if (searches.orderSearch) params.set('orderSearch', searches.orderSearch);
  if (searches.orderStatus) params.set('orderStatus', searches.orderStatus);
  if (searches.ticketSearch) params.set('ticketSearch', searches.ticketSearch);
  if (searches.eventId) params.set('event', searches.eventId);
  const query = params.toString();
  return query ? `/admin?${query}` : '/admin';
}
async function syncWaitingOrdersFromStripe(event = null) {
  let synced = 0;
  let failed = 0;
  const allWaitingOrders = await getAwaitingPaymentOrders(Number(process.env.PAYMENT_SYNC_LIMIT || 50));
  const waitingOrders = event ? allWaitingOrders.filter(order => belongsToEvent(order, event)) : allWaitingOrders;
  for (const order of waitingOrders) {
    try {
      if (await syncOrderFromStripe(order)) {
        await upsertOrder(order);
        synced++;
      }
    } catch (err) {
      failed++;
      console.error('Stripe bulk order sync failed:', order.id, err.message);
    }
  }
  return { checked: waitingOrders.length, synced, failed };
}
function adminEventRedirect(event, notice = '') {
  const params = new URLSearchParams({ event: event.id });
  if (notice) params.set('notice', notice);
  return `/admin?${params.toString()}`;
}
function adminPasswordAllowed(password) {
  const raw = String(password || '');
  const list = (process.env.ADMIN_PASSWORDS || process.env.ADMIN_PASSWORD || 'admin1122')
    .split(',').map(p => p.trim()).filter(Boolean);
  return list.includes(raw);
}
async function makeUniqueTicketId() {
  let ticketId;
  do { ticketId = `ASILE-${id(10)}`; } while (await ticketIdExists(ticketId));
  return ticketId;
}
function parseDobInput(value) {
  const raw = String(value || '').trim();
  let day, month, year;
  const typed = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (typed) { day = Number(typed[1]); month = Number(typed[2]); year = Number(typed[3]); }
  else if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else return null;
  const birth = new Date(year, month - 1, day);
  if (birth.getFullYear() !== year || birth.getMonth() !== month - 1 || birth.getDate() !== day) return null;
  return { birth, display: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
}
function ageOnEvent(birth, event = currentEventContext()) {
  const eventDate = new Date(event.EVENT_START_AT);
  if (!birth || birth > eventDate) return null;
  let age = eventDate.getFullYear() - birth.getFullYear();
  const monthDiff = eventDate.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && eventDate.getDate() < birth.getDate())) age--;
  return age;
}
function isOldEnough(dob, event = currentEventContext()) {
  const parsed = parseDobInput(dob);
  const age = parsed ? ageOnEvent(parsed.birth, event) : null;
  return age !== null && age >= event.MIN_AGE;
}
function requireAdmin(req, res, next) { if (req.session.admin) return next(); res.redirect('/admin/login'); }
function requireScanner(req, res, next) {
  if (req.session.admin || req.session.scanner) return next();
  res.redirect('/scanner/login');
}

async function scannerPasswordAllowed(password) {
  const raw = String(password || '');
  const hashes = (process.env.SCANNER_PASSWORD_HASH || '').split(',').map(value => value.trim()).filter(Boolean);
  if (hashes.length) return (await Promise.all(hashes.map(hash => bcrypt.compare(raw, hash)))).some(Boolean);
  return raw === (process.env.SCANNER_PASSWORD || 'scan1122');
}

function normalizeWaitlistPhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+') && /^0?5\d{8}$/.test(phone)) phone = `+970${phone.replace(/^0/, '')}`;
  else if (!phone.startsWith('+') && /^970\d{7,12}$/.test(phone)) phone = `+${phone}`;
  else if (!phone.startsWith('+')) phone = `+${phone}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : '';
}

function normalizeInstagramUsername(value) {
  const username = cleanText(value, 31).replace(/^@+/, '');
  return /^[a-zA-Z0-9._]{1,30}$/.test(username) ? username.toLowerCase() : '';
}

function waitlistRateAllowed(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (waitlistAttempts.get(key) || []).filter(time => now - time < WAITLIST_RATE_WINDOW_MS);
  if (attempts.length >= WAITLIST_RATE_LIMIT) return false;
  attempts.push(now);
  waitlistAttempts.set(key, attempts);
  return true;
}

function sensitiveRateAllowed(req, limit = 20, windowMs = 15 * 60 * 1000) {
  const key = `${req.session?.adminName || 'public'}:${req.ip || req.socket.remoteAddress || 'unknown'}:${req.path}`;
  const now = Date.now();
  const attempts = (sensitiveAttempts.get(key) || []).filter(time => now - time < windowMs);
  if (attempts.length >= limit) return false;
  attempts.push(now);
  sensitiveAttempts.set(key, attempts);
  return true;
}

function unsubscribeTokenForEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  const payload = Buffer.from(JSON.stringify({ email: normalized, exp: Date.now() + 365 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET;
  if (!secret) return '';
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function emailFromUnsubscribeToken(token) {
  try {
    const [payload, suppliedSignature] = String(token || '').split('.');
    const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET;
    if (!payload || !suppliedSignature || !secret) return '';
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return '';
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || Date.now() > Number(data.exp)) return '';
    return normalizeEmail(data.email);
  } catch { return ''; }
}

function marketingEmailHtml({ senderName, body, unsubscribeUrl }) {
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
  return `<div style="margin:0;padding:28px 14px;background:#080808;color:#F5F1E8;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;border:1px solid #C6A56B;background:#161616;padding:30px 24px"><div style="text-align:center;margin-bottom:24px"><img src="cid:asile-marketing-logo" width="84" height="84" alt="ASIL'E" style="display:inline-block;max-width:84px;height:auto"></div><div style="font-size:16px;line-height:1.65;color:#F5F1E8">${safeBody}</div><p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#C6A56B">You are receiving this because you opted in to Asile event updates. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#F5F1E8">Unsubscribe</a></p><p style="margin:10px 0 0;color:#C6A56B;font-size:13px">${escapeHtml(senderName)}</p></div></div>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function priorityAccessEmail(entry) {
  const safeName = escapeHtml(entry.fullName);
  return `<div style="margin:0;padding:32px 16px;background:#080808;color:#F5F1E8;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;border:1px solid #C6A56B;background:#161616;padding:34px 28px">
      <div style="text-align:center;margin-bottom:30px"><img src="cid:asile-priority-logo" width="96" height="96" alt="ASIL'E" style="display:inline-block;max-width:96px;height:auto"></div>
      <p style="margin:0 0 12px;color:#C6A56B;font-size:12px;font-weight:bold;letter-spacing:2px">PRIVATE ACCESS</p>
      <h1 style="margin:0 0 22px;color:#F5F1E8;font-size:28px;font-weight:normal">Welcome to Asile, ${safeName}.</h1>
      <p style="line-height:1.65">Welcome to the Asile community.</p>
      <p style="line-height:1.65">You have been added to the Asile Priority List.</p>
      <p style="line-height:1.65">We’ll contact you if availability opens or when access to our next experience becomes available.</p>
      <p style="line-height:1.65">Please remember that registration does not guarantee admission or a ticket.</p>
      <p style="line-height:1.65">This is just the beginning.</p>
      <p style="margin:26px 0 0;color:#C6A56B">Asile Events</p>
    </div>
  </div>`;
}

function renderPriorityList(res, { success = false, error = null, values = {}, mainPage = false } = {}) {
  return res.render('waitlist', {
    success,
    error,
    values,
    mainPage,
    formAction: mainPage ? '/' : WAITLIST_PATH,
    INSTAGRAM_URL,
    SITE_IMAGE_URL
  });
}

function priorityAccessSuccess(res, mainPage = false) {
  return renderPriorityList(res, { success: true, mainPage });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function sendMail({ to, subject, html, text, attachments = [] }) {
  if (!to) { console.warn('EMAIL SKIPPED - no recipient address for:', subject); return false; }
  if (!process.env.SMTP_HOST) { console.log('EMAIL NOT SENT - configure SMTP in .env:', subject, html); return false; }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
    const info = await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, html, text: text || htmlToText(html), attachments });
    console.log('EMAIL SENT to', to, '-', subject, '- id:', info.messageId, '- accepted:', JSON.stringify(info.accepted), '- rejected:', JSON.stringify(info.rejected));
    return true;
  } catch (err) {
    console.error('EMAIL SEND FAILED:', err.message);
    return false;
  }
}
function sendMailInBackground(mail) {
  sendMail(mail).catch(err => console.error('EMAIL BACKGROUND FAILED:', err.message));
}
async function markOrderPendingApproval(order, paymentIntentId) {
  if (!order || order.status === 'pending_admin_approval') return false;
  order.status = 'pending_admin_approval';
  order.paymentIntentId = paymentIntentId || order.paymentIntentId;
  const names = (order.attendees || []).map(a => `<li>${a.name} — DOB: ${a.dateOfBirth} — Gender: ${a.gender || 'Not specified'} — Must match ID, dress code ${DRESS_CODE}</li>`).join('');
  await sendMail({ to: process.env.ADMIN_EMAIL, subject: `Approve tickets: ${order.buyerName}`, html: `<p>${order.buyerName} requested ${order.qty} ticket(s) for ${escapeHtml(order.eventName || EVENT_NAME)}.</p><ul>${names}</ul><p><b>Event:</b> ${escapeHtml(order.eventDate || EVENT_DATE)}, ${escapeHtml(order.eventTime || EVENT_TIME)}, ${escapeHtml(order.eventLocation || EVENT_LOCATION)}</p><p><b>Price:</b> ${money(order.ticketPrice || TICKET_PRICE)} per ticket. <b>Dress code:</b> ${escapeHtml(order.dressCode || DRESS_CODE)}. <b>Age:</b> ${order.minimumAge || MIN_AGE}+. <b>Bar:</b> ${escapeHtml(order.barPartner || BAR_PARTNER)}. <b>Sponsor:</b> ${escapeHtml(order.sponsorName || SPONSOR_NAME)}. <b>Included:</b> free ${escapeHtml(order.photoBoothPartner || PHOTO_BOOTH_PARTNER)} picture.</p><p><a href="${BASE_URL}/admin/orders/${order.id}">Approve or deny this order</a></p>` });
  return true;
}
async function syncOrderFromStripe(order) {
  if (!stripe || !order || order.status !== 'awaiting_payment_authorization' || !order.stripeSessionId) return false;
  const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, { expand: ['payment_intent'] });
  if (session.status !== 'complete') return false;
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntentId) return false;
  return markOrderPendingApproval(order, paymentIntentId);
}
function qrAttachmentForTicket(ticket) {
  const match = String(ticket.qrDataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!match) return null;
  return {
    filename: `${ticket.id}.png`,
    content: Buffer.from(match[1], 'base64'),
    contentType: 'image/png',
    cid: `qr-${ticket.id}@asile`
  };
}
function ticketVerifyUrl(ticket) {
  return ticket.verifyUrl || `${BASE_URL}/admin/scan?ticket=${ticket.id}`;
}
function ticketPublicUrl(ticket) {
  return ticket.publicUrl || `${BASE_URL}/ticket/${ticket.id}`;
}
function ticketEmailHtml(ticket) {
  const qrCid = `qr-${ticket.id}@asile`;
  const publicUrl = ticketPublicUrl(ticket);
  return `<div style="background:#fffaf3;border:1px solid #d7a45b;border-radius:18px;padding:18px;margin:14px 0;font-family:Arial,sans-serif;max-width:430px;color:#1d130d;box-shadow:0 10px 30px rgba(0,0,0,.18)">
    <h2 style="margin:0 0 12px;color:#1d130d">${EVENT_NAME}</h2>
    <p style="margin:6px 0"><b>Name:</b> ${ticket.attendeeName}</p>
    <p style="margin:6px 0"><b>Ticket:</b> ${ticket.id}</p>
    <p style="margin:6px 0"><b>Time:</b> ${EVENT_TIME}</p>
    <p style="margin:6px 0"><b>Location:</b> ${EVENT_LOCATION}</p>
    <p style="margin:6px 0"><b>Dress:</b> ${DRESS_CODE}</p>
    <div style="background:#fff;border-radius:14px;display:inline-block;padding:10px;margin:14px 0"><img src="cid:${qrCid}" width="190" height="190" alt="QR code" style="display:block"></div>
    <p style="margin:8px 0"><a href="${publicUrl}" style="color:#8a5a17;font-weight:bold">Open QR ticket</a></p>
    <p style="font-size:13px;color:#555;margin:8px 0 0">Bring this QR and matching ID.</p>
  </div>`;
}
function ticketEmailBackground(content) {
  return `<div style="margin:0;padding:28px 14px;background:#120c08;background-image:linear-gradient(135deg,#120c08 0%,#24140c 55%,#4b2b13 100%);font-family:Arial,sans-serif;color:#fff4df">
    <div style="max-width:520px;margin:0 auto">
      <div style="text-align:center;margin:0 0 18px">
        <div style="font-size:24px;font-weight:800;letter-spacing:1px;color:#f4cf92">${COMPANY_NAME}</div>
        <div style="font-size:13px;color:#d8bc8b;margin-top:4px">${EVENT_NAME}</div>
      </div>
      <div style="background:rgba(255,250,243,.08);border:1px solid rgba(215,164,91,.35);border-radius:22px;padding:18px">
        ${content}
      </div>
      <p style="text-align:center;font-size:12px;color:#c6aa7b;margin:16px 0 0">If the QR image is hidden, use the Open QR ticket link.</p>
    </div>
  </div>`;
}
function ticketEmailText(ticket) {
  return [
    `${ticket.eventName || EVENT_NAME} ticket`,
    `Name: ${ticket.attendeeName}`,
    `Ticket ID: ${ticket.id}`,
    `Time: ${ticket.eventTime || EVENT_TIME}`,
    `Location: ${ticket.location || EVENT_LOCATION}`,
    `Dress code: ${ticket.dressCode || DRESS_CODE}`,
    `QR ticket: ${ticketPublicUrl(ticket)}`,
    'Bring this QR and matching ID.'
  ].join('\n');
}
async function createTicketForAttendee(order, attendee, overrides = {}) {
  const ticketId = await makeUniqueTicketId();
  const verifyUrl = `${BASE_URL}/admin/scan?ticket=${ticketId}`;
  const publicUrl = `${BASE_URL}/ticket/${ticketId}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);
  return {
    id: ticketId,
    orderId: order.id,
    eventId: order.eventId || CURRENT_EVENT_ID,
    attendeeFirstName: attendee.firstName || '',
    attendeeLastName: attendee.lastName || '',
    attendeeName: attendee.name,
    dateOfBirth: attendee.dateOfBirth,
    gender: attendee.gender,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    eventName: order.eventName || EVENT_NAME,
    eventDate: order.eventDate || EVENT_DATE,
    eventTime: order.eventTime || EVENT_TIME,
    location: order.eventLocation || EVENT_LOCATION,
    dressCode: order.dressCode || DRESS_CODE,
    age: `${order.minimumAge || MIN_AGE}+`,
    price: money(order.ticketPrice || TICKET_PRICE),
    barPartner: order.barPartner || BAR_PARTNER,
    photoBoothPartner: order.photoBoothPartner || PHOTO_BOOTH_PARTNER,
    sponsorName: order.sponsorName || SPONSOR_NAME,
    sponsorLogoUrl: SPONSOR_LOGO_URL,
    status: 'valid',
    verifyUrl,
    publicUrl,
    qrDataUrl,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, service: 'asile-ticket-site' }));

async function handlePriorityListSubmission(req, res, { mainPage = false } = {}) {
  const values = {
    fullName: cleanText(req.body.fullName, 100),
    phone: cleanText(req.body.phone, 32),
    email: cleanText(req.body.email, 254).toLowerCase(),
    instagramUsername: cleanText(req.body.instagramUsername, 31),
    attendedBefore: cleanText(req.body.attendedBefore, 3),
    referralSource: cleanText(req.body.referralSource, 32)
  };
  const showError = (message, status = 400) => {
    res.status(status);
    return renderPriorityList(res, { error: message, values, mainPage });
  };

  // Bots normally fill invisible fields. Reply with the normal success state
  // without saving anything so the check does not reveal itself.
  if (cleanText(req.body.company, 100)) return priorityAccessSuccess(res, mainPage);
  if (!waitlistRateAllowed(req)) return showError('Too many attempts. Please wait a few minutes, then try again.', 429);
  if (!values.fullName) return showError('Enter your full name.');
  const phone = normalizeWaitlistPhone(values.phone);
  if (!phone) return showError('Enter a valid phone number with a country code. Palestine numbers can start with +970 or 05.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return showError('Enter a valid email address.');
  const instagramUsername = normalizeInstagramUsername(values.instagramUsername);
  if (!instagramUsername) return showError('Enter a valid Instagram username using letters, numbers, dots, or underscores.');
  if (values.attendedBefore && !['Yes', 'No'].includes(values.attendedBefore)) return showError('Choose Yes or No for previous attendance.');
  const referralOptions = ['Instagram', 'Friend', 'Previous Asile event', 'TikTok', 'Other'];
  if (values.referralSource && !referralOptions.includes(values.referralSource)) return showError('Choose how you heard about Asile from the list.');
  if (req.body.consent !== 'on') return showError('You need to agree before joining the Priority List.');

  try {
    const result = await upsertWaitlistEntry({
      id: `WAIT-${id(14)}`,
      fullName: values.fullName,
      phone,
      email: values.email,
      instagramUsername,
      attendedBefore: values.attendedBefore || null,
      referralSource: values.referralSource || null,
      consent: true,
      consentAt: new Date().toISOString(),
      consentSource: 'priority_access',
      consentWording: PRIORITY_ACCESS_CONSENT_WORDING,
      consentVersion: 'priority-access-v1',
      status: 'waitlisted'
    });
    if (result.error) return showError('We found conflicting details in an existing entry. Please contact Asile directly so we can help.', 409);
    if (result.created) {
      sendMailInBackground({
        to: result.entry.email,
        subject: 'You’re on the Asile Priority List',
        html: priorityAccessEmail(result.entry),
        text: `Welcome to the Asile community.\n\nYou have been added to the Asile Priority List.\n\nWe’ll contact you if availability opens or when access to our next experience becomes available.\n\nPlease remember that registration does not guarantee admission or a ticket.\n\nThis is just the beginning.\n\nAsile Events`,
        attachments: [{ filename: 'asile-logo.png', path: ASILE_LOGO_PATH, cid: 'asile-priority-logo', contentType: 'image/png' }]
      });
    }
    return priorityAccessSuccess(res, mainPage);
  } catch (err) {
    console.error('Priority access submission failed:', err.message);
    return showError('We could not save your information right now. Please try again in a moment.', 503);
  }
}

app.get(WAITLIST_PATH, (req, res) => renderPriorityList(res));
app.post(WAITLIST_PATH, (req, res) => handlePriorityListSubmission(req, res));
app.get('/', (req, res) => renderPriorityList(res, { mainPage: true }));
app.post('/', (req, res) => handlePriorityListSubmission(req, res, { mainPage: true }));

async function renderHomePage(req, res, { privateReserve = false, event = currentEventContext() } = {}) {
  try {
    const soldOrPending = await getSoldOrPendingCount(event.id, event.EVENT_NAME);
    res.render('home', {
      ...event,
      money,
      privateReserve,
      formAction: privateReserve ? event.privateReservePath : event.reservePath,
      ticketAvailability: {
        soldOrPending,
        remaining: Math.max(0, event.CAPACITY - soldOrPending),
        soldOut: !privateReserve && soldOrPending >= event.CAPACITY
      }
    });
  } catch (err) {
    console.error('Home availability unavailable:', err.message);
    res.render('home', {
      ...event,
      money,
      privateReserve,
      formAction: privateReserve ? event.privateReservePath : event.reservePath,
      ticketAvailability: { soldOrPending: 0, remaining: event.CAPACITY, soldOut: false }
    });
  }
}

app.get(VIP_RESERVE_PATH, (req, res) => renderHomePage(req, res, { privateReserve: true }));
app.get('/events/:eventId', async (req, res) => {
  const event = await getEventContext(req.params.eventId);
  if (!event || event.kind !== 'managed') return res.status(404).render('message', { title: 'Event not found', message: 'This event is not available.' });
  return renderHomePage(req, res, { event });
});
app.get('/events/:eventId/private-reserve', async (req, res) => {
  const event = await getEventContext(req.params.eventId);
  if (!event || event.kind !== 'managed') return res.status(404).render('message', { title: 'Event not found', message: 'This event is not available.' });
  return renderHomePage(req, res, { event, privateReserve: true });
});
app.get('/events', async (req, res) => {
  let futureEvents = [];

  try {
    futureEvents = await listManagedEvents({ publicOnly: true });
  } catch (err) {
    console.error('Events availability unavailable:', err.message);
  }

  res.render('events', { ...eventInfo, money, futureEvents, WAITLIST_PATH });
});

async function handleReserve(req, res, { bypassCapacity = false, event = currentEventContext() } = {}) {
  const body = req.body || {};
  const buyerName = cleanName(body.buyerName);
  const buyerEmail = String(body.buyerEmail || '').trim();
  const vipCodeInput = normalizeVipCode(body.vipCode);
  const attendeeFirstNames = asArray(body.attendeeFirstName).map(cleanName);
  const attendeeLastNames = asArray(body.attendeeLastName).map(cleanName);
  const legacyNames = asArray(body.attendeeName).map(cleanName);
  const attendeeDobs = asArray(body.attendeeDob).map(v => String(v || '').trim());
  const attendeeGenders = asArray(body.attendeeGender).map(normalizeGender);
  const marketingConsent = body.marketingConsent === 'on';
  const attendeeNames = legacyNames.length ? legacyNames : attendeeFirstNames.map((first, i) => combineName(first, attendeeLastNames[i]));
  const qty = Number(body.quantity || attendeeNames.length || 1);
  if (!buyerName || !buyerEmail) return res.status(400).render('message', { title: 'Missing information', message: 'Buyer name and email are required.' });
  if (bypassCapacity && !vipCodeInput) return res.status(400).render('message', { title: 'VIP code required', message: 'Enter your private invite code to use this checkout link.' });
  if (!Number.isFinite(qty) || qty < 1) return res.status(400).render('message', { title: 'Invalid quantity', message: 'Cannot order 0 tickets. Please order at least 1.' });
  if (!Number.isInteger(qty)) return res.status(400).render('message', { title: 'Invalid quantity', message: 'Please enter a whole number of tickets.' });
  if (qty > 10) return res.status(400).render('message', { title: 'Invalid quantity', message: 'Cannot order more than 10 tickets at once.' });
  if (attendeeNames.length !== qty || attendeeDobs.length !== qty || attendeeGenders.length !== qty || attendeeNames.some(n => !n) || (!legacyNames.length && (attendeeFirstNames.length !== qty || attendeeLastNames.length !== qty || attendeeFirstNames.some(n => !n) || attendeeLastNames.some(n => !n))) || attendeeDobs.some(d => !d) || attendeeGenders.some(g => !g)) return res.status(400).render('message', { title: 'Missing ticket forms', message: 'Each ticket needs a separate first name, last name, date of birth, and gender.' });
  if (attendeeDobs.some(d => !isOldEnough(d, event))) return res.status(400).render('message', { title: 'Age requirement', message: `Every attendee must enter a valid date of birth as DD/MM/YYYY and be ${event.MIN_AGE}+ by ${event.EVENT_DATE}.` });
  const keys = attendeeNames.map(nameKey);
  if (new Set(keys).size !== keys.length) return res.status(400).render('message', { title: 'Duplicate name', message: 'The same attendee name cannot be used twice in one order.' });

  const attendees = attendeeNames.map((name, i) => ({ firstName: attendeeFirstNames[i] || '', lastName: attendeeLastNames[i] || '', name, dateOfBirth: parseDobInput(attendeeDobs[i]).display, gender: attendeeGenders[i] }));
  const orderId = id(14);
  const order = {
    id: orderId, eventId: event.id, eventName: event.EVENT_NAME, eventDate: event.EVENT_DATE, eventTime: event.EVENT_TIME,
    eventLocation: event.EVENT_LOCATION, eventCapacity: event.CAPACITY, ticketPrice: event.TICKET_PRICE,
    dressCode: event.DRESS_CODE, minimumAge: event.MIN_AGE, barPartner: event.BAR_PARTNER,
    sponsorName: event.SPONSOR_NAME, photoBoothPartner: event.PHOTO_BOOTH_PARTNER,
    buyerName, buyerEmail, qty, attendees, amount: event.TICKET_PRICE * qty,
    paymentMethods: event.PAYMENT_METHODS, paymentProvider: event.PAYMENT_PROVIDER_LABEL,
    marketingConsent,
    marketingConsentAt: new Date().toISOString(),
    marketingConsentSource: 'ticket_checkout',
    marketingConsentWording: TICKET_MARKETING_CONSENT_WORDING,
    marketingConsentVersion: 'ticket-checkout-v1',
    status: 'checkout_started', createdAt: new Date().toISOString()
  };
  console.log('CHECKOUT START', { orderId, buyerEmail, qty, amount: order.amount });
  // Capacity and cross-order duplicate-name checks run atomically against the
  // latest data so simultaneous buyers cannot oversell or double-book a name.
  let reservation;
  try {
    reservation = await reserveAtomic(freshDb => {
      if (keys.some(k => usedNameKeys(freshDb, event).has(k))) return { error: 'duplicate' };
      if (!bypassCapacity && soldOrPendingCount(freshDb, event) + qty > event.CAPACITY) return { error: 'soldout' };
      if (bypassCapacity) {
        const vipCode = (freshDb.vipCodes || []).find(item => normalizeVipCode(item.code) === vipCodeInput && belongsToEvent(item, event));
        if (!vipCode || vipCode.active === false) return { error: 'invalid_vip_code' };
        const usedTickets = vipCodeUsage(freshDb, vipCodeInput, event);
        const maxTickets = Math.max(1, Number(vipCode.maxTickets || 1));
        if (usedTickets + qty > maxTickets) return { error: 'vip_limit', vipCode, usedTickets, maxTickets };
        order.vipCode = vipCode.code;
        order.vipMaxTickets = maxTickets;
      }
      return { order };
    });
  } catch (err) {
    console.error('CHECKOUT RESERVATION FAILED', { orderId, message: err.message });
    return res.status(503).render('message', { title: 'Reservation is slow', message: 'The reservation system is taking too long. Please try again in a moment.' });
  }
  if (reservation.error === 'duplicate') return res.status(400).render('message', { title: 'Duplicate name', message: 'One of these attendee names has already been used for another ticket.' });
  if (reservation.error === 'soldout') return res.status(400).render('message', { title: 'Sold out', message: 'This order goes over the event capacity.' });
  if (reservation.error === 'invalid_vip_code') return res.status(400).render('message', { title: 'Invalid VIP code', message: 'This invite code is not valid or is no longer active.' });
  if (reservation.error === 'vip_limit') return res.status(400).render('message', { title: 'VIP code limit reached', message: `This invite code allows ${reservation.maxTickets} ticket(s), and ${reservation.usedTickets} are already reserved.` });
  if (reservation.error) return res.status(500).render('message', { title: 'Reservation error', message: 'The reservation could not be completed. Please try again.' });
  if (!stripe) {
    order.status = 'payment_error';
    order.paymentError = 'Missing STRIPE_SECRET_KEY';
    await upsertOrder(order);
    return res.status(503).render('message', { title: 'Stripe setup needed', message: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY in DigitalOcean App Platform environment variables before accepting payments.' });
  }
  try {
    console.log('STRIPE SESSION CREATE START', { orderId, amount: order.amount, currency: CURRENCY });
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      // The current implementation uses Stripe Checkout as the payment gateway template.
      // Apple Pay / Google Pay require HTTPS, wallet setup, and supported customer device/browser.
      payment_method_types: ['card'],
      customer_email: buyerEmail,
      client_reference_id: orderId,
      line_items: [{ price_data: { currency: event.CURRENCY, product_data: { name: `${event.EVENT_NAME} ticket`, description: `${event.DRESS_CODE} dress code · ${event.MIN_AGE}+ · Free ${event.PHOTO_BOOTH_PARTNER} photo · Sponsor: ${event.SPONSOR_NAME}` }, unit_amount: event.TICKET_PRICE }, quantity: qty }],
      payment_intent_data: { capture_method: 'manual', metadata: { orderId, eventId: event.id, eventName: event.EVENT_NAME, companyName: event.COMPANY_NAME } },
      success_url: `${BASE_URL}/success?order=${orderId}`,
      cancel_url: `${BASE_URL}/cancel?order=${orderId}`
    });
    console.log('STRIPE SESSION CREATED', { orderId, sessionId: checkoutSession.id });
    order.stripeSessionId = checkoutSession.id; order.status = 'awaiting_payment_authorization'; await upsertOrder(order);
    return res.redirect(303, checkoutSession.url);
  } catch (err) {
    console.error('STRIPE SESSION CREATE FAILED', { orderId, type: err.type, code: err.code, message: err.message });
    order.status = 'payment_error'; order.paymentError = err.message; await upsertOrder(order);
    return res.status(503).render('message', { title: 'Payment problem', message: `Stripe checkout did not open: ${err.message}` });
  }
}

app.post('/reserve', (req, res) => res.status(410).render('message', { title: 'Event completed', message: 'Sunset House Party has ended. Join the Priority List for the next Asile experience.' }));
app.post(VIP_RESERVE_PATH, (req, res) => handleReserve(req, res, { bypassCapacity: true }));
app.post('/events/:eventId/reserve', async (req, res) => {
  const event = await getEventContext(req.params.eventId);
  if (!event || event.kind !== 'managed') return res.status(404).render('message', { title: 'Event not found', message: 'This event is not available.' });
  return handleReserve(req, res, { event });
});
app.post('/events/:eventId/private-reserve', async (req, res) => {
  const event = await getEventContext(req.params.eventId);
  if (!event || event.kind !== 'managed') return res.status(404).render('message', { title: 'Event not found', message: 'This event is not available.' });
  return handleReserve(req, res, { event, bypassCapacity: true });
});

app.get('/success', async (req, res) => {
  const order = await getOrderById(req.query.order);
  const name = order?.eventName || EVENT_NAME;
  res.render('message', { title: 'Reservation received', message: `Your payment is authorized. Your ${name} ticket will be sent only after admin approval. Please check your inbox and spam/junk folder for the ticket email.` });
});
app.get('/cancel', async (req, res) => { const order = await getOrderById(req.query.order); if (order) { order.status = 'cancelled'; await upsertOrder(order); } res.render('message', { title: 'Checkout cancelled', message: 'No ticket was reserved.' }); });
app.get('/ticket/:id', async (req, res) => {
  const ticket = await getTicketById(req.params.id);
  res.render('ticket-public', { ticket, ...eventInfo });
});

app.post('/webhook', async (req, res) => {
  let event = req.body;
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    if (!stripe) return res.status(503).send('Stripe is not configured.');
    try { event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook error: ${err.message}`); }
  } else if (process.env.NODE_ENV === 'production') {
    // Never trust unsigned webhooks in production — without verification anyone
    // could POST fake payment events and push orders to pending approval.
    return res.status(503).send('Webhook signature verification is not configured.');
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const order = await getOrderById(s.client_reference_id);
    if (order) {
      await markOrderPendingApproval(order, s.payment_intent);
      await upsertOrder(order);
    }
  }
  res.json({ received: true });
});

app.get('/admin/login', (req, res) => res.render('login', { error: null }));
app.post('/admin/login', async (req, res) => {
  const adminName = cleanName(req.body.username) || 'Admin';
  const hashes = (process.env.ADMIN_PASSWORD_HASHES || process.env.ADMIN_PASSWORD_HASH || '').split(',').map(h => h.trim()).filter(Boolean);
  const ok = hashes.length ? (await Promise.all(hashes.map(h => bcrypt.compare(req.body.password || '', h)))).some(Boolean) : adminPasswordAllowed(req.body.password);
  if (!ok) return res.render('login', { error: 'Wrong password' });
  req.session.admin = true; req.session.adminName = adminName; res.redirect('/admin');
});
app.get('/admin/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
app.get('/scanner/login', (req, res) => {
  if (req.session.admin || req.session.scanner) return res.redirect('/scanner');
  res.render('scanner-login', { error: null });
});
app.post('/scanner/login', async (req, res) => {
  if (!sensitiveRateAllowed(req, 8, 15 * 60 * 1000)) {
    return res.status(429).render('scanner-login', { error: 'Too many attempts. Please wait and try again.' });
  }
  if (!(await scannerPasswordAllowed(req.body.password))) {
    return res.status(401).render('scanner-login', { error: 'Wrong scanner password' });
  }
  req.session.scanner = true;
  req.session.scannerName = 'Door Scanner';
  res.redirect('/scanner');
});
app.get('/scanner/logout', requireScanner, (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  req.session.destroy(() => res.redirect('/scanner/login'));
});
function cleanManagedEventImageUrl(value) {
  const imageUrl = cleanText(value, 500);
  if (!imageUrl) return '';
  if (imageUrl.startsWith('/public/')) return imageUrl;
  try {
    const parsed = new URL(imageUrl);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}
function managedEventValues(body, existing = {}) {
  const eventDate = String(body.eventDate || '').trim();
  const parsedDate = new Date(`${eventDate}T12:00:00`);
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(eventDate)
    && !Number.isNaN(parsedDate.getTime())
    && parsedDate.toISOString().slice(0, 10) === eventDate;
  const capacity = Number(body.capacity);
  const ticketPriceNis = Number(body.ticketPriceNis);
  if (!cleanText(body.name, 120) || !dateValid || !cleanText(body.location, 120)
    || !Number.isInteger(capacity) || capacity < 1 || capacity > 100000
    || !Number.isFinite(ticketPriceNis) || ticketPriceNis < 0.01 || ticketPriceNis > 100000) return null;
  return {
    ...existing,
    name: cleanText(body.name, 120),
    eventDate,
    eventTime: cleanText(body.eventTime, 80),
    location: cleanText(body.location, 120),
    capacity,
    ticketPrice: Math.round(ticketPriceNis * 100),
    theme: cleanText(body.theme, 120),
    dressCode: cleanText(body.dressCode, 80),
    description: cleanText(body.description, 500),
    imageUrl: cleanManagedEventImageUrl(body.imageUrl),
    status: MANAGED_EVENT_STATUSES.includes(String(body.status || '').trim().toLowerCase()) ? String(body.status).trim().toLowerCase() : 'draft'
  };
}

app.get('/admin/events', requireAdmin, async (req, res) => {
  try {
    const events = await listManagedEvents();
    const editEvent = req.query.edit ? await getManagedEvent(cleanText(req.query.edit, 80)) : null;
    res.render('event-manager', { events, editEvent, statuses: MANAGED_EVENT_STATUSES, notice: cleanText(req.query.notice, 180) });
  } catch (err) {
    console.error('Event manager unavailable:', err.message);
    res.status(503).render('message', { title: 'Event manager unavailable', message: 'Event listings could not be loaded. Please refresh in a moment.' });
  }
});

app.post('/admin/events', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req, 12)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try saving the event again in a few minutes.' });
  const values = managedEventValues(req.body);
  if (!values) return res.status(400).render('message', { title: 'Event could not be saved', message: 'Name, date, location, capacity, and ticket price are required. Use valid values.' });
  await upsertManagedEvent({ ...values, id: `EVENT-${id(14)}`, createdBy: req.session.adminName });
  res.redirect('/admin/events?notice=Event%20created');
});

app.post('/admin/events/:id', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req, 12)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try saving the event again in a few minutes.' });
  const existing = await getManagedEvent(req.params.id);
  if (!existing) return res.status(404).render('message', { title: 'Event not found', message: 'This event listing no longer exists.' });
  const values = managedEventValues(req.body, existing);
  if (!values) return res.status(400).render('message', { title: 'Event could not be saved', message: 'Name, date, location, capacity, and ticket price are required. Use valid values.' });
  await upsertManagedEvent(values);
  res.redirect('/admin/events?notice=Event%20updated');
});

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const managedEvents = await listManagedEvents();
    const eventOptions = [currentEventContext(), ...managedEvents.map(managedEventContext)];
    const selectedEvent = eventOptions.find(event => event.id === cleanText(req.query.event, 80)) || currentEventContext();
    const pageSize = 10;
    const searches = {
      orderSearch: String(req.query.orderSearch || '').trim(),
      orderStatus: String(req.query.orderStatus || '').trim(),
      ticketSearch: String(req.query.ticketSearch || '').trim(),
      eventId: selectedEvent.id
    };
    const pages = {
      ordersPage: pageNumber(req.query.ordersPage),
      ticketsPage: pageNumber(req.query.ticketsPage),
      scansPage: pageNumber(req.query.scansPage)
    };
    const dashboard = await readAdminDashboard({
      orderLimit: pageSize,
      orderOffset: (pages.ordersPage - 1) * pageSize,
      orderSearch: searches.orderSearch,
      orderStatus: searches.orderStatus,
      ticketLimit: pageSize,
      ticketOffset: (pages.ticketsPage - 1) * pageSize,
      ticketSearch: searches.ticketSearch,
      scanLimit: pageSize,
      scanOffset: (pages.scansPage - 1) * pageSize,
      eventId: selectedEvent.id,
      legacyEventName: selectedEvent.EVENT_NAME
    });
    res.render('admin', {
      orders: dashboard.orders,
      tickets: dashboard.tickets.filter(isIssuedTicket),
      scanHistory: dashboard.scanHistory || [],
      vipCodes: dashboard.vipCodes || [],
      pagination: {
        pages,
        searches,
        orders: pageMeta(pages.ordersPage, dashboard.orderCount, pageSize),
        tickets: pageMeta(pages.ticketsPage, dashboard.ticketCount, pageSize),
        scans: pageMeta(pages.scansPage, dashboard.scanCount, pageSize)
      },
      adminPageUrl,
      stats: dashboardStats(dashboard.stats, selectedEvent) || adminStats({ orders: dashboard.allOrders, tickets: dashboard.allTickets }, dashboard.approvedCount, selectedEvent),
      ...selectedEvent,
      eventOptions,
      selectedEvent,
      money,
      orderStatusLabel,
      statusClass,
      notice: req.query.notice || '',
      usePostgres: usePostgres()
    });
  } catch (err) {
    console.error('Admin dashboard database unavailable:', err.message);
    res.status(503).render('message', { title: 'Database temporarily unavailable', message: 'The admin database did not respond. Please refresh in a moment.' });
  }
});

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function customerQueryUrl(page, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, page })) if (value) params.set(key, value);
  return `/admin/customers?${params.toString()}`;
}

app.get('/admin/customers', requireAdmin, async (req, res) => {
  try {
    const filters = {
      search: cleanText(req.query.search, 120),
      event: cleanText(req.query.event, 120),
      source: cleanText(req.query.source, 30),
      marketingStatus: cleanText(req.query.marketingStatus, 30),
      customerStatus: cleanText(req.query.customerStatus, 30),
      sort: cleanText(req.query.sort, 30),
      page: pageNumber(req.query.page),
      limit: 50
    };
    const result = await listCustomers(filters);
    res.render('customers', {
      customers: result.customers,
      filters,
      events: result.allEvents,
      marketingStatuses: MARKETING_STATUSES,
      customerStatuses: CUSTOMER_STATUSES,
      duplicateCount: result.duplicateCount,
      duplicateCandidates: result.duplicateCandidates,
      pageInfo: pageMeta(result.page, result.total, result.pageSize),
      customerQueryUrl,
      money
    });
  } catch (err) {
    console.error('Customer directory unavailable:', err.message);
    res.status(503).render('message', { title: 'Customer directory unavailable', message: 'Customer records could not be loaded. Please refresh in a moment.' });
  }
});

app.get('/admin/customers/:id', requireAdmin, async (req, res) => {
  try {
    const customer = await getCustomerProfile(req.params.id);
    if (!customer) return res.status(404).render('message', { title: 'Customer not found', message: 'This customer profile does not exist.' });
    res.render('customer-profile', { customer, customerStatuses: CUSTOMER_STATUSES, money, orderStatusLabel, ...eventInfo });
  } catch (err) {
    console.error('Customer profile unavailable:', err.message);
    res.status(503).render('message', { title: 'Customer profile unavailable', message: 'This customer could not be loaded. Please refresh in a moment.' });
  }
});

app.post('/admin/customers/:id/status', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try the customer update again in a few minutes.' });
  const status = cleanText(req.body.customerStatus, 30);
  if (!CUSTOMER_STATUSES.includes(status)) return res.status(400).render('message', { title: 'Invalid customer status', message: 'Choose a valid customer status.' });
  const customer = await updateCustomerStatus(req.params.id, status);
  if (!customer) return res.status(404).render('message', { title: 'Customer not found', message: 'This customer profile does not exist.' });
  await audit('customer_status_updated', req.session.adminName, { count: 1 });
  res.redirect(`/admin/customers/${encodeURIComponent(req.params.id)}`);
});

app.post('/admin/customers/:id/notes', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try adding the note again in a few minutes.' });
  const note = await addCustomerNote(req.params.id, req.body.note, req.session.adminName);
  if (!note) return res.status(400).render('message', { title: 'Note required', message: 'Enter a note before saving.' });
  await audit('customer_note_added', req.session.adminName, { count: 1 });
  res.redirect(`/admin/customers/${encodeURIComponent(req.params.id)}`);
});

async function exportCustomerCsv(req, res, marketingOnly) {
  if (!sensitiveRateAllowed(req, 8)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try the export again in a few minutes.' });
  const result = await listCustomers({ limit: 100000 });
  const customers = marketingOnly ? result.customers.filter(customer => customer.marketingStatus === 'subscribed' && customer.email) : result.customers;
  const columns = marketingOnly
    ? ['Full name', 'Email address', 'Phone number', 'Instagram username', 'Source', 'Events attended', 'Date subscribed']
    : ['Customer ID', 'Full name', 'Email address', 'Phone number', 'Instagram username', 'Source', 'Events attended', 'Tickets purchased', 'Total amount spent', 'Marketing status', 'Customer status', 'Date first added', 'Most recent activity'];
  const rows = customers.map(customer => marketingOnly
    ? [customer.fullName, customer.email, customer.phone, customer.instagramUsername, customer.source, customer.events.join(' | '), customer.marketingHistory.find(item => item.status === 'subscribed')?.occurredAt || '']
    : [customer.id, customer.fullName, customer.email, customer.phone, customer.instagramUsername, customer.source, customer.events.join(' | '), customer.ticketCount, (customer.totalSpent / 100).toFixed(2), customer.marketingStatus, customer.customerStatus, customer.dateFirstAdded, customer.mostRecentActivity]);
  await audit(marketingOnly ? 'export_marketing_contacts' : 'export_all_customers', req.session.adminName, { count: customers.length });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="asile-${marketingOnly ? 'marketing-contacts' : 'customers'}.csv"`, 'Cache-Control': 'no-store' });
  res.send(`\uFEFF${[columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}`);
}

app.get('/admin/customers/export/marketing.csv', requireAdmin, (req, res, next) => exportCustomerCsv(req, res, true).catch(next));
app.get('/admin/customers/export/all.csv', requireAdmin, (req, res, next) => exportCustomerCsv(req, res, false).catch(next));

app.get('/admin/marketing', requireAdmin, async (req, res) => {
  try {
    const audience = cleanText(req.query.audience, 80) || 'all_subscribed';
    const selectedEvent = cleanText(req.query.selectedEvent, 160);
    const [campaigns, customers] = await Promise.all([
      listCampaigns(),
      listCustomers({ limit: 100000 })
    ]);
    const eligibleCustomers = customers.customers.filter(customer => {
      if (customer.marketingStatus !== 'subscribed' || !customer.email) return false;
      if (audience === 'ticket_buyers') return customer.sourceTypes.has('ticket_order');
      if (audience === 'priority_access') return customer.sourceTypes.has('waitlist_entry');
      if (audience === 'event') return customer.events.includes(selectedEvent);
      return true;
    });
    const estimatedRecipientCount = eligibleCustomers.filter((customer, index, list) => (
      list.findIndex(item => item.email === customer.email) === index
    )).length;
    res.render('marketing', {
      campaigns,
      events: customers.allEvents,
      audience,
      selectedEvent,
      estimatedRecipientCount,
      bulkProviderReady: false,
      defaultReplyTo: process.env.MARKETING_REPLY_TO || process.env.SMTP_USER || '',
      defaultSenderName: process.env.MARKETING_SENDER_NAME || 'Asile Events',
      previewHtml: req.query.previewBody ? marketingEmailHtml({ senderName: cleanText(req.query.senderName, 100) || 'Asile Events', body: cleanText(req.query.previewBody, 10000), unsubscribeUrl: `${BASE_URL}/email/unsubscribe?token={{secure_token}}` }) : ''
    });
  } catch (err) {
    console.error('Marketing admin unavailable:', err.message);
    res.status(503).render('message', { title: 'Marketing unavailable', message: 'Marketing data could not be loaded. Please refresh in a moment.' });
  }
});

app.post('/admin/marketing/campaigns', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req, 12)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try saving the campaign again in a few minutes.' });
  try {
    const audience = cleanText(req.body.audience, 80) || 'all_subscribed';
    const selectedEvent = cleanText(req.body.selectedEvent, 160);
    const recipients = await eligibleMarketingCustomers(audience, selectedEvent);
    const campaign = await saveCampaign({
      name: req.body.name,
      subject: req.body.subject,
      body: req.body.body,
      senderName: req.body.senderName,
      replyTo: req.body.replyTo,
      audience,
      selectedEvent,
      status: 'draft',
      createdBy: req.session.adminName,
      recipientCount: recipients.length
    });
    await audit('campaign_saved_draft', req.session.adminName, { count: recipients.length, campaignId: campaign.id, audience });
    res.redirect(`/admin/marketing?notice=${encodeURIComponent(`Draft ${campaign.name} saved for ${recipients.length} eligible contacts.`)}`);
  } catch (err) {
    res.status(400).render('message', { title: 'Campaign could not be saved', message: err.message });
  }
});

app.post('/admin/marketing/campaigns/:id/test', requireAdmin, async (req, res) => {
  // The configured SMTP/Nodemailer transport is transactional. It has no
  // approved bulk provider, queue, delivery webhooks, or suppression list.
  res.status(409).render('message', { title: 'Bulk email provider required', message: 'Campaign test and send are intentionally disabled. Configure an approved bulk provider with a queue, suppression handling, and delivery webhooks before sending marketing email.' });
});

app.get('/email/unsubscribe', (req, res) => {
  const email = emailFromUnsubscribeToken(req.query.token);
  res.render('unsubscribe', { valid: Boolean(email), token: cleanText(req.query.token, 2000) });
});

app.post('/email/unsubscribe', async (req, res) => {
  if (!sensitiveRateAllowed(req, 6, 60 * 60 * 1000)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try again in a little while.' });
  const email = emailFromUnsubscribeToken(req.body.token);
  if (!email) return res.status(400).render('unsubscribe', { valid: false, token: '' });
  await unsubscribeEmail(email, 'unsubscribe_link');
  await audit('marketing_unsubscribe', null, { count: 1 });
  res.render('unsubscribe', { valid: 'complete', token: '' });
});

app.get('/admin/waitlist', requireAdmin, async (req, res) => {
  try {
    const pageSize = 50;
    const page = pageNumber(req.query.page);
    const search = cleanText(req.query.search, 120);
    const status = String(req.query.status || '').trim().toLowerCase();
    const dashboard = await readWaitlistDashboard({
      limit: pageSize,
      offset: (page - 1) * pageSize,
      search,
      status
    });
    const pageInfo = pageMeta(page, dashboard.total, pageSize);
    res.render('waitlist-admin', {
      entries: dashboard.entries,
      totalAll: dashboard.totalAll,
      newToday: dashboard.newToday,
      search,
      selectedStatus: WAITLIST_STATUSES.includes(status) ? status : '',
      statuses: WAITLIST_STATUSES,
      pageInfo,
      waitlistPageUrl: (targetPage) => {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (WAITLIST_STATUSES.includes(status)) params.set('status', status);
        params.set('page', String(targetPage));
        return `/admin/waitlist?${params.toString()}`;
      },
      notice: cleanText(req.query.notice, 180)
    });
  } catch (err) {
    console.error('Waitlist admin database unavailable:', err.message);
    res.status(503).render('message', { title: 'Database temporarily unavailable', message: 'Priority List records could not be loaded. Please refresh in a moment.' });
  }
});

app.post('/admin/waitlist/:id/status', requireAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!WAITLIST_STATUSES.includes(status)) return res.status(400).render('message', { title: 'Invalid status', message: 'Choose a valid Priority List status.' });
    const entry = await updateWaitlistStatus(req.params.id, status);
    if (!entry) return res.status(404).render('message', { title: 'Entry not found', message: 'This Priority List entry no longer exists.' });
    res.redirect('/admin/waitlist?notice=Status%20updated');
  } catch (err) {
    console.error('Waitlist status update failed:', err.message);
    res.status(503).render('message', { title: 'Update failed', message: 'The status could not be saved. Please try again.' });
  }
});

app.get('/admin/waitlist/export.csv', requireAdmin, async (req, res) => {
  try {
    const entries = await exportWaitlistEntries();
    const columns = ['ID', 'Full name', 'Phone', 'Email', 'Instagram username', 'Attended before', 'Referral source', 'Consent', 'Status', 'Submitted at', 'Updated at'];
    const rows = entries.map(entry => [entry.id, entry.fullName, entry.phone, entry.email, entry.instagramUsername, entry.attendedBefore, entry.referralSource, entry.consent ? 'Yes' : 'No', entry.status, entry.createdAt, entry.updatedAt]);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="asile-priority-access.csv"',
      'Cache-Control': 'no-store'
    });
    res.send(`\uFEFF${[columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}`);
  } catch (err) {
    console.error('Waitlist CSV export failed:', err.message);
    res.status(503).render('message', { title: 'Export failed', message: 'The Priority List CSV could not be created. Please try again.' });
  }
});

app.get('/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    try {
      if (await syncOrderFromStripe(order)) await upsertOrder(order);
    } catch (err) {
      console.error('Stripe order sync failed:', err.message);
    }
    const tickets = order ? await getTicketsByOrderId(order.id) : [];
    const orderEvent = order ? {
      ...eventInfo,
      EVENT_NAME: order.eventName || EVENT_NAME,
      EVENT_DATE: order.eventDate || EVENT_DATE,
      EVENT_TIME: order.eventTime || EVENT_TIME,
      EVENT_LOCATION: order.eventLocation || EVENT_LOCATION,
      DRESS_CODE: order.dressCode || DRESS_CODE,
      MIN_AGE: order.minimumAge || MIN_AGE,
      TICKET_PRICE: order.ticketPrice || TICKET_PRICE,
      BAR_PARTNER: order.barPartner || BAR_PARTNER,
      SPONSOR_NAME: order.sponsorName || SPONSOR_NAME,
      PHOTO_BOOTH_PARTNER: order.photoBoothPartner || PHOTO_BOOTH_PARTNER
    } : eventInfo;
    res.render('order', { order, tickets, ...orderEvent, money });
  } catch (err) {
    console.error('Admin order database unavailable:', req.params.id, err.message);
    res.status(503).render('message', { title: 'Database temporarily unavailable', message: 'This order could not be loaded right now. Please refresh in a moment.' });
  }
});

app.post('/admin/orders/delete-stuck', requireAdmin, async (req, res) => {
  const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
  if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event first.' });
  const db = await readDb();
  const ticketOrderIds = new Set((db.tickets || []).map(ticket => ticket.orderId).filter(Boolean));
  const stuckOrderIds = db.orders
    .filter(order => belongsToEvent(order, event) && isStuckOrder(order) && !ticketOrderIds.has(order.id))
    .map(order => order.id);
  await deleteOrders(stuckOrderIds);
  res.redirect(adminEventRedirect(event, `${stuckOrderIds.length} stuck order(s) deleted.`));
});

app.post('/admin/orders/sync-payments', requireAdmin, async (req, res) => {
  try {
    const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
    if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event first.' });
    const result = await syncWaitingOrdersFromStripe(event);
    const message = result.failed
      ? `Synced ${result.synced} payment(s). ${result.failed} could not be checked.`
      : `Synced ${result.synced} payment(s).`;
    res.redirect(adminEventRedirect(event, message));
  } catch (err) {
    console.error('Payment sync failed:', err.message);
    res.redirect(`/admin?notice=${encodeURIComponent('Payment sync is temporarily unavailable. Please try again in a minute.')}`);
  }
});

app.post('/admin/orders/sync-payments.json', requireAdmin, async (req, res) => {
  try {
    const event = await getAdminEventContext(cleanText(req.query.event, 80));
    if (!event) return res.status(404).json({ ok: false, checked: 0, synced: 0, failed: 1, error: 'Event not found.' });
    const result = await syncWaitingOrdersFromStripe(event);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Payment sync JSON failed:', err.message);
    res.status(503).json({ ok: false, checked: 0, synced: 0, failed: 1, error: 'Payment sync is temporarily unavailable.' });
  }
});

app.post('/admin/orders/repair-issued-statuses', requireAdmin, async (req, res) => {
  const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
  if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event first.' });
  const pendingOrders = (await getPendingOrdersWithIssuedTickets(300)).filter(order => belongsToEvent(order, event));
  let repaired = 0;
  for (const order of pendingOrders) {
    order.status = 'approved_captured';
    order.approvedAt = order.approvedAt || order.updatedAt || new Date().toISOString();
    order.repairedAt = new Date().toISOString();
    order.repairReason = 'Order had issued tickets while still marked pending approval.';
    await upsertOrder(order);
    repaired++;
  }
  const message = repaired
    ? `Marked ${repaired} issued ticket order(s) as approved. Use Review > Resend ticket email if a buyer did not receive the email.`
    : 'No pending orders with issued tickets were found.';
  res.redirect(adminEventRedirect(event, message));
});

app.post('/admin/vip-codes', requireAdmin, async (req, res) => {
  const rawCode = normalizeVipCode(req.body.code);
  const maxTickets = Number(req.body.maxTickets || 1);
  if (!rawCode || !Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 10) {
    return res.status(400).render('message', { title: 'Invalid VIP code', message: 'Enter a code and a max ticket number from 1 to 10.' });
  }
  const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
  if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event before creating a VIP code.' });
  await upsertVipCode({ code: rawCode, eventId: event.id, eventName: event.EVENT_NAME, maxTickets, active: true });
  res.redirect(`/admin?event=${encodeURIComponent(event.id)}&notice=${encodeURIComponent(`VIP code ${rawCode} is ready.`)}`);
});

app.post('/admin/vip-codes/:code/disable', requireAdmin, async (req, res) => {
  const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
  if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event first.' });
  await setVipCodeActive(req.params.code, false);
  res.redirect(adminEventRedirect(event, `VIP code ${normalizeVipCode(req.params.code)} was disabled.`));
});

app.post('/admin/vip-codes/:code/enable', requireAdmin, async (req, res) => {
  const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
  if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event first.' });
  await setVipCodeActive(req.params.code, true);
  res.redirect(adminEventRedirect(event, `VIP code ${normalizeVipCode(req.params.code)} was enabled.`));
});

app.post('/admin/orders/:id/delete', requireAdmin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (stripe && order?.paymentIntentId && ['pending_admin_approval', 'awaiting_payment_authorization'].includes(order.status)) {
    try { await stripe.paymentIntents.cancel(order.paymentIntentId); }
    catch (err) { console.error('Stripe payment release before delete failed:', err.message); }
  }
  await deleteOrderWithTickets(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/tickets/:id/delete', requireAdmin, async (req, res) => {
  await deleteTickets([req.params.id]);
  res.redirect('/admin');
});

app.post('/admin/manual-ticket', requireAdmin, async (req, res) => {
  const event = await getAdminEventContext(cleanText(req.body.eventId, 80));
  if (!event) return res.status(404).render('message', { title: 'Event not found', message: 'Choose an existing event before creating a ticket.' });
  const firstName = cleanName(req.body.firstName);
  const lastName = cleanName(req.body.lastName);
  const attendeeName = combineName(firstName, lastName);
  const buyerEmail = String(req.body.buyerEmail || '').trim();
  const gender = normalizeGender(req.body.gender);
  const dob = String(req.body.dateOfBirth || '').trim();
  const parsedDob = parseDobInput(dob);

  if (!firstName || !lastName || !parsedDob || !gender) {
    return res.status(400).render('message', { title: 'Missing manual ticket info', message: 'Enter first name, last name, date of birth as DD/MM/YYYY, and gender.' });
  }
  if (!isOldEnough(dob, event)) {
    return res.status(400).render('message', { title: 'Age requirement', message: `The attendee must be ${event.MIN_AGE}+ by ${event.EVENT_DATE}.` });
  }

  const createdAt = new Date().toISOString();
  const order = {
    id: `MANUAL-${id(10)}`,
    eventId: event.id,
    eventName: event.EVENT_NAME,
    eventDate: event.EVENT_DATE,
    eventTime: event.EVENT_TIME,
    eventLocation: event.EVENT_LOCATION,
    eventCapacity: event.CAPACITY,
    ticketPrice: event.TICKET_PRICE,
    dressCode: event.DRESS_CODE,
    minimumAge: event.MIN_AGE,
    barPartner: event.BAR_PARTNER,
    sponsorName: event.SPONSOR_NAME,
    photoBoothPartner: event.PHOTO_BOOTH_PARTNER,
    buyerName: attendeeName,
    buyerEmail,
    qty: 1,
    attendees: [{ firstName, lastName, name: attendeeName, dateOfBirth: parsedDob.display, gender }],
    amount: 0,
    paymentMethods: ['Manual'],
    paymentProvider: 'Manual admin ticket',
    status: 'approved_captured',
    approvedAt: createdAt,
    createdAt
  };
  // Validate duplicate name + capacity and persist the order and its ticket in
  // one atomic step, consistent with the buyer reservation flow.
  const reservation = await reserveAtomic(async freshDb => {
    if (usedNameKeys(freshDb, event).has(nameKey(attendeeName))) return { error: 'duplicate' };
    const ticket = await createTicketForAttendee(order, order.attendees[0], {
      manual: true,
      price: 'Manual ticket',
      createdAt
    });
    return { order, tickets: [ticket], ticket };
  });
  if (reservation.error === 'duplicate') {
    return res.status(400).render('message', { title: 'Duplicate name', message: 'This attendee name already has a ticket or active order.' });
  }
  if (reservation.error) {
    return res.status(500).render('message', { title: 'Manual ticket error', message: 'The ticket could not be created. Please try again.' });
  }
  const ticket = reservation.ticket;

  if (buyerEmail) {
    const attachments = [qrAttachmentForTicket(ticket)].filter(Boolean);
    sendMailInBackground({
      to: buyerEmail,
      subject: `Your ${event.EVENT_NAME} ticket credentials`,
      html: ticketEmailBackground(`<p style="margin:0 0 12px;color:#fff4df">Your ticket is ready.</p>${ticketEmailHtml(ticket)}`),
      text: `Your ticket is ready.\n\n${ticketEmailText(ticket)}`,
      attachments
    });
  }
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/approve', requireAdmin, async (req, res) => {
  console.log('APPROVE:start', req.params.id);
  const order = await getOrderById(req.params.id);
  console.log('APPROVE:order-loaded', req.params.id, 'status=', order && order.status, 'hasPaymentIntent=', Boolean(order && order.paymentIntentId));
  if (!order || order.status !== 'pending_admin_approval') return res.status(400).send('Order is not pending approval.');
  if (!stripe) return res.status(503).render('message', { title: 'Stripe setup needed', message: 'STRIPE_SECRET_KEY is missing on the server.' });
  if (!order.paymentIntentId) return res.status(400).render('message', { title: 'No payment on file', message: 'This order has no Stripe payment to capture. It may not have completed checkout.' });
  try {
    console.log('APPROVE:capturing', order.paymentIntentId);
    await stripe.paymentIntents.capture(order.paymentIntentId);
    console.log('APPROVE:captured', order.paymentIntentId);
  } catch (err) {
    // Capture failed — inspect the real payment state before deciding. A previous
    // attempt may have already captured (e.g. the response was lost), in which
    // case we must still issue the ticket rather than leave the buyer charged
    // with nothing. Manual-capture authorizations also expire after ~7 days.
    console.warn('APPROVE:capture-failed', order.paymentIntentId, '-', err.message);
    let intentStatus = null;
    try {
      const intent = await stripe.paymentIntents.retrieve(order.paymentIntentId);
      intentStatus = intent.status;
    } catch (lookupErr) {
      console.error('Payment intent lookup failed:', lookupErr.message);
    }
    if (intentStatus === 'succeeded') {
      console.warn('APPROVE:already-captured', order.id, '- continuing to issue tickets.');
    } else if (['canceled', 'requires_payment_method'].includes(intentStatus)) {
      order.status = 'authorization_expired';
      order.paymentError = err.message;
      await upsertOrder(order);
      sendMailInBackground({ to: order.buyerEmail, subject: `${EVENT_NAME} - please re-book your ticket`, html: `<p>We could not finalize your ${EVENT_NAME} ticket because the payment authorization expired (card holds expire after about 7 days). No charge was made.</p><p>Please reserve again here: <a href="${BASE_URL}/">${BASE_URL}</a></p>` });
      return res.status(409).render('message', { title: 'Authorization expired', message: 'The payment hold expired (Stripe authorizations last about 7 days). The order was released and the buyer was emailed to re-book.' });
    } else {
      return res.status(502).render('message', { title: 'Payment capture failed', message: err.message });
    }
  }
  // Persist captured status immediately so a failure while issuing tickets can't
  // leave a charged order stuck in "pending".
  order.status = 'approved_captured'; order.approvedAt = order.approvedAt || new Date().toISOString();
  await upsertOrder(order);
  console.log('APPROVE:status-saved', order.id);
  // Reuse tickets already issued for this order (idempotent on retry) instead of
  // minting duplicates.
  let newTickets = (await getTicketsByOrderId(order.id)).filter(t => t.status === 'valid');
  if (newTickets.length < (order.attendees || []).length) {
    newTickets = [];
    for (const attendee of order.attendees) {
      const ticket = await createTicketForAttendee(order, attendee);
      newTickets.push(ticket);
    }
    for (const ticket of newTickets) await upsertTicket(ticket);
  }
  console.log('APPROVE:tickets-ready', order.id, 'count=', newTickets.length);
  const ticketHtml = newTickets.map(ticketEmailHtml).join('');
  const ticketText = newTickets.map(ticketEmailText).join('\n\n');
  const attachments = newTickets.map(qrAttachmentForTicket).filter(Boolean);
  sendMailInBackground({
    to: order.buyerEmail,
    subject: `Your ${EVENT_NAME} ticket`,
    html: ticketEmailBackground(`<p style="margin:0 0 12px;color:#fff4df">Approved. Your ticket is ready.</p>${ticketHtml}`),
    text: `Approved. Your ticket is ready.\n\n${ticketText}`,
    attachments
  });
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/replacement-ticket', requireAdmin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order || order.status !== 'approved_captured') return res.status(400).send('Replacement tickets can only be generated for approved paid orders.');
  const attendeeIndex = Number(req.body.attendeeIndex);
  const attendee = order.attendees?.[attendeeIndex];
  if (!attendee) return res.status(400).send('Attendee not found.');

  const ticket = await createTicketForAttendee(order, attendee, {
    replacement: true,
    replacementForName: attendee.name
  });
  const now = new Date().toISOString();
  const replacedTickets = [];
  for (const existing of await getTicketsByOrderId(order.id)) {
    if (existing.attendeeName === attendee.name && existing.status === 'valid') {
      existing.status = 'void_replaced';
      existing.replacedAt = now;
      existing.replacedByTicketId = ticket.id;
      replacedTickets.push(existing);
    }
  }
  for (const changedTicket of [...replacedTickets, ticket]) await upsertTicket(changedTicket);
  const attachments = [qrAttachmentForTicket(ticket)].filter(Boolean);
  sendMailInBackground({
    to: order.buyerEmail,
    subject: `Replacement ${EVENT_NAME} ticket`,
    html: ticketEmailBackground(`<p style="margin:0 0 12px;color:#fff4df">Replacement ticket for ${attendee.name}. Use this QR only.</p>${ticketEmailHtml(ticket)}`),
    text: `Replacement ticket for ${attendee.name}. Use this QR only.\n\n${ticketEmailText(ticket)}`,
    attachments
  });
  res.redirect(`/admin/orders/${order.id}`);
});

// Resend the ticket email for an already-approved order without minting new
// tickets — for buyers who lost the email or when a send silently failed.
app.post('/admin/orders/:id/resend-ticket', requireAdmin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order || order.status !== 'approved_captured') return res.status(400).render('message', { title: 'Cannot resend', message: 'Ticket email can only be resent for approved paid orders.' });
  if (!order.buyerEmail) return res.status(400).render('message', { title: 'No email on file', message: 'This order has no buyer email address to send to.' });
  const validTickets = (await getTicketsByOrderId(order.id)).filter(t => t.status === 'valid');
  if (!validTickets.length) return res.status(400).render('message', { title: 'No tickets', message: 'This order has no valid tickets to send.' });
  const ticketHtml = validTickets.map(ticketEmailHtml).join('');
  const attachments = validTickets.map(qrAttachmentForTicket).filter(Boolean);
  const sent = await sendMail({ to: order.buyerEmail, subject: `Your ${EVENT_NAME} ticket`, html: `<p>Here is your ticket again.</p>${ticketHtml}`, attachments });
  return res.render('message', { title: sent ? 'Ticket resent' : 'Resend failed', message: sent ? `Ticket email resent to ${order.buyerEmail}. Ask the buyer to check spam/promotions too.` : 'The email could not be sent. Check the server SMTP settings and logs.' });
});

app.post('/admin/orders/:id/deny', requireAdmin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order || order.status !== 'pending_admin_approval') return res.status(400).send('Order is not pending approval.');
  if (!stripe) return res.status(503).render('message', { title: 'Stripe setup needed', message: 'STRIPE_SECRET_KEY is missing on the server.' });
  try { await stripe.paymentIntents.cancel(order.paymentIntentId); }
  catch (err) { return res.status(502).render('message', { title: 'Payment release failed', message: err.message }); }
  order.status = 'denied_released'; order.deniedAt = new Date().toISOString(); await upsertOrder(order);
  const declineMessage = 'Unfortunately, we are unable to approve your ticket request. To maintain the atmosphere of the event, we carefully manage the overall guest balance, including the male-to-female ratio, and prioritize couples for admission.';
  sendMailInBackground({
    to: order.buyerEmail,
    subject: `${EVENT_NAME} reservation not approved`,
    html: ticketEmailBackground(`<p style="margin:0 0 12px;color:#fff4df">${declineMessage}</p><p style="margin:0;color:#d8bc8b">Your payment authorization has been cancelled/released.</p>`),
    text: `${declineMessage}\n\nYour payment authorization has been cancelled/released.`
  });
  res.redirect(`/admin/orders/${order.id}`);
});

app.get('/admin/scanner', requireAdmin, async (req, res) => {
  const scans = await readRecentScans({ limit: 100 });
  res.render('scanner-admin', { scans, notice: cleanText(req.query.notice, 180) });
});
app.get('/admin/scan', requireAdmin, async (req, res) => {
  const ticket = await getTicketById(req.query.ticket);
  res.render('scan-result', {
    ticket,
    ...eventInfo,
    scanError: req.query.error === 'checkin',
    justCheckedIn: req.query.checkedIn === '1',
    scanAgainPath: '/admin/scanner',
    checkInPath: `/admin/tickets/${encodeURIComponent(req.query.ticket || '')}/check-in`
  });
});
app.post('/admin/tickets/:id/check-in', requireAdmin, async (req, res) => {
  try {
    const result = await safeCheckIn(req.params.id, req.session.adminName || 'Admin');
    const checkedIn = result.result === 'checked_in' ? '&checkedIn=1' : '';
    res.redirect(`/admin/scan?ticket=${encodeURIComponent(req.params.id)}${checkedIn}`);
  } catch (err) {
    console.error('Admin check-in failed:', { ticketId: req.params.id, message: err.message });
    res.redirect(`/admin/scan?ticket=${encodeURIComponent(req.params.id)}&error=checkin`);
  }
});
app.post('/admin/scans/:id/reset', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req, 30)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try resetting this ticket again in a few minutes.' });
  const result = await resetTicketCheckIn(req.params.id, req.session.adminName || 'Admin');
  const notice = result.result === 'reset'
    ? 'Ticket reset. It can be scanned again.'
    : result.result === 'not_checked_in'
      ? 'This ticket is already available to scan.'
      : 'Ticket not found.';
  res.redirect(`/admin/scanner?notice=${encodeURIComponent(notice)}`);
});
app.post('/admin/scanner/test-tickets', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req, 4)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try creating the test tickets again in a few minutes.' });
  const event = currentEventContext();
  const createdAt = new Date().toISOString();
  const attendees = Array.from({ length: 20 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return { firstName: 'Scanner', lastName: `Test ${number}`, name: `Scanner Test ${number}`, dateOfBirth: '01/01/2000', gender: '' };
  });
  const order = {
    id: `SCANNER-TEST-${id(10)}`,
    eventId: event.id,
    eventName: event.EVENT_NAME,
    eventDate: event.EVENT_DATE,
    eventTime: event.EVENT_TIME,
    eventLocation: event.EVENT_LOCATION,
    eventCapacity: event.CAPACITY,
    ticketPrice: 0,
    dressCode: event.DRESS_CODE,
    minimumAge: event.MIN_AGE,
    barPartner: event.BAR_PARTNER,
    sponsorName: event.SPONSOR_NAME,
    photoBoothPartner: event.PHOTO_BOOTH_PARTNER,
    buyerName: 'Scanner Test Batch',
    buyerEmail: '',
    qty: attendees.length,
    attendees,
    amount: 0,
    paymentMethods: ['Scanner test'],
    paymentProvider: 'Scanner test only',
    status: 'approved_captured',
    approvedAt: createdAt,
    createdAt,
    scannerTestBatch: SCANNER_TEST_BATCH,
    createdBy: req.session.adminName || 'Admin'
  };
  const reservation = await reserveAtomic(async freshDb => {
    if ((freshDb.tickets || []).some(ticket => ticket.scannerTestBatch === SCANNER_TEST_BATCH)) return { error: 'already_exists' };
    const tickets = [];
    for (const attendee of attendees) {
      tickets.push(await createTicketForAttendee(order, attendee, {
        manual: true,
        price: 'Scanner test',
        createdAt,
        scannerTestBatch: SCANNER_TEST_BATCH
      }));
    }
    return { order, tickets };
  });
  const notice = reservation.error === 'already_exists'
    ? 'The 20 scanner test tickets already exist.'
    : reservation.error
      ? 'Test tickets could not be created. Please try again.'
      : '20 scanner test tickets were created. No payment or email was used.';
  res.redirect(`/admin/scanner?notice=${encodeURIComponent(notice)}`);
});
app.post('/admin/scanner/test-tickets/remove', requireAdmin, async (req, res) => {
  if (!sensitiveRateAllowed(req, 4)) return res.status(429).render('message', { title: 'Please slow down', message: 'Try removing the test tickets again in a few minutes.' });
  const deleted = await removeScannerTestTickets(SCANNER_TEST_BATCH);
  res.redirect(`/admin/scanner?notice=${encodeURIComponent(`Removed ${deleted.ticketsDeleted} scanner test ticket(s) and their scan records.`)}`);
});
app.get('/scanner', requireScanner, async (req, res) => {
  const recentScans = await readRecentScans({ limit: 10 });
  res.render('scanner', {
    scanResultPath: '/scanner/scan',
    backUrl: req.session.admin ? '/admin' : '/scanner/logout',
    backLabel: req.session.admin ? 'Back to dashboard' : 'Log out scanner',
    recentScans
  });
});
app.get('/scanner/scan', requireScanner, async (req, res) => {
  const ticket = await getTicketById(req.query.ticket);
  res.render('scan-result', {
    ticket,
    ...eventInfo,
    scanError: req.query.error === 'checkin',
    justCheckedIn: req.query.checkedIn === '1',
    scanAgainPath: '/scanner',
    checkInPath: `/scanner/tickets/${encodeURIComponent(req.query.ticket || '')}/check-in`
  });
});
app.post('/scanner/tickets/:id/check-in', requireScanner, async (req, res) => {
  try {
    const result = await safeCheckIn(req.params.id, req.session.adminName || req.session.scannerName || 'Door Scanner');
    const checkedIn = result.result === 'checked_in' ? '&checkedIn=1' : '';
    res.redirect(`/scanner/scan?ticket=${encodeURIComponent(req.params.id)}${checkedIn}`);
  } catch (err) {
    console.error('Scanner check-in failed:', { ticketId: req.params.id, message: err.message });
    res.redirect(`/scanner/scan?ticket=${encodeURIComponent(req.params.id)}&error=checkin`);
  }
});

// Catch-all error handler: Express 5 forwards async route rejections here (e.g.
// a Postgres query timeout in readDb). Without this, requests return a bare
// "Internal Server Error"; here we log the cause and show a friendly page.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', req.method, req.originalUrl, '-', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).render('message', { title: 'Something went wrong', message: 'A temporary error occurred. Please refresh and try again in a moment.' });
});

// Last-resort process guards: log instead of letting a stray rejection or
// background error take the whole server down.
process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION:', reason && reason.stack ? reason.stack : reason));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err));

Promise.all([initDb(), ensureCustomerMarketingSchema()]).then(() => app.listen(PORT, () => console.log(`Running on ${BASE_URL}`))).catch(err => {
  console.error('Database startup failed:', err);
  process.exit(1);
});
