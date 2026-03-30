/**
 * WEST Scoring Live — Worker v2.2
 * Handles live class data and UDP events from west-watcher.js
 * Stores in KV (live) and D1 (archival)
 *
 * Bindings required:
 *   WEST_LIVE     — KV namespace
 *   WEST_DB       — D1 database (west-scoring)
 *   WEST_AUTH_KEY — Secret
 *
 * ENDPOINTS:
 *   POST /postClassData           — watcher posts .cls standings on every change
 *   POST /postUdpEvent            — watcher posts UDP events
 *   POST /postClassEvent          — watcher posts CLASS_SELECTED / CLASS_COMPLETE
 *   POST /heartbeat               — watcher alive signal every 60s
 *   GET  /getLiveClass            — website polls for live class + event data
 *   GET  /getClasses              — website gets all classes for a show
 *   GET  /getResults              — website gets full results for a class
 *   GET  /ping                    — health check
 *   GET  /admin/shows             — list all shows in D1
 *   GET  /admin/showData          — full data for a show
 *   POST /admin/createShow        — create a new show
 *   POST /admin/updateShow        — update show fields
 *   POST /admin/completeClass     — mark a class complete
 *   DELETE /admin/clearShow       — delete all D1 data for a show
 *   DELETE /admin/clearAll        — wipe entire database
 *   DELETE /admin/clearLive       — clear KV live keys for a ring
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

    // ── GET /ping ─────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString(), version: '2.2' });
    }

    // ── POST /postClassData ───────────────────────────────────────────────────
    // Watcher posts on every .cls file change — fire and forget from watcher
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
      console.log(`[postClassData] ${key} — class ${(body.filename||'').replace('.cls','')} ${body.classType}`);
      return json({ ok: true, key });
    }

    // ── POST /postUdpEvent ────────────────────────────────────────────────────
    // Watcher posts UDP events (INTRO, RIDE_START, FINISH, FAULT etc)
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

    // ── POST /postClassEvent ──────────────────────────────────────────────────
    // Watcher posts CLASS_SELECTED (1x Ctrl+A) and CLASS_COMPLETE (3x Ctrl+A)
    if (method === 'POST' && path === '/postClassEvent') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');

      const { event, classNum, className } = body;

      if (event === 'CLASS_SELECTED') {
        // Store selected class in KV — website polls this to know which class is active
        const key = `selected:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          classNum, className, ts: new Date().toISOString()
        }), { expirationTtl: 7200 });
        console.log(`[CLASS_SELECTED] ${slug}:${ring} — class ${classNum} ${className}`);
        return json({ ok: true, event: 'CLASS_SELECTED', classNum });
      }

      if (event === 'CLASS_COMPLETE') {
        // Mark class complete in D1 and update KV
        ctx.waitUntil(markClassComplete(env, slug, ring, classNum, className));
        console.log(`[CLASS_COMPLETE] ${slug}:${ring} — class ${classNum} ${className}`);
        return json({ ok: true, event: 'CLASS_COMPLETE', classNum });
      }

      return err('Unknown event type');
    }

    // ── POST /heartbeat ───────────────────────────────────────────────────────
    // Watcher posts every 60s to signal it is alive
    if (method === 'POST' && path === '/heartbeat') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { body = {}; }
      const slug = url.searchParams.get('slug') || body.slug || 'unknown';
      const ring = url.searchParams.get('ring') || body.ring || '1';
      const payload = {
        ts: new Date().toISOString(),
        slug, ring,
        version: body.version || '2.0',
        scoreboardPort: body.scoreboardPort || '',
      };
      const key = `heartbeat:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(payload), { expirationTtl: 120 });
      ctx.waitUntil(activateShow(env, slug));
      console.log(`[heartbeat] ${key}`);
      return json({ ok: true });
    }

    // ── GET /getLiveClass ─────────────────────────────────────────────────────
    // Website polls to get current live class state + latest UDP event
    if (method === 'GET' && path === '/getLiveClass') {
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || '1';
      if (!slug) return err('Missing slug');
      const [classRaw, eventRaw, heartbeatRaw, selectedRaw] = await Promise.all([
        env.WEST_LIVE.get(`live:${slug}:${ring}`),
        env.WEST_LIVE.get(`event:${slug}:${ring}`),
        env.WEST_LIVE.get(`heartbeat:${slug}:${ring}`),
        env.WEST_LIVE.get(`selected:${slug}:${ring}`),
      ]);
      return json({
        ok:           true,
        classData:    classRaw     ? JSON.parse(classRaw)     : null,
        latestEvent:  eventRaw     ? JSON.parse(eventRaw)     : null,
        selected:     selectedRaw  ? JSON.parse(selectedRaw)  : null,
        watcherAlive: !!heartbeatRaw,
        heartbeatTs:  heartbeatRaw ? JSON.parse(heartbeatRaw).ts : null,
        ts:           new Date().toISOString(),
      });
    }

    // ── GET /getClasses ───────────────────────────────────────────────────────
    // Website gets all classes for a show with status
    if (method === 'GET' && path === '/getClasses') {
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || null;
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, classes: [] });

        let sql = `
          SELECT c.*, COUNT(e.id) as entry_count,
                 SUM(CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END) as competed_count
          FROM classes c
          LEFT JOIN entries e ON e.class_id = c.id
          WHERE c.show_id = ?
        `;
        const params = [show.id];
        if (ring) { sql += ' AND c.ring = ?'; params.push(ring); }
        sql += ' GROUP BY c.id ORDER BY CAST(c.class_num AS INTEGER) ASC';

        const result = await env.WEST_DB.prepare(sql).bind(...params).all();
        return json({ ok: true, classes: result.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getResults ───────────────────────────────────────────────────────
    // Website gets full results for a specific class
    if (method === 'GET' && path === '/getResults') {
      const slug     = url.searchParams.get('slug');
      const classNum = url.searchParams.get('classNum');
      const ring     = url.searchParams.get('ring') || '1';
      if (!slug || !classNum) return err('Missing slug or classNum');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, class: null, entries: [] });

        const cls = await env.WEST_DB.prepare(
          'SELECT * FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
        ).bind(show.id, ring, classNum).first();
        if (!cls) return json({ ok: true, class: null, entries: [] });

        // Get all entries with their results
        const entries = await env.WEST_DB.prepare(`
          SELECT e.entry_num, e.horse, e.rider, e.owner,
                 r.round, r.time, r.jump_faults, r.time_faults,
                 r.total, r.place, r.status_code
          FROM entries e
          LEFT JOIN results r ON r.entry_id = e.id
          WHERE e.class_id = ?
          ORDER BY CAST(r.place AS INTEGER), e.entry_num, r.round
        `).bind(cls.id).all();

        return json({ ok: true, class: cls, entries: entries.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /admin/shows ──────────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/shows') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const year   = url.searchParams.get('year')   || null;
      const status = url.searchParams.get('status') || null;
      let sql = 'SELECT * FROM shows', params = [], where = [];
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
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, show: null, classes: [] });
        const classes = await env.WEST_DB.prepare(
          'SELECT * FROM classes WHERE show_id = ? ORDER BY CAST(class_num AS INTEGER) ASC'
        ).bind(show.id).all();
        return json({ ok: true, show, classes: classes.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/createShow ────────────────────────────────────────────────
    // Admin page creates a show before the watcher runs
    if (method === 'POST' && path === '/admin/createShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, name, venue, dates, location, rings_count, stats_eligible } = body;
      if (!slug) return err('Missing slug');
      const now  = new Date().toISOString().replace('T', ' ').split('.')[0];
      const year = new Date().getFullYear();
      try {
        await env.WEST_DB.prepare(`
          INSERT INTO shows (slug, name, venue, dates, location, year, rings_count,
                             stats_eligible, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            name           = excluded.name,
            venue          = excluded.venue,
            dates          = excluded.dates,
            location       = excluded.location,
            rings_count    = excluded.rings_count,
            stats_eligible = excluded.stats_eligible,
            updated_at     = excluded.updated_at
        `).bind(
          slug, name || '', venue || '', dates || '', location || '',
          year, rings_count || 1,
          stats_eligible !== false ? 1 : 0,
          now, now
        ).run();
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        console.log(`[admin] Created show: ${slug}`);
        return json({ ok: true, show });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/updateShow ────────────────────────────────────────────────
    // Admin page updates show fields (name, stats_eligible, status etc)
    if (method === 'POST' && path === '/admin/updateShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ...fields } = body;
      if (!slug) return err('Missing slug');
      const allowed = ['name','venue','dates','location','rings_count',
                       'stats_eligible','status','notes'];
      const sets = [], params = [];
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
      }
      if (!sets.length) return err('No valid fields to update');
      sets.push('updated_at = ?');
      params.push(new Date().toISOString().replace('T', ' ').split('.')[0]);
      params.push(slug);
      try {
        await env.WEST_DB.prepare(
          `UPDATE shows SET ${sets.join(', ')} WHERE slug = ?`
        ).bind(...params).run();
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        return json({ ok: true, show });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/completeClass ─────────────────────────────────────────────
    // Watcher posts on 3x Ctrl+A — marks class complete in D1
    if (method === 'POST' && path === '/admin/completeClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum, className } = body;
      if (!slug || !classNum) return err('Missing slug or classNum');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found');
        const now = new Date().toISOString().replace('T', ' ').split('.')[0];
        await env.WEST_DB.prepare(`
          UPDATE classes SET status = 'complete', updated_at = ?
          WHERE show_id = ? AND ring = ? AND class_num = ?
        `).bind(now, show.id, ring || '1', classNum).run();
        console.log(`[completeClass] ${slug}:${ring} class ${classNum}`);
        return json({ ok: true, classNum, status: 'complete' });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearShow ───────────────────────────────────────────────
    if (method === 'DELETE' && path === '/admin/clearShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        await env.WEST_DB.prepare('PRAGMA foreign_keys = ON').run();
        const result = await env.WEST_DB.prepare(
          'DELETE FROM shows WHERE slug = ?'
        ).bind(slug).run();
        console.log(`[admin] Cleared show: ${slug}`);
        return json({ ok: true, message: `Show ${slug} cleared`, changes: result.meta.changes });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/clearAll ────────────────────────────────────────────────
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
        env.WEST_LIVE.delete(`selected:${slug}:${ring}`),
      ]);
      console.log(`[admin] Cleared live KV: ${slug}:${ring}`);
      return json({ ok: true, message: `Live data cleared for ${slug} ring ${ring}` });
    }

    return err('Not found', 404);
  }
};

// ── ACTIVATE SHOW ─────────────────────────────────────────────────────────────
// Called on heartbeat — flips status pending→active, updates name if set
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

// ── MARK CLASS COMPLETE ───────────────────────────────────────────────────────
// Called from /postClassEvent when CLASS_COMPLETE fires
async function markClassComplete(env, slug, ring, classNum, className) {
  try {
    const show = await env.WEST_DB.prepare(
      'SELECT id FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) return;
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'complete', updated_at = ?
      WHERE show_id = ? AND ring = ? AND class_num = ?
    `).bind(now, show.id, ring, classNum).run();
    console.log(`[markClassComplete] ${slug}:${ring} class ${classNum} — ${className}`);
  } catch(e) {
    console.error(`[markClassComplete ERROR] ${e.message}`);
  }
}

// ── D1 WRITE ──────────────────────────────────────────────────────────────────
// Called via ctx.waitUntil — runs after response is sent, never slows watcher
async function writeToD1(env, body, slug, ring) {
  try {
    const year = new Date().getFullYear();
    const now  = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Upsert show — create if new, preserve existing name/venue/dates if set
    await env.WEST_DB.prepare(`
      INSERT INTO shows (slug, year, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
      ON CONFLICT(slug) DO UPDATE SET updated_at = excluded.updated_at
    `).bind(slug, year, now, now).run();

    const show = await env.WEST_DB.prepare(
      'SELECT id FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) return;

    // Upsert ring
    await env.WEST_DB.prepare(`
      INSERT INTO rings (show_id, ring_num, status) VALUES (?, ?, 'active')
      ON CONFLICT(show_id, ring_num) DO UPDATE SET status = 'active'
    `).bind(show.id, ring).run();

    // Upsert class
    const classNum = (body.filename || '').replace('.cls', '');
    if (!classNum) return;

    await env.WEST_DB.prepare(`
      INSERT INTO classes (show_id, ring, class_num, class_name, class_type,
                           scoring_method, is_fei, sponsor, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(show_id, ring, class_num) DO UPDATE SET
        class_name     = excluded.class_name,
        class_type     = excluded.class_type,
        scoring_method = excluded.scoring_method,
        is_fei         = excluded.is_fei,
        sponsor        = excluded.sponsor,
        status         = CASE WHEN status = 'complete' THEN 'complete' ELSE 'active' END,
        updated_at     = excluded.updated_at
    `).bind(
      show.id, ring, classNum,
      body.className      || '',
      body.classType      || '',
      body.scoringMethod  || '',
      body.isFEI ? 1 : 0,
      body.sponsor        || '',
      now, now
    ).run();

    const cls = await env.WEST_DB.prepare(
      'SELECT id FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
    ).bind(show.id, ring, classNum).first();
    if (!cls) return;

    const isJumper = body.classType === 'J' || body.classType === 'T';

    for (const e of (body.entries || [])) {
      if (!e.hasGone) continue;

      // Upsert entry
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

      // ── JUMPER results ────────────────────────────────────────────────────
      // Watcher field names confirmed 2026-03-22 from live class 221
      if (isJumper && e.r1TotalTime) {
        await upsertResult(env, entry.id, cls.id, 1,
          e.r1TotalTime, e.r1JumpFaults, e.r1TimeFaults,
          e.r1TotalFaults, e.overallPlace, e.statusCode, now);
      }
      if (isJumper && e.r2TotalTime) {
        await upsertResult(env, entry.id, cls.id, 2,
          e.r2TotalTime, e.r2JumpFaults, e.r2TimeFaults,
          e.r2TotalFaults, e.overallPlace, e.statusCode, now);
      }
      if (isJumper && e.r3TotalTime) {
        await upsertResult(env, entry.id, cls.id, 3,
          e.r3TotalTime, e.r3JumpFaults, e.r3TimeFaults,
          e.r3TotalFaults, e.overallPlace, e.statusCode, now);
      }

      // ── HUNTER result ─────────────────────────────────────────────────────
      if (!isJumper && e.hasGone) {
        const score  = e.score    || '';
        const total  = e.combined || e.r1Total || e.score || '';
        const place  = e.place    || '';
        const status = e.statusCode || '';
        await env.WEST_DB.prepare(`
          INSERT INTO results (entry_id, class_id, round, time, total, place,
                               status_code, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entry_id, round) DO UPDATE SET
            time        = excluded.time,
            total       = excluded.total,
            place       = excluded.place,
            status_code = excluded.status_code,
            updated_at  = excluded.updated_at
        `).bind(entry.id, cls.id, score, total, place, status, now, now).run();
      }
    }

    console.log(`[D1] Written: ${slug}:${ring} class ${classNum} (${body.classType})`);
  } catch(e) {
    console.error(`[D1 ERROR] ${e.message}`);
  }
}

// ── UPSERT RESULT ─────────────────────────────────────────────────────────────
async function upsertResult(env, entryId, classId, round,
  time, jumpFaults, timeFaults, total, place, statusCode, now) {
  await env.WEST_DB.prepare(`
    INSERT INTO results (entry_id, class_id, round, time, jump_faults, time_faults,
                         total, place, status_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, round) DO UPDATE SET
      time        = excluded.time,
      jump_faults = excluded.jump_faults,
      time_faults = excluded.time_faults,
      total       = excluded.total,
      place       = excluded.place,
      status_code = excluded.status_code,
      updated_at  = excluded.updated_at
  `).bind(
    entryId, classId, round,
    time        || '',
    jumpFaults  || '0',
    timeFaults  || '0',
    total       || '',
    place       || '',
    statusCode  || '',
    now, now
  ).run();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function extractSlugRing(body, url) {
  let slug = url.searchParams.get('slug');
  let ring = url.searchParams.get('ring');
  if (!slug) slug = body.slug || null;
  if (!ring) ring = body.ring || '1';
  return { slug, ring };
}
