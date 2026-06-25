require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const { initDb, readDb, writeDb, safeCheckIn, usePostgres } = require('./db');

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
const CAPACITY = Number(process.env.CAPACITY || 500);
const TICKET_PRICE = Number(process.env.TICKET_PRICE || 8000); // 8000 agorot = 80.00 ILS/NIS
const CURRENCY = (process.env.CURRENCY || 'ils').toLowerCase();
const MAP_URL = process.env.MAP_URL || 'https://www.google.com/maps?q=Cremisan';
const WHATSAPP_1 = process.env.WHATSAPP_1 || '972568576684';
const WHATSAPP_2 = process.env.WHATSAPP_2 || '972532288098';
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || '#';
const BAR_PARTNER = process.env.BAR_PARTNER || 'Double Shake';
const SPONSOR_NAME = process.env.SPONSOR_NAME || 'Shepherds Beer';
const SPONSOR_LOGO_URL = process.env.SPONSOR_LOGO_URL || '/public/shepherds-beer-logo.svg';
const PAYMENT_METHODS = ['Apple Pay', 'Google Pay', 'Visa', 'Mastercard'];
const PAYMENT_PROVIDER_LABEL = process.env.PAYMENT_PROVIDER_LABEL || 'Stripe';
const PHOTO_BOOTH_PARTNER = process.env.PHOTO_BOOTH_PARTNER || 'Pica Pic Photo Booth';

const eventInfo = { EVENT_NAME, COMPANY_NAME, EVENT_LOCATION, EVENT_DATE, EVENT_TIME, EVENT_THEME, DRESS_CODE, MIN_AGE, CAPACITY, TICKET_PRICE, CURRENCY, MAP_URL, WHATSAPP_1, WHATSAPP_2, INSTAGRAM_URL, BAR_PARTNER, SPONSOR_NAME, SPONSOR_LOGO_URL, PAYMENT_METHODS, PAYMENT_PROVIDER_LABEL, PHOTO_BOOTH_PARTNER }; 

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.set('trust proxy', 1);
app.use(session({
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
  const inactive = ['denied_released', 'cancelled', 'rejected_refunded', 'payment_error'];
  if (inactive.includes(order.status)) return false;
  // Do not hold names/capacity forever if someone starts checkout and never pays.
  if (['checkout_started', 'awaiting_payment_authorization'].includes(order.status)) {
    const created = new Date(order.createdAt || 0).getTime();
    return Date.now() - created < 30 * 60 * 1000;
  }
  return true;
}
function soldOrPendingCount(db) {
  return db.orders.filter(isActiveOrder).reduce((sum, o) => sum + Number(o.qty || 0), 0);
}
function usedNameKeys(db) {
  const fromTickets = db.tickets.map(t => nameKey(t.attendeeName || t.buyerName));
  const fromOrders = db.orders.filter(isActiveOrder).flatMap(o => (o.attendees || []).map(a => nameKey(a.name || combineName(a.firstName, a.lastName))));
  return new Set([...fromTickets, ...fromOrders].filter(Boolean));
}
function normalizeGender(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['male', 'm'].includes(v)) return 'Male';
  if (['female', 'f'].includes(v)) return 'Female';
  return '';
}
function genderStatsFromAttendees(attendees = []) {
  const stats = { male: 0, female: 0, unknown: 0, total: 0, femalePercent: 0, malePercent: 0 };
  for (const a of attendees) {
    const gender = normalizeGender(a.gender);
    if (gender === 'Female') stats.female++;
    else if (gender === 'Male') stats.male++;
    else stats.unknown++;
    stats.total++;
  }
  if (stats.total > 0) {
    stats.femalePercent = Math.round((stats.female / stats.total) * 100);
    stats.malePercent = Math.round((stats.male / stats.total) * 100);
  }
  return stats;
}
function adminStats(db) {
  const activeTickets = db.tickets.filter(t => t.status !== 'void');
  const approvedAttendees = activeTickets.map(t => ({ gender: t.gender }));
  const pendingAttendees = db.orders
    .filter(o => o.status === 'pending_admin_approval')
    .flatMap(o => o.attendees || []);
  return {
    approvedCount: activeTickets.length,
    remaining: Math.max(0, CAPACITY - soldOrPendingCount(db)),
    approvedGender: genderStatsFromAttendees(approvedAttendees),
    pendingGender: genderStatsFromAttendees(pendingAttendees)
  };
}
function adminPasswordAllowed(password) {
  const raw = String(password || '');
  const list = (process.env.ADMIN_PASSWORDS || process.env.ADMIN_PASSWORD || 'admin123')
    .split(',').map(p => p.trim()).filter(Boolean);
  return list.includes(raw);
}
async function makeUniqueTicketId(db) {
  let ticketId;
  do { ticketId = `ASILE-${id(10)}`; } while (db.tickets.some(t => t.id === ticketId));
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

async function sendMail({ to, subject, html }) {
  if (!to) return;
  if (!process.env.SMTP_HOST) { console.log('EMAIL NOT SENT - configure SMTP in .env:', subject, html); return; }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, html });
}
async function markOrderPendingApproval(order, paymentIntentId) {
  if (!order || order.status === 'pending_admin_approval') return false;
  order.status = 'pending_admin_approval';
  order.paymentIntentId = paymentIntentId || order.paymentIntentId;
  const names = (order.attendees || []).map(a => `<li>${a.name} — DOB: ${a.dateOfBirth} — Gender: ${a.gender || 'Not specified'} — Must match ID, dress code ${DRESS_CODE}</li>`).join('');
  await sendMail({ to: process.env.ADMIN_EMAIL, subject: `Approve tickets: ${order.buyerName}`, html: `<p>${order.buyerName} requested ${order.qty} ticket(s) for ${EVENT_NAME}.</p><ul>${names}</ul><p><b>Event:</b> ${EVENT_DATE}, ${EVENT_TIME}, ${EVENT_LOCATION}</p><p><b>Price:</b> ${money(TICKET_PRICE)} per ticket. <b>Dress code:</b> ${DRESS_CODE}. <b>Age:</b> ${MIN_AGE}+. <b>Bar:</b> ${BAR_PARTNER}. <b>Sponsor:</b> ${SPONSOR_NAME}. <b>Included:</b> free Pica Pic Photo Booth picture.</p><p><a href="${BASE_URL}/admin/orders/${order.id}">Approve or deny this order</a></p>` });
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
function ticketEmailHtml(ticket) {
  return `<div style="border:1px solid #ddd;border-radius:16px;padding:16px;margin:12px 0;font-family:Arial,sans-serif">
    <h2>${COMPANY_NAME} presents ${EVENT_NAME}</h2>
    <p><b>Name:</b> ${ticket.attendeeName}</p>
    <p><b>Date of birth:</b> ${ticket.dateOfBirth}</p>
    <p><b>Gender:</b> ${ticket.gender || 'Not specified'}</p>
    <p><b>Ticket ID:</b> ${ticket.id}</p>
    <p><b>Date:</b> ${EVENT_DATE}</p>
    <p><b>Time:</b> ${EVENT_TIME}</p>
    <p><b>Location:</b> ${EVENT_LOCATION}</p>
    <p><b>Price:</b> ${money(TICKET_PRICE)}</p>
    <p><b>Payment:</b> Apple Pay, Google Pay, Visa/card payments through ${PAYMENT_PROVIDER_LABEL}.</p>
    <p><b>Age:</b> ${MIN_AGE}+ only</p>
    <p><b>Dress code:</b> ${DRESS_CODE}</p>
    <p><b>Theme:</b> ${EVENT_THEME}</p>
    <p><b>Bar experience:</b> ${BAR_PARTNER}</p>
    <p><b>Event sponsor:</b> ${SPONSOR_NAME}</p>
    <p><b>Included:</b> One free picture at ${PHOTO_BOOTH_PARTNER}.</p>
    <img src="${BASE_URL}${SPONSOR_LOGO_URL}" width="170" alt="${SPONSOR_NAME} sponsor logo" style="display:block;margin:12px 0;border-radius:10px">
    <img src="${ticket.qrDataUrl}" width="180" alt="QR code"> 
  </div>`;
}

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, service: 'asile-ticket-site' }));

app.get('/', async (req, res) => {
  res.render('home', { ...eventInfo, money });
});

app.post('/reserve', async (req, res) => {
  const db = await readDb();
  const buyerName = cleanName(req.body.buyerName);
  const buyerEmail = String(req.body.buyerEmail || '').trim();
  const attendeeFirstNames = asArray(req.body.attendeeFirstName).map(cleanName);
  const attendeeLastNames = asArray(req.body.attendeeLastName).map(cleanName);
  const legacyNames = asArray(req.body.attendeeName).map(cleanName);
  const attendeeDobs = asArray(req.body.attendeeDob).map(v => String(v || '').trim());
  const attendeeGenders = asArray(req.body.attendeeGender).map(normalizeGender);
  const attendeeNames = legacyNames.length ? legacyNames : attendeeFirstNames.map((first, i) => combineName(first, attendeeLastNames[i]));
  const qty = Math.max(1, Math.min(10, Number(req.body.quantity || attendeeNames.length || 1)));
  if (!buyerName || !buyerEmail) return res.status(400).render('message', { title: 'Missing information', message: 'Buyer name and email are required.' });
  if (attendeeNames.length !== qty || attendeeDobs.length !== qty || attendeeGenders.length !== qty || attendeeNames.some(n => !n) || (!legacyNames.length && (attendeeFirstNames.length !== qty || attendeeLastNames.length !== qty || attendeeFirstNames.some(n => !n) || attendeeLastNames.some(n => !n))) || attendeeDobs.some(d => !d) || attendeeGenders.some(g => !g)) return res.status(400).render('message', { title: 'Missing ticket forms', message: 'Each ticket needs a separate first name, last name, date of birth, and gender.' });
  if (attendeeDobs.some(d => !isOldEnough(d))) return res.status(400).render('message', { title: 'Age requirement', message: `Every attendee must enter a valid date of birth as DD/MM/YYYY and be ${MIN_AGE}+ by ${EVENT_DATE}.` });
  const keys = attendeeNames.map(nameKey);
  if (new Set(keys).size !== keys.length) return res.status(400).render('message', { title: 'Duplicate name', message: 'The same attendee name cannot be used twice in one order.' });
  const duplicate = keys.find(k => usedNameKeys(db).has(k));
  if (duplicate) return res.status(400).render('message', { title: 'Duplicate name', message: 'One of these attendee names has already been used for another ticket.' });
  if (soldOrPendingCount(db) + qty > CAPACITY) return res.status(400).render('message', { title: 'Sold out', message: 'This order goes over the event capacity.' });

  const attendees = attendeeNames.map((name, i) => ({ firstName: attendeeFirstNames[i] || '', lastName: attendeeLastNames[i] || '', name, dateOfBirth: parseDobInput(attendeeDobs[i]).display, gender: attendeeGenders[i] }));
  const orderId = id(14);
  const order = { id: orderId, buyerName, buyerEmail, qty, attendees, amount: TICKET_PRICE * qty, paymentMethods: PAYMENT_METHODS, paymentProvider: PAYMENT_PROVIDER_LABEL, status: 'checkout_started', createdAt: new Date().toISOString() };
  db.orders.push(order); await writeDb(db);
  if (!stripe) {
    order.status = 'payment_error';
    order.paymentError = 'Missing STRIPE_SECRET_KEY';
    await writeDb(db);
    return res.status(503).render('message', { title: 'Stripe setup needed', message: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY in DigitalOcean App Platform environment variables before accepting payments.' });
  }
  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      // The current implementation uses Stripe Checkout as the payment gateway template.
      // Apple Pay / Google Pay require HTTPS, wallet setup, and supported customer device/browser.
      payment_method_types: ['card'],
      customer_email: buyerEmail,
      client_reference_id: orderId,
      line_items: [{ price_data: { currency: CURRENCY, product_data: { name: `${EVENT_NAME} ticket`, description: `${DRESS_CODE} dress code · ${MIN_AGE}+ · Free Pica Pic photo · Sponsor: ${SPONSOR_NAME}` }, unit_amount: TICKET_PRICE }, quantity: qty }],
      payment_intent_data: { capture_method: 'manual', metadata: { orderId, eventName: EVENT_NAME, companyName: COMPANY_NAME } },
      success_url: `${BASE_URL}/success?order=${orderId}`,
      cancel_url: `${BASE_URL}/cancel?order=${orderId}`
    });
    order.stripeSessionId = checkoutSession.id; order.status = 'awaiting_payment_authorization'; await writeDb(db);
    return res.redirect(303, checkoutSession.url);
  } catch (err) {
    order.status = 'payment_error'; order.paymentError = err.message; await writeDb(db);
    return res.status(503).render('message', { title: 'Payment setup needed', message: 'The reservation form works, but Stripe payment keys must be configured before real checkout can open.' });
  }
});

app.get('/success', (req, res) => res.render('message', { title: 'Reservation received', message: `Your payment is authorized. Your ${EVENT_NAME} ticket will be sent only after admin approval.` }));
app.get('/cancel', async (req, res) => { const db = await readDb(); const order = db.orders.find(o => o.id === req.query.order); if (order) { order.status = 'cancelled'; await writeDb(db); } res.render('message', { title: 'Checkout cancelled', message: 'No ticket was reserved.' }); });

app.post('/webhook', async (req, res) => {
  let event = req.body;
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    if (!stripe) return res.status(503).send('Stripe is not configured.');
    try { event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook error: ${err.message}`); }
  }
  const db = await readDb();
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const order = db.orders.find(o => o.id === s.client_reference_id);
    if (order) {
      await markOrderPendingApproval(order, s.payment_intent);
      await writeDb(db);
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
app.get('/admin', requireAdmin, async (req, res) => { const db = await readDb(); res.render('admin', { orders: db.orders, tickets: db.tickets, scanHistory: db.scanHistory || [], stats: adminStats(db), ...eventInfo, money, usePostgres: usePostgres() }); });
app.get('/admin/orders/:id', requireAdmin, async (req, res) => {
  const db = await readDb();
  const order = db.orders.find(o => o.id === req.params.id);
  try {
    if (await syncOrderFromStripe(order)) await writeDb(db);
  } catch (err) {
    console.error('Stripe order sync failed:', err.message);
  }
  res.render('order', { order, tickets: db.tickets.filter(t => t.orderId === req.params.id), ...eventInfo, money });
});

app.post('/admin/orders/:id/approve', requireAdmin, async (req, res) => {
  const db = await readDb(); const order = db.orders.find(o => o.id === req.params.id);
  if (!order || order.status !== 'pending_admin_approval') return res.status(400).send('Order is not pending approval.');
  if (!stripe) return res.status(503).render('message', { title: 'Stripe setup needed', message: 'STRIPE_SECRET_KEY is missing on the server.' });
  try { await stripe.paymentIntents.capture(order.paymentIntentId); }
  catch (err) { return res.status(502).render('message', { title: 'Payment capture failed', message: err.message }); }
  order.status = 'approved_captured'; order.approvedAt = new Date().toISOString();
  const newTickets = [];
  for (const attendee of order.attendees) {
    const ticketId = await makeUniqueTicketId(db);
    const verifyUrl = `${BASE_URL}/admin/scan?ticket=${ticketId}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl);
    const ticket = { id: ticketId, orderId: order.id, attendeeFirstName: attendee.firstName || '', attendeeLastName: attendee.lastName || '', attendeeName: attendee.name, dateOfBirth: attendee.dateOfBirth, gender: attendee.gender, buyerName: order.buyerName, buyerEmail: order.buyerEmail, eventName: EVENT_NAME, eventDate: EVENT_DATE, eventTime: EVENT_TIME, location: EVENT_LOCATION, dressCode: DRESS_CODE, age: `${MIN_AGE}+`, price: money(TICKET_PRICE), barPartner: BAR_PARTNER, photoBoothPartner: PHOTO_BOOTH_PARTNER, sponsorName: SPONSOR_NAME, sponsorLogoUrl: SPONSOR_LOGO_URL, status: 'valid', qrDataUrl, createdAt: new Date().toISOString() };
    db.tickets.push(ticket); newTickets.push(ticket);
  }
  await writeDb(db);
  const ticketHtml = newTickets.map(ticketEmailHtml).join('');
  await sendMail({ to: order.buyerEmail, subject: `Your ${EVENT_NAME} ticket confirmation`, html: `<p>Your ASIL'E reservation is approved. Bring your QR ticket and an ID that matches the ticket name. Every guest must wear the all-white dress code.</p><p><b>Date:</b> ${EVENT_DATE}. <b>Time:</b> ${EVENT_TIME}. <b>Location:</b> ${EVENT_LOCATION}.</p><p><b>Dress code:</b> ${DRESS_CODE}. <b>Age:</b> ${MIN_AGE}+ only.</p><p><b>Bar experience:</b> ${BAR_PARTNER}. <b>Event sponsor:</b> ${SPONSOR_NAME}. <b>Included:</b> one free picture at ${PHOTO_BOOTH_PARTNER}.</p><p><b>Paid through:</b> Apple Pay, Google Pay, Visa/card payments through ${PAYMENT_PROVIDER_LABEL}, depending on the payment method selected at checkout.</p>${ticketHtml}` });
  res.redirect(`/admin/orders/${order.id}`);
});

app.post('/admin/orders/:id/deny', requireAdmin, async (req, res) => {
  const db = await readDb(); const order = db.orders.find(o => o.id === req.params.id);
  if (!order || order.status !== 'pending_admin_approval') return res.status(400).send('Order is not pending approval.');
  if (!stripe) return res.status(503).render('message', { title: 'Stripe setup needed', message: 'STRIPE_SECRET_KEY is missing on the server.' });
  try { await stripe.paymentIntents.cancel(order.paymentIntentId); }
  catch (err) { return res.status(502).render('message', { title: 'Payment release failed', message: err.message }); }
  order.status = 'denied_released'; order.deniedAt = new Date().toISOString(); await writeDb(db);
  await sendMail({ to: order.buyerEmail, subject: `${EVENT_NAME} reservation not approved`, html: `<p>Your reservation was not approved. Your payment authorization has been cancelled/released.</p>` });
  res.redirect(`/admin/orders/${order.id}`);
});

app.get('/admin/scanner', requireAdmin, (req, res) => res.render('scanner')); // Camera scanning requires HTTPS on phones, except localhost.
app.get('/admin/scan', requireAdmin, async (req, res) => { const db = await readDb(); const ticket = db.tickets.find(t => t.id === req.query.ticket); res.render('scan-result', { ticket, ...eventInfo }); });
app.post('/admin/tickets/:id/check-in', requireAdmin, async (req, res) => {
  try {
    await safeCheckIn(req.params.id, req.session.adminName || 'Admin');
    res.redirect(`/admin/scan?ticket=${encodeURIComponent(req.params.id)}`);
  } catch (err) {
    res.status(500).render('message', { title: 'Check-in error', message: 'The ticket could not be checked in. Please try again.' });
  }
});

initDb().then(() => app.listen(PORT, () => console.log(`Running on ${BASE_URL}`))).catch(err => {
  console.error('Database startup failed:', err);
  process.exit(1);
});
