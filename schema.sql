-- D1 schema for the multi-user form builder.
--
-- Apply with:
--   npx wrangler d1 execute htmx-survey --local  --file=./schema.sql
--   npx wrangler d1 execute htmx-survey --remote --file=./schema.sql
--
-- This REPLACES the single-survey schema. The old `responses` table stored
-- answers as a JSON blob keyed by "q1".."q5"; answers are now rows keyed by a
-- real question id, so old data cannot be carried across and the table is
-- dropped. Export first if you want to keep it.
DROP TABLE IF EXISTS answers;
DROP TABLE IF EXISTS responses;
DROP TABLE IF EXISTS questions;
DROP TABLE IF EXISTS sections;
DROP TABLE IF EXISTS forms;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  -- PBKDF2-SHA256. Format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>
  password_hash TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

-- Opaque session tokens. The cookie holds the token; nothing else is trusted.
CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE forms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Public URL is /f/<slug>. Unguessable so a link is the access control.
  slug            TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  -- The "Módulo: …" / "Docente: …" lines under the title. Free text, may be ''.
  subtitle        TEXT,
  objective       TEXT,
  instructions    TEXT,
  -- Scale labels as JSON, e.g. {"5":"Muy bueno", ..., "1":"Muy malo"}.
  scale           TEXT    NOT NULL,
  -- 1 renders columns 5→1 (the Univalle layout), 0 renders 1→5.
  scale_desc      INTEGER NOT NULL DEFAULT 1,
  -- Rating the lowest scale value forces a comment, mirroring the old rule.
  require_comment INTEGER NOT NULL DEFAULT 1,
  -- Anonymous forms record no IP, coordinates or user agent.
  track_metadata  INTEGER NOT NULL DEFAULT 0,
  is_open         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL
);
CREATE INDEX idx_forms_owner ON forms (owner_id);

CREATE TABLE sections (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id  INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  title    TEXT    NOT NULL,
  -- 'matrix' = Likert grid of questions; 'text' = a single free-text box.
  kind     TEXT    NOT NULL CHECK (kind IN ('matrix', 'text')),
  required INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL
);
CREATE INDEX idx_sections_form ON sections (form_id, position);

CREATE TABLE questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  position   INTEGER NOT NULL
);
CREATE INDEX idx_questions_section ON questions (section_id, position);

CREATE TABLE responses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id      INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  submitted_at TEXT    NOT NULL,
  -- All null when the form has track_metadata = 0.
  ip           TEXT,
  latitude     REAL,
  longitude    REAL,
  location     TEXT,
  user_agent   TEXT,
  simulated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_responses_form ON responses (form_id, id DESC);

-- One row per answered question. `rating` for matrix questions, `text` for
-- free-text sections; exactly one is set.
CREATE TABLE answers (
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  section_id  INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  rating      INTEGER,
  text        TEXT,
  PRIMARY KEY (response_id, section_id, question_id)
);
CREATE INDEX idx_answers_question ON answers (question_id);
