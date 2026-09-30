-- Private text-only support tickets. Existing account/business tables are untouched.
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_support_tickets_owner ON support_tickets(user_id,created_at,id);
CREATE INDEX idx_support_tickets_created ON support_tickets(created_at,id);
CREATE TABLE support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  is_staff INTEGER NOT NULL CHECK (is_staff IN (0,1)),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_support_messages_ticket ON support_ticket_messages(ticket_id,created_at,id);
