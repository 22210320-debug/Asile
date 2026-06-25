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

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_attendee_name ON tickets(attendee_name);
CREATE INDEX IF NOT EXISTS idx_tickets_attendee_first_last ON tickets(attendee_first_name, attendee_last_name);
