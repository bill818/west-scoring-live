/**
 * WEST Scoring Live — Worker 2.0
 * Handles live class data and UDP events from west-watcher.js
 * Stores in KV (live) and D1 (archival)
 *
 * Bindings required:
 *   WEST_LIVE     — KV namespace
 *   WEST_DB       — D1 database (west-scoring)
 *   WEST_AUTH_KEY — Secret
 *
 * ENDPOINTS:
 *   POST /postClassData        — watcher posts .cls standings on every change
 *   POST /postUdpEvent         — watcher posts UDP events
 *   POST /heartbeat            — watcher alive signal every 60s
 *   GET  /getLiveClass         — website polls for live class + event data
 *   GET  /ping                 — health check
 *   GET  /admin/shows          — list all shows in D1
 *   GET  /admin/showData       — full data for a show
 *   DELETE /admin/clearShow    — delete all D1 data for a show
 *   DELETE /admin/clearLive    — clear KV live keys for a ring
 */

const AUTH_KEY_NAME = 'X-West-Key';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-West-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

function isAuthed(request, env) {
  const key = request.headers.get(AUTH_KEY_NAME);
  return key && key === env.WEST_AUTH_KEY;
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (method === 'GET' && path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    // ── POST /postClassData ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/postClassData') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');
      const key = `live:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 7200 });
      ctx.waitUntil(writeToD1(env, body, slug, ring));
      console.log(`[postClassData] ${key} — ${body.competed}/${body.numEntries} competed`);
      return json({ ok: true, key });
    }

    // ── POST /postUdpEvent ────────────────────────────────────────────────────
    if (method === 'POST' && path === '/postUdpEvent') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const slug = url.searchParams.get('slug') || body.slug || 'unknown';
      const ring = url.searchParams.get('ring') || body.ring || '1';
      const key = `event:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 300 });
      console.log(`[postUdpEvent] ${key} — ${body.event} #${body.entry}`);
      return json({ ok: true, key });
    }

    // ── POST /heartbeat ───────────────────────────────────────────────────────
    if (method === 'POST' && path === '/heartbeat') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { body = {}; }
      const slug = url.searchParams.get('slug') || body.slug || 'unknown';
      const ring = url.searchParams.get('ring') || body.ring || '1';
      const payload = { ts: new Date().toISOString(), slug, ring, version: body.version || '2.0' };
      const key = `heartbeat:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(payload), { expirationTtl: 120 });
      // Update show status to active when watcher checks in
      ctx.waitUntil(activateShow(env, slug));
      console.log(`[heartbeat] ${key}`);
      return json({ ok: true });
    }

    // ── GET /getLiveClass ─────────────────────────────────────────────────────
    if (method === 'GET' && path === '/getLiveClass') {
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || '1';
      if (!slug) return err('Missing slug');
      const [classRaw, eventRaw, heartbeatRaw] = await Promise.all([
        env.WEST_LIVE.get(`live:${slug}:${ring}`),
        env.WEST_LIVE.get(`event:${slug}:${ring}`),
        env.WEST_LIVE.get(`heartbeat:${slug}:${ring}`),
      ]);
      const classData   = classRaw     ? JSON.parse(classRaw)     : null;
      const latestEvent = eventRaw     ? JSON.parse(eventRaw)     : null;
      const heartbeat   = heartbeatRaw ? JSON.parse(heartbeatRaw) : null;
      return json({
        ok: true, classData, latestEvent,
        watcherAlive: !!heartbeat,
        heartbeatTs: heartbeat?.ts || null,
        ts: new Date().toISOString(),
      });
    }

    // ── GET /admin/shows ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/shows') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const year   = url.searchParams.get('year') || null;
      const status = url.searchParams.get('status') || null;
      let sql    = 'SELECT * FROM shows';
      let params = [];
      let where  = [];
      if (year)   { where.push('year = ?');   params.push(year); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      try {
        const result = await env.WEST_DB.prepare(sql).bind(...params).all();
        return json({ ok: true, shows: result.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /admin/showData ───────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/showData') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare('SELECT * FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, show: null, classes: [] });
        const classes = await env.WEST_DB.prepare(
          'SELECT * FROM classes WHERE show_id = ? ORDER BY CAST(class_num AS INTEGER) ASC'
        ).bind(show.id).all();
        return json({ ok: true, show, classes: classes.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearShow ───────────────────────────────────────────────────
    // Cascade delete — removes rings, classes, entries, results automatically
    if (method === 'DELETE' && path === '/admin/clearShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        await env.WEST_DB.prepare('PRAGMA foreign_keys = ON').run();
        const result = await env.WEST_DB.prepare('DELETE FROM shows WHERE slug = ?').bind(slug).run();
        console.log(`[admin] Cleared show: ${slug}`);
        return json({ ok: true, message: `Show ${slug} cleared`, changes: result.meta.changes });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearAll ────────────────────────────────────────────────
    // Nuclear option — wipes entire database. Use for test data cleanup only.
    if (method === 'DELETE' && path === '/admin/clearAll') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        await env.WEST_DB.prepare('PRAGMA foreign_keys = ON').run();
        await env.WEST_DB.prepare('DELETE FROM shows').run();
        console.log('[admin] Cleared all data');
        return json({ ok: true, message: 'All data cleared from D1' });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearLive ───────────────────────────────────────────────
    if (method === 'DELETE' && path === '/admin/clearLive') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || '1';
      if (!slug) return err('Missing slug');
      await Promise.all([
        env.WEST_LIVE.delete(`live:${slug}:${ring}`),
        env.WEST_LIVE.delete(`event:${slug}:${ring}`),
        env.WEST_LIVE.delete(`heartbeat:${slug}:${ring}`),
      ]);
      console.log(`[admin] Cleared live KV: ${slug}:${ring}`);
      return json({ ok: true, message: `Live data cleared for ${slug} ring ${ring}` });
    }

    return err('Not found', 404);
  }
};

// ── ACTIVATE SHOW ─────────────────────────────────────────────────────────────
// Called on heartbeat — marks show as active if it exists and is pending
async function activateShow(env, slug) {
  try {
    await env.WEST_DB.prepare(`
      UPDATE shows SET status = 'active', updated_at = datetime('now')
      WHERE slug = ? AND status = 'pending'
    `).bind(slug).run();
  } catch(e) {
    console.error(`[activateShow ERROR] ${e.message}`);
  }
}

// ── D1 WRITE ──────────────────────────────────────────────────────────────────
// Called via ctx.waitUntil — runs after response sent, doesn't slow watcher
// All upserts use ON CONFLICT DO UPDATE to keep data fresh
async function writeToD1(env, body, slug, ring) {
  try {
    const year = new Date().getFullYear();
    const now  = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Upsert show — create if new, update name if changed
    await env.WEST_DB.prepare(`
      INSERT INTO shows (slug, year, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
      ON CONFLICT(slug) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(slug, year, now, now).run();

    const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
    if (!show) return;

    // Upsert ring
    await env.WEST_DB.prepare(`
      INSERT INTO rings (show_id, ring_num, status) VALUES (?, ?, 'active')
      ON CONFLICT(show_id, ring_num) DO UPDATE SET status = 'active'
    `).bind(show.id, ring).run();

    // Upsert class — update name/type if changed in cls file
    const classNum = (body.filename || '').replace('.cls', '');
    await env.WEST_DB.prepare(`
      INSERT INTO classes (show_id, ring, class_num, class_name, class_type, scoring_method, is_fei, sponsor, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(show_id, ring, class_num) DO UPDATE SET
        class_name     = excluded.class_name,
        class_type     = excluded.class_type,
        scoring_method = excluded.scoring_method,
        is_fei         = excluded.is_fei,
        sponsor        = excluded.sponsor,
        status         = 'active',
        updated_at     = excluded.updated_at
    `).bind(
      show.id, ring, classNum,
      body.className || '', body.classType || '',
      body.scoringMethod || '', body.isFEI ? 1 : 0,
      body.sponsor || '', now, now
    ).run();

    const cls = await env.WEST_DB.prepare(
      'SELECT id FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
    ).bind(show.id, ring, classNum).first();
    if (!cls) return;

    const isJumper = body.classType === 'J' || body.classType === 'T';

    for (const e of (body.entries || [])) {
      if (!e.hasGone) continue;

      // Upsert entry — update horse/rider name if changed in cls
      await env.WEST_DB.prepare(`
        INSERT INTO entries (class_id, entry_num, horse, rider, owner, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_id, entry_num) DO UPDATE SET
          horse = excluded.horse,
          rider = excluded.rider,
          owner = excluded.owner
      `).bind(cls.id, e.entryNum, e.horse || '', e.rider || '', e.owner || '', now).run();

      const entry = await env.WEST_DB.prepare(
        'SELECT id FROM entries WHERE class_id = ? AND entry_num = ?'
      ).bind(cls.id, e.entryNum).first();
      if (!entry) continue;

      // Upsert R1 result — update if changed
      if (isJumper && e.r1Time) {
        await env.WEST_DB.prepare(`
          INSERT INTO results (entry_id, class_id, round, time, jump_faults, total, place, status_code, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_id, round) DO UPDATE SET
            time        = excluded.time,
            jump_faults = excluded.jump_faults,
            total       = excluded.total,
            place       = excluded.place,
            status_code = excluded.status_code,
            updated_at  = excluded.updated_at
        `).bind(entry.id, cls.id, e.r1Time || '', e.r1JumpFaults || '0', e.r1Total || '', e.r1Place || '', e.statusCode || '', now, now).run();
      }

      // Upsert R2/JO result
      if (isJumper && e.r2Time) {
        await env.WEST_DB.prepare(`
          INSERT INTO results (entry_id, class_id, round, time, jump_faults, total, place, status_code, created_at, updated_at)
          VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_id, round) DO UPDATE SET
            time        = excluded.time,
            jump_faults = excluded.jump_faults,
            total       = excluded.total,
            place       = excluded.place,
            status_code = excluded.status_code,
            updated_at  = excluded.updated_at
        `).bind(entry.id, cls.id, e.r2Time || '', e.r2JumpFaults || '0', e.r2Total || '', e.r2Place || '', e.statusCode || '', now, now).run();
      }

      // Hunter result
      if (!isJumper && e.score) {
        await env.WEST_DB.prepare(`
          INSERT INTO results (entry_id, class_id, round, time, total, place, status_code, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_id, round) DO UPDATE SET
            time        = excluded.time,
            total       = excluded.total,
            place       = excluded.place,
            status_code = excluded.status_code,
            updated_at  = excluded.updated_at
        `).bind(entry.id, cls.id, e.score || '', e.total || e.score || '', e.place || '', e.statusCode || '', now, now).run();
      }
    }

    console.log(`[D1] Written: ${slug}:${ring} class ${classNum}`);
  } catch(e) {
    console.error(`[D1 ERROR] ${e.message}`);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function extractSlugRing(body, url) {
  let slug = url.searchParams.get('slug');
  let ring = url.searchParams.get('ring');
  if (!slug) slug = body.slug || null;
  if (!ring) ring = body.ring || (body.liveState && body.liveState.ring) || '1';
  return { slug, ring };
}
