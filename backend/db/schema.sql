-- Neon Postgres (optional external database, used when DATABASE_URL is set).
-- Run once in the Neon SQL editor. Each record is a JSON document; the
-- expression indexes match the DynamoDB global secondary indexes.
CREATE TABLE IF NOT EXISTS tbx_documents (
  tbl      TEXT    NOT NULL,          -- Users | Listings | Requests | Notifications
  id       TEXT    NOT NULL,
  version  INTEGER NOT NULL,          -- optimistic locking
  data     JSONB   NOT NULL,
  PRIMARY KEY (tbl, id)
);

CREATE INDEX IF NOT EXISTS idx_users_email        ON tbx_documents ((data->>'email'))     WHERE tbl = 'Users';
CREATE INDEX IF NOT EXISTS idx_listings_seller    ON tbx_documents ((data->>'sellerId'))  WHERE tbl = 'Listings';
CREATE INDEX IF NOT EXISTS idx_listings_course    ON tbx_documents ((data->>'courseCode')) WHERE tbl = 'Listings';
CREATE INDEX IF NOT EXISTS idx_requests_listing   ON tbx_documents ((data->>'listingId')) WHERE tbl = 'Requests';
CREATE INDEX IF NOT EXISTS idx_requests_buyer     ON tbx_documents ((data->>'buyerId'))   WHERE tbl = 'Requests';
CREATE INDEX IF NOT EXISTS idx_requests_seller    ON tbx_documents ((data->>'sellerId'))  WHERE tbl = 'Requests';
CREATE INDEX IF NOT EXISTS idx_notifications_user ON tbx_documents ((data->>'userId'))    WHERE tbl = 'Notifications';
