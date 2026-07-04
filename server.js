require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY, { timeout: Number(process.env.STRIPE_TIMEOUT_MS || 10000) }) : null;
const { initDb, readDb, readAdminDashboard, upsertOrder, upsertTicket, deleteOrders, deleteTickets, deleteOrderWithTickets, safeCheckIn, usePostgres, getPool, reserveAtomic, getOrderById, getTicketsByOrderId, getPendingOrdersWithIssuedTickets, getTicketById, ticketIdExists } = require('./db');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const EVENT_NAME = process.env.EVENT_NAME || 'Sunset House Party';
const COMPANY_NAME = process.env.COMPANY_NAME || "ASIL'E";
const EVENT_LOCATION = process.env.EVENT_LOCATION || 'Cremisan';
const EVENT_DATE = process.env.EVENT_DATE || 'July 24, 2026';
const EVENT_TIME = process.env.EVENT_TIME || '5:30 PM–11:00 PM';
const EVENT_THEME = process.env.EVENT_THEME || 'House Music & Sunset Party';
const DRESS_CODE = process.env.DRESS_CODE || 'All White';
const MIN_AGE = Number(process.env.MIN_AGE || 18);
const CAPACITY = Number(process.env.CAPACITY || 1000);
const TICKET_PRICE = Number(process.env.TICKET_PRICE || 8000); // 8000 agorot = 80.00 ILS/NIS
const CURRENCY = (process.env.CURRENCY || 'ils').toLowerCase();
const MAP_URL = process.env.MAP_URL || 'https://www.google.com/maps?q=Cremisan';
const WHATSAPP_1 = process.env.WHATSAPP_1 || '972568576684';
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://www.instagram.com/events.asile?igsh=cXduejFvbHB4bjRo';
const BAR_PARTNER = process.env.BAR_PARTNER || 'Double Shake';
const SPONSOR_NAME = process.env.SPONSOR_NAME || 'Carlsberg';
const SPONSOR_LOGO_URL = process.env.SPONSOR_LOGO_URL || '/public/carlsberg-logo.jpeg';
const DJ_NAME = process.env.DJ_NAME || 'DJ Loco';
const DJ_IMAGE_URL = process.env.DJ_IMAGE_URL || '/public/dj-loco.jpeg';
const SITE_IMAGE_URL = process.env.SITE_IMAGE_URL || `${BASE_URL}/public/favicon.png?v=20260630b`;
const PAYMENT_METHODS = ['Apple Pay', 'Google Pay', 'Visa', 'Mastercard'];
const PAYMENT_PROVIDER_LABEL = process.env.PAYMENT_PROVIDER_LABEL || 'Stripe';
const PHOTO_BOOTH_PARTNER = process.env.PHOTO_BOOTH_PARTNER || 'Picka pic photo booth';

const eventInfo = { EVENT_NAME, COMPANY_NAME, EVENT_LOCATION, EVENT_DATE, EVENT_TIME, EVENT_THEME, DRESS_CODE, MIN_AGE, CAPACITY, TICKET_PRICE, CURRENCY, MAP_URL, WHATSAPP_1, INSTAGRAM_URL, BAR_PARTNER, SPONSOR_NAME, SPONSOR_LOGO_URL, DJ_NAME, DJ_IMAGE_URL, SITE_IMAGE_URL, PAYMENT_METHODS, PAYMENT_PROVIDER_LABEL, PHOTO_BOOTH_PARTNER };

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
    maxAge: '1h',
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }
  });
});
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.set('trust proxy', 1);

// Use a Postgres-backed session store when a database is configured so admin
// logins survive restarts/redeploys and are shared across multiple instances.
// Falls back to the in-memory store only for local development without a DB.
let sessionStore;
if (usePostgres()) {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: getPool(),
    createTableIfMissing: true,
    disableTouch: true,
    pruneSessionInterval: false,
    ttl: Number(process.env.SESSION_TTL_SECONDS || 7 * 24 * 60 * 60)
  });
}
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

function id(size = 12) { return crypto.randomBytes(size).toString('hex').slice(0, size).toUpperCase(); }
function money(amount = TICKET_PRICE) { return `${(amount / 100).toFixed(0)} NIS`; }
function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
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
function soldOrPendingCount(db) {
  return db.orders.filter(isActiveOrder).reduce((sum, o) => sum + Number(o.qty || 0), 0);
}
function usedNameKeys(db) {
  const fromTickets = db.tickets.filter(isIssuedTicket).map(t => nameKey(t.attendeeName || t.buyerName));
  const fromOrders = db.orders.filter(isNameBlockingOrder).flatMap(o => (o.attendees || []).map(a => nameKey(a.name || combineName(a.firstName, a.lastName))));
  return new Set([...fromTickets, ...fromOrders].filter(Boolean));
}
function normalizeGender(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['male', 'm'].includes(v)) return 'Male';
  if (['female', 'f'].includes(v)) return 'Female';
  return '';
}
function adminStats(db, approvedCountOverride) {
  const activeTickets = db.tickets.filter(isIssuedTicket);
  const pendingAttendees = db.orders
    .filter(o => o.status === 'pending_admin_approval')
    .flatMap(o => o.attendees || []);
  return {
    approvedCount: typeof approvedCountOverride === 'number' ? approvedCountOverride : activeTickets.length,
    awaitingPaymentCount: db.orders.filter(o => o.status === 'awaiting_payment_authorization').length,
    stuckOrderCount: db.orders.filter(isStuckOrder).length,
    remaining: Math.max(0, CAPACITY - soldOrPendingCount(db)),
    pendingCount: pendingAttendees.length
  };
}
function dashboardStats(stats) {
  if (!stats) return null;
  return {
    approvedCount: stats.approvedCount || 0,
    awaitingPaymentCount: stats.awaitingPaymentCount || 0,
    stuckOrderCount: stats.stuckOrderCount || 0,
    remaining: Math.max(0, CAPACITY - Number(stats.remainingSoldOrPending || 0)),
    pendingCount: stats.pendingCount || 0
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
  const query = params.toString();
  return query ? `/admin?${query}` : '/admin';
}
async function syncWaitingOrdersFromStripe() {
  const db = await readDb();
  let synced = 0;
  let failed = 0;
  const waitingOrders = db.orders.filter(order => order.status === 'awaiting_payment_authorization' && order.stripeSessionId);
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
function ageOnEvent(birth) {
  const eventDate = new Date('2026-07-24T17:30:00');
  if (!birth || birth > eventDate) return null;
  let age = eventDate.getFullYear() - birth.getFullYear();
  const monthDiff = eventDate.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && eventDate.getDate() < birth.getDate())) age--;
  return age;
}
function isOldEnough(dob) {
  const parsed = parseDobInput(dob);
  const age = parsed ? ageOnEvent(parsed.birth) : null;
  return age !== null && age >= MIN_AGE;
}
function requireAdmin(req, res, next) { if (req.session.admin) return next(); res.redirect('/admin/login'); }

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
  await sendMail({ to: process.env.ADMIN_EMAIL, subject: `Approve tickets: ${order.buyerName}`, html: `<p>${order.buyerName} requested ${order.qty} ticket(s) for ${EVENT_NAME}.</p><ul>${names}</ul><p><b>Event:</b> ${EVENT_DATE}, ${EVENT_TIME}, ${EVENT_LOCATION}</p><p><b>Price:</b> ${money(TICKET_PRICE)} per ticket. <b>Dress code:</b> ${DRESS_CODE}. <b>Age:</b> ${MIN_AGE}+. <b>Bar:</b> ${BAR_PARTNER}. <b>Sponsor:</b> ${SPONSOR_NAME}. <b>Included:</b> free ${PHOTO_BOOTH_PARTNER} picture.</p><p><a href="${BASE_URL}/admin/orders/${order.id}">Approve or deny this order</a></p>` });
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
    `${EVENT_NAME} ticket`,
    `Name: ${ticket.attendeeName}`,
    `Ticket ID: ${ticket.id}`,
    `Time: ${EVENT_TIME}`,
    `Location: ${EVENT_LOCATION}`,
    `Dress code: ${DRESS_CODE}`,
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
    attendeeFirstName: attendee.firstName || '',
    attendeeLastName: attendee.lastName || '',
    attendeeName: attendee.name,
    dateOfBirth: attendee.dateOfBirth,
    gender: attendee.gender,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    eventName: EVENT_NAME,
    eventDate: EVENT_DATE,
    eventTime: EVENT_TIME,
    location: EVENT_LOCATION,
    dressCode: DRESS_CODE,
    age: `${MIN_AGE}+`,
    price: money(TICKET_PRICE),
    barPartner: BAR_PARTNER,
    photoBoothPartner: PHOTO_BOOTH_PARTNER,
    sponsorName: SPONSOR_NAME,
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

app.get('/', async (req, res) => {
  res.render('home', { ...eventInfo, money });
});

app.post('/reserve', async (req, res) => {
  const buyerName = cleanName(req.body.buyerName);
  const buyerEmail = String(req.body.buyerEmail || '').trim();
  const attendeeFirstNames = asArray(req.body.attendeeFirstName).map(cleanName);
  const attendeeLastNames = asArray(req.body.attendeeLastName).map(cleanName);
  const legacyNames = asArray(req.body.attendeeName).map(cleanName);
  const attendeeDobs = asArray(req.body.attendeeDob).map(v => String(v || '').trim());
  const attendeeGenders = asArray(req.body.attendeeGender).map(normalizeGender);
  const attendeeNames = legacyNames.length ? legacyNames : attendeeFirstNames.map((first, i) => combineName(first, attendeeLastNames[i]));
  const qty = Number(req.body.quantity || attendeeNames.length || 1);
  if (!buyerName || !buyerEmail) return res.status(400).render('message', { title: 'Missing information', message: 'Buyer name and email are required.' });
  if (!Number.isFinite(qty) || qty < 1) return res.status(400).render('message', { title: 'Invalid quantity', message: 'Cannot order 0 tickets. Please order at least 1.' });
  if (!Number.isInteger(qty)) return res.status(400).render('message', { title: 'Invalid quantity', message: 'Please enter a whole number of tickets.' });
  if (qty > 10) return res.status(400).render('message', { title: 'Invalid quantity', message: 'Cannot order more than 10 tickets at once.' });
  if (attendeeNames.length !== qty || attendeeDobs.length !== qty || attendeeGenders.length !== qty || attendeeNames.some(n => !n) || (!legacyNames.length && (attendeeFirstNames.length !== qty || attendeeLastNames.length !== qty || attendeeFirstNames.some(n => !n) || attendeeLastNames.some(n => !n))) || attendeeDobs.some(d => !d) || attendeeGenders.some(g => !g)) return res.status(400).render('message', { title: 'Missing ticket forms', message: 'Each ticket needs a separate first name, last name, date of birth, and gender.' });
  if (attendeeDobs.some(d => !isOldEnough(d))) return res.status(400).render('message', { title: 'Age requirement', message: `Every attendee must enter a valid date of birth as DD/MM/YYYY and be ${MIN_AGE}+ by ${EVENT_DATE}.` });
  const keys = attendeeNames.map(nameKey);
  if (new Set(keys).size !== keys.length) return res.status(400).render('message', { title: 'Duplicate name', message: 'The same attendee name cannot be used twice in one order.' });

  const attendees = attendeeNames.map((name, i) => ({ firstName: attendeeFirstNames[i] || '', lastName: attendeeLastNames[i] || '', name, dateOfBirth: parseDobInput(attendeeDobs[i]).display, gender: attendeeGenders[i] }));
  const orderId = id(14);
  const order = { id: orderId, buyerName, buyerEmail, qty, attendees, amount: TICKET_PRICE * qty, paymentMethods: PAYMENT_METHODS, paymentProvider: PAYMENT_PROVIDER_LABEL, status: 'checkout_started', createdAt: new Date().toISOString() };
  console.log('CHECKOUT START', { orderId, buyerEmail, qty, amount: order.amount });
  // Capacity and cross-order duplicate-name checks run atomically against the
  // latest data so simultaneous buyers cannot oversell or double-book a name.
  let reservation;
  try {
    reservation = await reserveAtomic(freshDb => {
      if (keys.some(k => usedNameKeys(freshDb).has(k))) return { error: 'duplicate' };
      if (soldOrPendingCount(freshDb) + qty > CAPACITY) return { error: 'soldout' };
      return { order };
    });
  } catch (err) {
    console.error('CHECKOUT RESERVATION FAILED', { orderId, message: err.message });
    return res.status(503).render('message', { title: 'Reservation is slow', message: 'The reservation system is taking too long. Please try again in a moment.' });
  }
  if (reservation.error === 'duplicate') return res.status(400).render('message', { title: 'Duplicate name', message: 'One of these attendee names has already been used for another ticket.' });
  if (reservation.error === 'soldout') return res.status(400).render('message', { title: 'Sold out', message: 'This order goes over the event capacity.' });
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
      line_items: [{ price_data: { currency: CURRENCY, product_data: { name: `${EVENT_NAME} ticket`, description: `${DRESS_CODE} dress code · ${MIN_AGE}+ · Free ${PHOTO_BOOTH_PARTNER} photo · Sponsor: ${SPONSOR_NAME}` }, unit_amount: TICKET_PRICE }, quantity: qty }],
      payment_intent_data: { capture_method: 'manual', metadata: { orderId, eventName: EVENT_NAME, companyName: COMPANY_NAME } },
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
});

app.get('/success', (req, res) => res.render('message', { title: 'Reservation received', message: `Your payment is authorized. Your ${EVENT_NAME} ticket will be sent only after admin approval. Please check your inbox and spam/junk folder for the ticket email.` }));
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
app.get('/admin', requireAdmin, async (req, res) => {
  const pageSize = 10;
  const searches = {
    orderSearch: String(req.query.orderSearch || '').trim(),
    orderStatus: String(req.query.orderStatus || '').trim(),
    ticketSearch: String(req.query.ticketSearch || '').trim()
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
    scanOffset: (pages.scansPage - 1) * pageSize
  });
  res.render('admin', {
    orders: dashboard.orders,
    tickets: dashboard.tickets.filter(isIssuedTicket),
    scanHistory: dashboard.scanHistory || [],
    pagination: {
      pages,
      searches,
      orders: pageMeta(pages.ordersPage, dashboard.orderCount, pageSize),
      tickets: pageMeta(pages.ticketsPage, dashboard.ticketCount, pageSize),
      scans: pageMeta(pages.scansPage, dashboard.scanCount, pageSize)
    },
    adminPageUrl,
    stats: dashboardStats(dashboard.stats) || adminStats({ orders: dashboard.allOrders, tickets: dashboard.allTickets }, dashboard.approvedCount),
    ...eventInfo,
    money,
    orderStatusLabel,
    statusClass,
    notice: req.query.notice || '',
    usePostgres: usePostgres()
  });
});
app.get('/admin/orders/:id', requireAdmin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  try {
    if (await syncOrderFromStripe(order)) await upsertOrder(order);
  } catch (err) {
    console.error('Stripe order sync failed:', err.message);
  }
  const tickets = order ? await getTicketsByOrderId(order.id) : [];
  res.render('order', { order, tickets, ...eventInfo, money });
});

app.post('/admin/orders/delete-stuck', requireAdmin, async (req, res) => {
  const db = await readDb();
  const ticketOrderIds = new Set((db.tickets || []).map(ticket => ticket.orderId).filter(Boolean));
  const stuckOrderIds = db.orders
    .filter(order => isStuckOrder(order) && !ticketOrderIds.has(order.id))
    .map(order => order.id);
  await deleteOrders(stuckOrderIds);
  res.redirect('/admin');
});

app.post('/admin/orders/sync-payments', requireAdmin, async (req, res) => {
  const result = await syncWaitingOrdersFromStripe();
  const message = result.failed
    ? `Synced ${result.synced} payment(s). ${result.failed} could not be checked.`
    : `Synced ${result.synced} payment(s).`;
  res.redirect(`/admin?notice=${encodeURIComponent(message)}`);
});

app.post('/admin/orders/sync-payments.json', requireAdmin, async (req, res) => {
  const result = await syncWaitingOrdersFromStripe();
  res.json({ ok: true, ...result });
});

app.post('/admin/orders/repair-issued-statuses', requireAdmin, async (req, res) => {
  const pendingOrders = await getPendingOrdersWithIssuedTickets(300);
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
  res.redirect(`/admin?notice=${encodeURIComponent(message)}`);
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
  if (!isOldEnough(dob)) {
    return res.status(400).render('message', { title: 'Age requirement', message: `The attendee must be ${MIN_AGE}+ by ${EVENT_DATE}.` });
  }

  const createdAt = new Date().toISOString();
  const order = {
    id: `MANUAL-${id(10)}`,
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
    if (usedNameKeys(freshDb).has(nameKey(attendeeName))) return { error: 'duplicate' };
    if (soldOrPendingCount(freshDb) + 1 > CAPACITY) return { error: 'soldout' };
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
  if (reservation.error === 'soldout') {
    return res.status(400).render('message', { title: 'Sold out', message: 'This manual ticket goes over the event capacity.' });
  }
  if (reservation.error) {
    return res.status(500).render('message', { title: 'Manual ticket error', message: 'The ticket could not be created. Please try again.' });
  }
  const ticket = reservation.ticket;

  if (buyerEmail) {
    const attachments = [qrAttachmentForTicket(ticket)].filter(Boolean);
    sendMailInBackground({
      to: buyerEmail,
      subject: `Your ${EVENT_NAME} ticket credentials`,
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
  sendMailInBackground({ to: order.buyerEmail, subject: `${EVENT_NAME} reservation not approved`, html: `<p>Your reservation was not approved. Your payment authorization has been cancelled/released.</p>` });
  res.redirect(`/admin/orders/${order.id}`);
});

app.get('/admin/scanner', requireAdmin, (req, res) => res.render('scanner')); // Camera scanning requires HTTPS on phones, except localhost.
app.get('/admin/scan', requireAdmin, async (req, res) => { const ticket = await getTicketById(req.query.ticket); res.render('scan-result', { ticket, ...eventInfo }); });
app.post('/admin/tickets/:id/check-in', requireAdmin, async (req, res) => {
  try {
    await safeCheckIn(req.params.id, req.session.adminName || 'Admin');
    res.redirect(`/admin/scan?ticket=${encodeURIComponent(req.params.id)}`);
  } catch (err) {
    res.status(500).render('message', { title: 'Check-in error', message: 'The ticket could not be checked in. Please try again.' });
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

initDb().then(() => app.listen(PORT, () => console.log(`Running on ${BASE_URL}`))).catch(err => {
  console.error('Database startup failed:', err);
  process.exit(1);
});
