-- 028: udp_events table — landing zone for the Phase 3a engine→worker pipe.
--
-- Each row = one UDP event the engine batched and POSTed to /v3/postUdpEvent.
-- Channel A events are Ryegate scoreboard frames (frame number 0..16);
-- Channel B events are port-31000 focus signals (frame is null — meaningless
-- on that channel per UDP-PROTOCOL-REFERENCE.md).
--
-- Article 1: lens (jumper / hunter / equitation) is NOT stored here. UDP
-- doesn't carry classType. If a reader needs the lens, it joins to classes
-- via class_id (or to the .cls archive in R2). Tags are stored as raw JSON
-- so the meaning of any {N} stays scoped to the (channel, frame) pair.
--
-- Phase 3a stores every event from every batch. Phase 3b (DO + WS) is
-- where we'll apply the "events-only" filter to D1 (1Hz on-course noise
-- gets dropped; only state changes persist). For now the schema doesn't
-- distinguish — keep the bar low so we can observe real volume before
-- premature filtering.
--
-- Tied to Phase 3a Chunk 2 (worker endpoint).

CREATE TABLE IF NOT EXISTS udp_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     INTEGER,
  ring_num    INTEGER NOT NULL,
  class_id    TEXT,
  channel     TEXT NOT NULL CHECK (channel IN ('A', 'B')),
  frame       INTEGER,
  tags        TEXT NOT NULL DEFAULT '{}',
  engine_at   TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  batch_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_udp_events_ring_time
  ON udp_events(show_id, ring_num, engine_at);

CREATE INDEX IF NOT EXISTS idx_udp_events_received
  ON udp_events(received_at);
