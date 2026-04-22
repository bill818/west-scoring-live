-- Phase 2b: classes table — parsed .cls header data per class.
-- One row per class per ring. Unique on (show_id, ring_id, class_id).
--
-- class_id  = operator-facing identifier, same as the .cls filename without
--             the extension. Numeric ("1005") or with suffix ("48C").
-- class_type = H | J | T | U  — the Article 1 lens.
--              H = hunter, J = Farmtek jumper, T = TOD jumper,
--              U = unformatted (no lens committed — name only).
-- scoring_method = col[2] of header row for J/T. NULL for H and U.
-- class_mode = col[2] of header row for H (classMode 0-3). NULL for J/T/U.
-- parse_status = 'parsed' | 'unconfigured' | 'parse_error'
-- parse_notes = any parser observation (soft warnings, method code unknown,
--               etc). Not a hard failure — the row still exists.

CREATE TABLE IF NOT EXISTS classes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id        INTEGER NOT NULL REFERENCES shows(id),
  ring_id        INTEGER NOT NULL REFERENCES rings(id),
  class_id       TEXT    NOT NULL,
  class_name     TEXT,
  class_type     TEXT    NOT NULL,
  scoring_method INTEGER,
  class_mode     INTEGER,
  parse_status   TEXT    NOT NULL DEFAULT 'parsed',
  parse_notes    TEXT,
  r2_key         TEXT    NOT NULL,
  first_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  parsed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(show_id, ring_id, class_id)
);

CREATE INDEX IF NOT EXISTS idx_classes_ring_id  ON classes(ring_id);
CREATE INDEX IF NOT EXISTS idx_classes_class_type ON classes(class_type);
