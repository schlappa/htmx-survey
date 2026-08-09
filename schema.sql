-- D1 schema. Apply with:
--   npx wrangler d1 execute htmx-survey --local  --file=./schema.sql
--   npx wrangler d1 execute htmx-survey --remote --file=./schema.sql
--
-- The Node version grew this table through ALTER statements at boot. D1 has real
-- migrations, so the final shape is declared once here instead.
CREATE TABLE IF NOT EXISTS responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_at TEXT    NOT NULL,
  answers      TEXT    NOT NULL,
  comments     TEXT,
  ip           TEXT,
  public_ip    TEXT,
  latitude     REAL,
  longitude    REAL,
  location     TEXT,
  user_agent   TEXT,
  simulated    INTEGER NOT NULL DEFAULT 0
);

-- The results page always reads newest-first.
CREATE INDEX IF NOT EXISTS idx_responses_id_desc ON responses (id DESC);
