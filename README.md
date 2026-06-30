# ASIL'E Sunset House Party Ticket Website — DigitalOcean + Stripe Ready

Developer-ready Node/Express ticket reservation website for ASIL'E. This package is prepared for **DigitalOcean App Platform**, **PostgreSQL**, and **Stripe Checkout** for Apple Pay, Google Pay, Visa, and Mastercard.

## Event details already added
- Company: ASIL'E
- Event: Sunset House Party
- Date: July 24, 2026
- Time: 5:30 PM-11:00 PM
- Location: Cremisan, with pinned Google Maps link setting
- Price: 80 NIS per ticket
- Dress code: All White
- Age: 18+
- Capacity: 1000 guests, shown only in the admin dashboard
- Theme: House music and sunset party
- WhatsApp contact: +9720568576684
- Instagram: `https://www.instagram.com/events.asile?igsh=cXduejFvbHB4bjRo`
- Bar: Double Shake
- Sponsor: Carlsberg
- Included: one free picture at Pica Pic Photo Booth

## Features included
- Buyer reservation form
- Separate attendee first name, last name, date of birth, and gender for every ticket
- Easy DD/MM/YYYY date-of-birth entry with 18+ validation
- Client-side and server-side duplicate-name blocking
- Capacity control, hidden from buyers and visible only to admins
- Unpaid checkout attempts release held names/capacity after 30 minutes
- Stripe Checkout prepared for Apple Pay, Google Pay, Visa, Mastercard, refunds/cancellations, and manual payment capture
- Manual payment capture: buyer authorizes first, admin approves before capture
- Admin receives email before ticket is issued
- Admin approve/deny flow
- Denied orders cancel/release the payment authorization
- Unique ticket ID for every attendee, with collision checks
- Separate QR code per ticket, even when one buyer reserves multiple tickets
- Ticket email includes event date, time, location, price, age rule, all-white dress code, sponsor, and photo booth benefit
- Admin camera QR scanner and check-in flow
- Multiple admins can log in on different devices and scan tickets
- PostgreSQL database support for production, with local JSON fallback for development only
- Scan history table showing which admin scanned each ticket and the result
- Multi-admin-safe ticket check-in when PostgreSQL is enabled, preventing two admins from checking in the same QR at the same time
- Mobile-responsive public and admin pages
- Admin-only male/female ratio summary for approved and pending attendees
- Ticket status changes to used after check-in

## Important payment note
This project uses **Stripe** as the only payment gateway. Stripe Checkout is wired server-side with manual capture so the buyer can authorize payment first, then the admin approves before the charge is captured and tickets are issued.

Secret Stripe keys must stay only in DigitalOcean App Platform environment variables or a local `.env` file. Never place `sk_...` keys in frontend code, GitHub, HTML, or public ZIP files.

Apple Pay, Google Pay, Visa, and Mastercard are handled through Stripe Checkout after payment methods are enabled, the site is published on HTTPS, and the production domain is verified in Stripe if required.

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

Admin login: `/admin/login`.

Default local admin password is `admin1122` if `ADMIN_PASSWORD` is not set. Change it before publishing. For multiple admins, set `ADMIN_PASSWORDS` to comma-separated passwords or use bcrypt hashes with `ADMIN_PASSWORD_HASHES`.

## DigitalOcean deployment — App Platform

### 1. Put the project on GitHub
Unzip this package, create a GitHub repository, and push all files. Do not upload `node_modules`, `.env`, or `db.json`.

### 2. Update the DigitalOcean app spec
Edit `.do/app.yaml` before importing it:

- `github.repo` is set to `22210320-debug/Asile`.
- Keep `build_command: npm ci`.
- Keep `run_command: npm start`.
- Keep `http_port: 8080`.
- Keep the health check path as `/healthz`.
- Change `region` if you want a different DigitalOcean region.

The included spec creates one Node web service. Add your Supabase/PostgreSQL connection in DigitalOcean environment variables.

### 3. Create the app in DigitalOcean
In DigitalOcean:

1. Open **App Platform**.
2. Create a new app from your GitHub repository.
3. If prompted, use the included `.do/app.yaml` app spec.
4. Confirm the Node service.
5. Deploy the app.

Alternative manual setup:

- Resource type: Web Service
- Build command: `npm ci`
- Run command: `npm start`
- HTTP port: `8080`
- Health check path: `/healthz`
- Add your Supabase transaction pooler connection string as `DATABASE_URL`.

### 4. Add required DigitalOcean environment variables
Set these in App Platform -> Settings -> App-Level Environment Variables or the web service's environment variables:

```env
NODE_ENV=production
BASE_URL=https://your-app-name.ondigitalocean.app
DATABASE_URL=postgresql://postgres.your-project:your-password@aws-0-region.pooler.supabase.com:6543/postgres
DATABASE_SSL=true
SESSION_SECRET=generate_a_long_random_secret
STRIPE_SECRET_KEY=sk_test_or_sk_live_from_stripe_dashboard
STRIPE_WEBHOOK_SECRET=whsec_from_stripe_webhook
ADMIN_EMAIL=your_admin_email@example.com
ADMIN_PASSWORDS=admin1122
WHATSAPP_1=972568576684
INSTAGRAM_URL=https://www.instagram.com/events.asile?igsh=cXduejFvbHB4bjRo
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@example.com
SMTP_PASS=your_email_app_password
EMAIL_FROM=ASIL'E Tickets <your_email@example.com>
```

Do not put secret keys inside the code.

### 5. Stripe setup
1. In Stripe Dashboard, enable cards and wallets.
2. Add webhook endpoint: `https://your-domain.com/webhook`.
3. Send event: `checkout.session.completed`.
4. Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Test with Stripe test cards.
6. Before launch, switch to live mode and use live keys.
7. Confirm your payout bank account is set in Stripe Dashboard.

### 6. Phone and QR scanner notes
The buyer website and admin scanner are responsive. Camera scanning on phones requires HTTPS, which DigitalOcean App Platform provides automatically. Test the scanner on iPhone Safari and Android Chrome before launch.

## Files added for DigitalOcean
- `.do/app.yaml` — DigitalOcean App Platform spec
- `Procfile` — fallback web start command
- `.gitignore` — keeps `node_modules`, `.env`, and local db files out of GitHub
- `/healthz` route — App Platform health check

## Final pre-launch test checklist
- Reservation form on phone
- Duplicate name blocking
- Under-18 blocking
- Stripe test payment authorization
- Admin receives approval email
- Admin approve captures payment
- Admin deny cancels/releases authorization
- Buyer receives ticket email
- Each attendee receives unique ticket ID and unique QR
- QR camera scanner works on phones over HTTPS
- Same QR cannot be checked in twice
- Multiple admin passwords work
- Capacity is visible only in admin
- Male/female ratio appears only in admin
- Email sender does not go to spam
- Stripe live keys and webhook are set before selling real tickets

## Production warning
The local JSON fallback is only for development. Use PostgreSQL on DigitalOcean for the real event so data is not lost and multiple admins can scan safely.
