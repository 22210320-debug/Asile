-- ASIL'E production database schema for PostgreSQL.
-- The app also creates these tables automatically on startup when DATABASE_URL is set.
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

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_attendee_name ON tickets(attendee_name);
CREATE INDEX IF NOT EXISTS idx_tickets_attendee_first_last ON tickets(attendee_first_name, attendee_last_name);
CREATE INDEX IF NOT EXISTS idx_waitlist_status_created_at ON waitlist_entries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_entries (email);
CREATE INDEX IF NOT EXISTS idx_waitlist_phone ON waitlist_entries (phone);

-- Customer and marketing tables. Existing ticket orders and waitlist records remain unchanged.
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
