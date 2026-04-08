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

      const classNum = (body.filename || '').replace('.cls', '');

      // Check if show is locked (admin set to complete) — skip all writes
      const locked = await isShowLocked(env, slug);
      if (locked) {
        console.log(`[postClassData] ${slug} LOCKED — ignoring ${classNum}`);
        return json({ ok: true, classNum, locked: true });
      }

      // Write classData to per-class KV key — every active class gets its own live data
      const key = `live:${slug}:${ring}:${classNum}`;
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 7200 });

      // Pre-compute results — runs once here instead of on every viewer's phone.
      // Stored in KV for live polling, and written to D1 on CLASS_COMPLETE.
      const computed = computeClassResults(body);
      const resultsKey = `results:${slug}:${ring}:${classNum}`;
      await env.WEST_LIVE.put(resultsKey, JSON.stringify(computed), { expirationTtl: 7200 });

      // Active array managed by CLASS_SELECTED (Ctrl+A) and INTRO/ON_COURSE (UDP events)
      // .cls changes update data only — deliberate operator action puts a class live

      ctx.waitUntil(writeToD1(env, body, slug, ring));
      console.log(`[postClassData] ${key} — class ${classNum} ${body.classType} [computed]`);
      return json({ ok: true, classNum });
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
      if (await isShowLocked(env, slug)) return json({ ok: false, locked: true });
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

      // Reject all events if show is locked
      const locked = await isShowLocked(env, slug);
      if (locked) return json({ ok: false, locked: true });

      const { event, classNum, className } = body;

      if (event === 'INTRO') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          phase: 'INTRO', ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          ts: new Date().toISOString()
        }), { expirationTtl: 120 });
        // Track first horse of the day
        ctx.waitUntil(recordFirstHorse(env, slug, ring));
        // Auto-reinstate class to active array — horse entering the ring = class is live
        const selRaw = await env.WEST_LIVE.get(`selected:${slug}:${ring}`);
        if (selRaw) {
          const sel = JSON.parse(selRaw);
          const activeKey = `active:${slug}:${ring}`;
          const activeRaw = await env.WEST_LIVE.get(activeKey);
          let active = activeRaw ? JSON.parse(activeRaw) : [];
          const idx = active.findIndex(a => String(a.classNum) === String(sel.classNum));
          if (idx >= 0) {
            active[idx].ts = new Date().toISOString();
          } else {
            active.push({ classNum: sel.classNum, className: sel.className || '', ts: new Date().toISOString() });
            console.log(`[INTRO] ${sel.classNum} reinstated to active (horse on course)`);
          }
          await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
        }
        console.log(`[INTRO] ${slug}:${ring} — #${body.entry} ${body.horse}`);
        return json({ ok: true, event: 'INTRO', entry: body.entry });
      }

      if (event === 'FAULT') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        if (existing) {
          const oc = JSON.parse(existing);
          oc.jumpFaults = body.jumpFaults || '0';
          oc.timeFaults = body.timeFaults || '0';
          await env.WEST_LIVE.put(key, JSON.stringify(oc), { expirationTtl: 300 });
        }
        console.log(`[FAULT] ${slug}:${ring} — #${body.entry} jf=${body.jumpFaults}`);
        return json({ ok: true, event: 'FAULT' });
      }

      if (event === 'FINISH') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        const prev = existing ? JSON.parse(existing) : {};
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry || prev.entry, horse: body.horse || prev.horse,
          rider: body.rider || prev.rider, owner: body.owner || prev.owner,
          phase: 'FINISH', ta: prev.ta || body.ta || '',
          elapsed: body.elapsed || '', jumpFaults: body.jumpFaults || '0',
          timeFaults: body.timeFaults || '0', rank: body.rank || '',
          hunterScore: body.hunterScore || '', isHunter: !!body.isHunter,
          round: body.round || 1, label: body.label || '',
          ts: new Date().toISOString()
        }), { expirationTtl: 600 }); // 10 min — hunters hold finish display indefinitely on page, need long KV persistence
        console.log(`[FINISH] ${slug}:${ring} — #${body.entry} rank=${body.rank}`);
        return json({ ok: true, event: 'FINISH', entry: body.entry });
      }

      if (event === 'CD_START') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          phase: 'CD', countdown: body.countdown || 0, ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          ts: new Date().toISOString()
        }), { expirationTtl: 120 });
        console.log(`[CD_START] ${slug}:${ring} — #${body.entry} ${body.horse} cd=${body.countdown}`);
        return json({ ok: true, event: 'CD_START', entry: body.entry });
      }

      if (event === 'ON_COURSE') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          phase: 'ONCOURSE', elapsed: body.elapsed || 0, ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          isHunter: !!body.isHunter,
          flatEntries: body.flatEntries || null,
          paused: false,
          ts: new Date().toISOString()
        }), { expirationTtl: 300 });
        console.log(`[ON_COURSE] ${slug}:${ring} — #${body.entry} ${body.horse}${body.isHunter ? ' [hunter]' : ''}${body.flatEntries ? ' [flat:' + body.flatEntries.length + ']' : ''}`);
        return json({ ok: true, event: 'ON_COURSE', entry: body.entry });
      }

      if (event === 'HUNTER_RESULT') {
        // Flat/forced class result announcement — accumulates results as operator
        // announces ribbons. Store the growing list on oncourse KV so live page
        // can render ribbons appearing in real time.
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        const prev = existing ? JSON.parse(existing) : {};
        await env.WEST_LIVE.put(key, JSON.stringify({
          ...prev,
          phase: 'RESULTS',
          entry: body.entry, horse: body.horse, rider: body.rider,
          place: body.place, score: body.score || '',
          isHunter: true,
          hunterResults: body.hunterResults || [],
          ts: new Date().toISOString()
        }), { expirationTtl: 600 });
        console.log(`[HUNTER_RESULT] ${slug}:${ring} — #${body.entry} ${body.place}`);
        return json({ ok: true, event: 'HUNTER_RESULT', entry: body.entry });
      }

      if (event === 'CLOCK_STOPPED') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        if (existing) {
          const oc = JSON.parse(existing);
          oc.paused = true;
          oc.elapsed = body.elapsed || oc.elapsed;
          await env.WEST_LIVE.put(key, JSON.stringify(oc), { expirationTtl: 300 });
        }
        console.log(`[CLOCK_STOPPED] ${slug}:${ring} — #${body.entry} el=${body.elapsed}`);
        return json({ ok: true, event: 'CLOCK_STOPPED' });
      }

      if (event === 'CLOCK_RESUMED') {
        const key = `oncourse:${slug}:${ring}`;
        const existing = await env.WEST_LIVE.get(key);
        if (existing) {
          const oc = JSON.parse(existing);
          oc.paused = false;
          oc.elapsed = body.elapsed || oc.elapsed;
          oc.ts = new Date().toISOString(); // reset ts anchor to now
          await env.WEST_LIVE.put(key, JSON.stringify(oc), { expirationTtl: 300 });
        }
        console.log(`[CLOCK_RESUMED] ${slug}:${ring} — #${body.entry} el=${body.elapsed}`);
        return json({ ok: true, event: 'CLOCK_RESUMED' });
      }

      if (event === 'CLEAR_ONCOURSE') {
        await env.WEST_LIVE.delete(`oncourse:${slug}:${ring}`);
        console.log(`[CLEAR_ONCOURSE] ${slug}:${ring}`);
        return json({ ok: true, event: 'CLEAR_ONCOURSE' });
      }

      if (event === 'CLASS_SELECTED') {
        const now = new Date().toISOString();
        // Update selected (most recent Ctrl+A) for backward compat
        await env.WEST_LIVE.put(`selected:${slug}:${ring}`, JSON.stringify({
          classNum, className, ts: now
        }), { expirationTtl: 7200 });
        // Add to active classes array (concurrent classes in the ring)
        const activeKey = `active:${slug}:${ring}`;
        const activeRaw = await env.WEST_LIVE.get(activeKey);
        let active = activeRaw ? JSON.parse(activeRaw) : [];
        // Update existing or add new
        const idx = active.findIndex(a => String(a.classNum) === String(classNum));
        if (idx >= 0) {
          active[idx].ts = now;
          active[idx].className = className;
        } else {
          active.push({ classNum, className, ts: now });
        }
        await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
        // Reopen class if it was marked complete — operator reopened it on scoring PC
        ctx.waitUntil(reopenClassIfComplete(env, slug, ring, classNum));
        console.log(`[CLASS_SELECTED] ${slug}:${ring} — class ${classNum} (${active.length} active)`);
        return json({ ok: true, event: 'CLASS_SELECTED', classNum, activeCount: active.length });
      }

      if (event === 'CLASS_COMPLETE') {
        // Remove from active classes array
        const activeKey = `active:${slug}:${ring}`;
        const activeRaw = await env.WEST_LIVE.get(activeKey);
        let active = activeRaw ? JSON.parse(activeRaw) : [];
        active = active.filter(a => String(a.classNum) !== String(classNum));
        await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
        // Clear `selected` if it points at the completed class — otherwise
        // results/live pages keep showing the Live badge for a closed class
        const selectedKey = `selected:${slug}:${ring}`;
        const selRaw = await env.WEST_LIVE.get(selectedKey);
        if (selRaw) {
          try {
            const sel = JSON.parse(selRaw);
            if (String(sel.classNum) === String(classNum)) {
              await env.WEST_LIVE.delete(selectedKey);
            }
          } catch(e) { /* ignore parse errors */ }
        }
        // Add to recent completions list (30 min TTL, live page shows "Recent Results")
        const recentKey = `recent:${slug}:${ring}`;
        const recentRaw = await env.WEST_LIVE.get(recentKey);
        let recent = recentRaw ? JSON.parse(recentRaw) : [];
        // Remove if already present (re-complete), then add at top
        recent = recent.filter(r => String(r.classNum) !== String(classNum));
        recent.unshift({ classNum, className, completedAt: new Date().toISOString() });
        await env.WEST_LIVE.put(recentKey, JSON.stringify(recent), { expirationTtl: 1800 });

        // Mark class complete in D1
        ctx.waitUntil(markClassComplete(env, slug, ring, classNum, className));
        console.log(`[CLASS_COMPLETE] ${slug}:${ring} — class ${classNum} (${active.length} remaining, ${recent.length} recent)`);
        return json({ ok: true, event: 'CLASS_COMPLETE', classNum });
      }

      return err('Unknown event type');
    }

    // ── POST /postSchedule ──────────────────────────────────────────────────
    // Watcher posts tsked.csv data — updates scheduled_date, schedule_order, schedule_flag
    if (method === 'POST' && path === '/postSchedule') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classes: schedClasses } = body;
      if (!slug || !ring || !schedClasses) return err('Missing slug, ring, or classes');
      if (await isShowLocked(env, slug)) return json({ ok: false, locked: true });
      ctx.waitUntil(writeSchedule(env, slug, ring, schedClasses));
      console.log(`[postSchedule] ${slug}:${ring} — ${schedClasses.length} classes`);
      return json({ ok: true, count: schedClasses.length });
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

      // Reject heartbeat if show is locked (admin set to complete)
      const locked = await isShowLocked(env, slug);
      if (locked) {
        console.log(`[heartbeat] ${slug} LOCKED — rejecting`);
        return json({ ok: false, locked: true, message: 'Show is complete — watcher rejected' });
      }

      const payload = {
        ts: new Date().toISOString(),
        slug, ring,
        version: body.version || '2.0',
        scoreboardPort: body.scoreboardPort || '',
      };
      const key = `heartbeat:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(payload), { expirationTtl: 120 });
      // Persistent last-seen — never expires, used when watcher goes offline
      await env.WEST_LIVE.put(`lastseen:${slug}:${ring}`, JSON.stringify(payload));
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
      const [activeRaw, eventRaw, heartbeatRaw, selectedRaw, oncourseRaw, lastseenRaw, recentRaw] = await Promise.all([
        env.WEST_LIVE.get(`active:${slug}:${ring}`),
        env.WEST_LIVE.get(`event:${slug}:${ring}`),
        env.WEST_LIVE.get(`heartbeat:${slug}:${ring}`),
        env.WEST_LIVE.get(`selected:${slug}:${ring}`),
        env.WEST_LIVE.get(`oncourse:${slug}:${ring}`),
        env.WEST_LIVE.get(`lastseen:${slug}:${ring}`),
        env.WEST_LIVE.get(`recent:${slug}:${ring}`),
      ]);
      const active = activeRaw ? JSON.parse(activeRaw) : [];
      const selected = selectedRaw ? JSON.parse(selectedRaw) : null;

      // Fetch per-class live data for all active classes
      const classDataMap = {};
      if (active.length) {
        const classReads = await Promise.all(
          active.map(a => env.WEST_LIVE.get(`live:${slug}:${ring}:${a.classNum}`))
        );
        active.forEach((a, i) => {
          if (classReads[i]) classDataMap[a.classNum] = JSON.parse(classReads[i]);
        });
      }

      // Filter recent completions — drop anything older than 30 min
      let recentClasses = recentRaw ? JSON.parse(recentRaw) : [];
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      recentClasses = recentClasses.filter(r => r.completedAt > thirtyMinAgo);

      return json({
        ok:             true,
        activeClasses:  active,
        recentClasses:  recentClasses,
        selected:       selected,
        classData:      classDataMap,
        latestEvent:    eventRaw     ? JSON.parse(eventRaw)     : null,
        onCourse:       oncourseRaw  ? JSON.parse(oncourseRaw)  : null,
        watcherAlive:   !!heartbeatRaw,
        heartbeatTs:    heartbeatRaw ? JSON.parse(heartbeatRaw).ts : null,
        lastSeenTs:     lastseenRaw  ? JSON.parse(lastseenRaw).ts  : null,
        ts:             new Date().toISOString(),
      });
    }

    // ── GET /getShow ──────────────────────────────────────────────────────────
    // Public — show info + rings for the show hub page
    if (method === 'GET' && path === '/getShow') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      ctx.waitUntil(autoCompleteStaleClasses(env, slug));
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id, slug, name, venue, dates, location, year, status, rings_count FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, show: null, rings: [] });
        const rings = await env.WEST_DB.prepare(
          'SELECT ring_num, ring_name, sort_order, status FROM rings WHERE show_id = ? ORDER BY sort_order ASC, CAST(ring_num AS INTEGER) ASC'
        ).bind(show.id).all();
        const classCounts = await env.WEST_DB.prepare(
          "SELECT ring, COUNT(*) as count, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete_count FROM classes WHERE show_id = ? AND (hidden = 0 OR hidden IS NULL) GROUP BY ring"
        ).bind(show.id).all();
        const countMap = {};
        (classCounts.results || []).forEach(r => { countMap[r.ring] = { total: r.count, complete: r.complete_count }; });
        const ringsData = (rings.results || []).map(r => ({
          ...r,
          class_count: countMap[r.ring_num] ? countMap[r.ring_num].total : 0,
          complete_count: countMap[r.ring_num] ? countMap[r.ring_num].complete : 0,
        }));
        return json({ ok: true, show, rings: ringsData });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getClasses ───────────────────────────────────────────────────────
    // Website gets all classes for a show with status
    if (method === 'GET' && path === '/getClasses') {
      const slug = url.searchParams.get('slug');
      if (slug) ctx.waitUntil(autoCompleteStaleClasses(env, slug));
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
        // Public requests (no auth) hide hidden classes; admin sees all
        const isAdmin = isAuthed(request, env);
        if (!isAdmin) { sql += ' AND (c.hidden = 0 OR c.hidden IS NULL)'; }
        sql += ' GROUP BY c.id ORDER BY c.scheduled_date ASC, c.schedule_order ASC, CAST(c.class_num AS INTEGER) ASC';

        const result = await env.WEST_DB.prepare(sql).bind(...params).all();
        return json({ ok: true, classes: result.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getResults ───────────────────────────────────────────────────────
    // Website gets full results for a specific class.
    // Priority: KV pre-computed results (live/recent) → D1 fallback (historical).
    // cls_raw is NEVER sent to the client — computation happens server-side.
    if (method === 'GET' && path === '/getResults') {
      const slug     = url.searchParams.get('slug');
      const classNum = url.searchParams.get('classNum');
      const ring     = url.searchParams.get('ring') || '1';
      if (!slug || !classNum) return err('Missing slug or classNum');
      try {
        // Try KV pre-computed results first (live or recently completed classes)
        const resultsKey = `results:${slug}:${ring}:${classNum}`;
        const kvResults = await env.WEST_LIVE.get(resultsKey);
        if (kvResults) {
          return json({ ok: true, source: 'live', computed: JSON.parse(kvResults) });
        }

        // Fallback: D1 (historical/completed classes)
        const show = await env.WEST_DB.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return json({ ok: true, class: null, entries: [] });

        const cls = await env.WEST_DB.prepare(
          'SELECT * FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
        ).bind(show.id, ring, classNum).first();
        if (!cls) return json({ ok: true, class: null, entries: [] });

        // If we have final_results in D1 (frozen on CLASS_COMPLETE), serve that
        if (cls.final_results) {
          return json({ ok: true, source: 'final', computed: JSON.parse(cls.final_results) });
        }

        // Last resort: D1 entries + class metadata (no cls_raw sent to client)
        const entries = await env.WEST_DB.prepare(`
          SELECT e.entry_num, e.horse, e.rider, e.owner, e.country,
                 e.sire, e.dam, e.city, e.state, e.horse_fei, e.rider_fei,
                 r.round, r.time, r.jump_faults, r.time_faults,
                 r.total, r.place, r.status_code
          FROM entries e
          LEFT JOIN results r ON r.entry_id = e.id
          WHERE e.class_id = ?
          ORDER BY CAST(r.place AS INTEGER), e.entry_num, r.round
        `).bind(cls.id).all();

        // Strip cls_raw from class metadata before sending
        const { cls_raw, ...clsSafe } = cls;
        return json({ ok: true, source: 'db', class: clsSafe, entries: entries.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getShows — public list of shows for the index page ──────────────
    if (method === 'GET' && path === '/getShows') {
      try {
        // Read hideUpcoming setting — if enabled, filter out pending shows
        const settingsRaw = await env.WEST_LIVE.get('settings');
        const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
        const hideUpcoming = !!settings.hideUpcoming;

        let sql = "SELECT slug, name, venue, dates, location, year, status, rings_count, start_date, end_date FROM shows WHERE status != 'hidden'";
        if (hideUpcoming) sql += " AND status != 'pending'";
        sql += " ORDER BY COALESCE(start_date, created_at) DESC";
        const result = await env.WEST_DB.prepare(sql).all();
        return json({ ok: true, shows: result.results || [] });
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
        // Add class counts per show
        const shows = result.results || [];
        for (const s of shows) {
          const counts = await env.WEST_DB.prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete FROM classes WHERE show_id = ?"
          ).bind(s.id).first();
          s.class_total = counts ? counts.total : 0;
          s.class_active = counts ? counts.active : 0;
          s.class_complete = counts ? counts.complete : 0;
        }
        return json({ ok: true, shows });
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
                       'stats_eligible','status','notes','start_date','end_date'];
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

    // ── POST /admin/migrate — run schema migrations ───────────────────────────
    if (method === 'POST' && path === '/admin/migrate') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const results = [];
      const migrations = [
        "ALTER TABLE classes ADD COLUMN clock_precision INTEGER DEFAULT 2",
        "ALTER TABLE classes ADD COLUMN cls_raw TEXT",
        "ALTER TABLE classes ADD COLUMN hidden INTEGER DEFAULT 0",
        "ALTER TABLE classes ADD COLUMN stats_exclude INTEGER DEFAULT 0",
        "ALTER TABLE rings ADD COLUMN sort_order INTEGER DEFAULT 0",
        "CREATE TABLE IF NOT EXISTS ring_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, show_id INTEGER NOT NULL, ring TEXT NOT NULL, date TEXT NOT NULL, first_post_at TEXT NOT NULL, last_post_at TEXT NOT NULL, UNIQUE(show_id, ring, date))",
        "ALTER TABLE ring_activity ADD COLUMN first_horse_at TEXT",
        "ALTER TABLE shows ADD COLUMN start_date TEXT",
        "ALTER TABLE shows ADD COLUMN end_date TEXT",
        "ALTER TABLE classes ADD COLUMN final_results TEXT",
      ];
      for (const sql of migrations) {
        try { await env.WEST_DB.prepare(sql).run(); results.push({ sql, ok: true }); }
        catch(e) { results.push({ sql, ok: false, error: e.message }); }
      }
      return json({ ok: true, results });
    }

    // ── POST /admin/removeLiveClass — remove a class from active array ────────
    if (method === 'POST' && path === '/admin/removeLiveClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum } = body;
      if (!slug || !ring || !classNum) return err('Missing slug, ring, or classNum');
      const activeKey = `active:${slug}:${ring}`;
      const activeRaw = await env.WEST_LIVE.get(activeKey);
      let active = activeRaw ? JSON.parse(activeRaw) : [];
      active = active.filter(a => String(a.classNum) !== String(classNum));
      await env.WEST_LIVE.put(activeKey, JSON.stringify(active), { expirationTtl: 7200 });
      console.log(`[admin] Removed class ${classNum} from live — ${active.length} remaining`);
      return json({ ok: true, classNum, remaining: active.length });
    }

    // ── GET /admin/rings — get rings for a show ────────────────────────────────
    if (method === 'GET' && path === '/admin/rings') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, rings: [] });
        const result = await env.WEST_DB.prepare(
          'SELECT * FROM rings WHERE show_id = ? ORDER BY sort_order ASC, CAST(ring_num AS INTEGER) ASC'
        ).bind(show.id).all();
        return json({ ok: true, rings: result.results });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/upsertRing — add or update a ring ────────────────────────
    if (method === 'POST' && path === '/admin/upsertRing') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const { slug, ring_num, ring_name, sort_order } = body;
      if (!slug || !ring_num) return err('Missing slug or ring_num');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found');
        await env.WEST_DB.prepare(`
          INSERT INTO rings (show_id, ring_num, ring_name, sort_order, status)
          VALUES (?, ?, ?, ?, 'active')
          ON CONFLICT(show_id, ring_num) DO UPDATE SET
            ring_name = excluded.ring_name,
            sort_order = excluded.sort_order
        `).bind(show.id, ring_num, ring_name || '', sort_order != null ? sort_order : 0).run();
        // Keep shows.rings_count in sync with actual ring count
        await env.WEST_DB.prepare(
          'UPDATE shows SET rings_count = (SELECT COUNT(*) FROM rings WHERE show_id = ?) WHERE id = ?'
        ).bind(show.id, show.id).run();
        return json({ ok: true, ring_num });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── DELETE /admin/deleteRing — remove a ring ─────────────────────────────
    if (method === 'DELETE' && path === '/admin/deleteRing') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      const ring_num = url.searchParams.get('ring_num');
      if (!slug || !ring_num) return err('Missing slug or ring_num');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found');
        await env.WEST_DB.prepare('DELETE FROM rings WHERE show_id = ? AND ring_num = ?').bind(show.id, ring_num).run();
        // Keep shows.rings_count in sync with actual ring count
        await env.WEST_DB.prepare(
          'UPDATE shows SET rings_count = (SELECT COUNT(*) FROM rings WHERE show_id = ?) WHERE id = ?'
        ).bind(show.id, show.id).run();
        return json({ ok: true, ring_num });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/uploadCls — manual cls file upload, bypasses show lock ────
    if (method === 'POST' && path === '/admin/uploadCls') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');
      const classNum = (body.filename || '').replace('.cls', '');
      if (!classNum) return err('Missing filename');

      // Check if this class exists and warn on mismatch
      const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
      if (!show) return err('Show not found');
      const existing = await env.WEST_DB.prepare(
        'SELECT class_num, class_name FROM classes WHERE show_id = ? AND ring = ? AND class_num = ?'
      ).bind(show.id, ring, classNum).first();

      // Write to D1 — intentionally bypasses isShowLocked
      await writeToD1(env, body, slug, ring);

      console.log(`[admin/uploadCls] ${slug}:${ring} class ${classNum} — manual upload`);
      return json({
        ok: true,
        classNum,
        isNew: !existing,
        existingName: existing ? existing.class_name : null,
      });
    }

    // ── POST /admin/updateClass — toggle hidden, stats_exclude, status ────────
    if (method === 'POST' && path === '/admin/updateClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum } = body;
      if (!slug || !classNum) return err('Missing slug or classNum');
      const allowed = ['hidden', 'stats_exclude', 'status'];
      const sets = [], params = [];
      for (const [k, v] of Object.entries(body)) {
        if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
      }
      if (!sets.length) return err('No valid fields');
      sets.push('updated_at = datetime(\'now\')');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return err('Show not found');
        params.push(show.id, ring || '1', classNum);
        await env.WEST_DB.prepare(
          `UPDATE classes SET ${sets.join(', ')} WHERE show_id = ? AND ring = ? AND class_num = ?`
        ).bind(...params).run();
        console.log(`[updateClass] ${slug}:${classNum} — ${sets.join(', ')}`);
        return json({ ok: true, classNum });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── POST /admin/completeClass ─────────────────────────────────────────────
    // Watcher posts on 3x Ctrl+A — marks class complete in D1
    if (method === 'POST' && path === '/admin/completeClass') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }
      const { slug, ring, classNum } = body;
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
        env.WEST_LIVE.delete(`active:${slug}:${ring}`),
        env.WEST_LIVE.delete(`oncourse:${slug}:${ring}`),
        env.WEST_LIVE.delete(`lastseen:${slug}:${ring}`),
      ]);
      console.log(`[admin] Cleared live KV: ${slug}:${ring}`);
      return json({ ok: true, message: `Live data cleared for ${slug} ring ${ring}` });
    }

    // ── GET /admin/dbStats ─────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/dbStats') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        const [shows, classes, entries, results] = await Promise.all([
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM shows').first(),
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM classes').first(),
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM entries').first(),
          env.WEST_DB.prepare('SELECT COUNT(*) as c FROM results').first(),
        ]);
        return json({ ok: true, shows: shows.c, classes: classes.c, entries: entries.c, results: results.c });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /admin/settings ────────────────────────────────────────────────
    if (method === 'GET' && path === '/admin/settings') {
      const raw = await env.WEST_LIVE.get('settings');
      return json({ ok: true, settings: raw ? JSON.parse(raw) : { showDifficultyGauge: false } });
    }

    // ── POST /admin/settings ───────────────────────────────────────────────
    if (method === 'POST' && path === '/admin/settings') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const raw = await env.WEST_LIVE.get('settings');
      const settings = raw ? JSON.parse(raw) : {};
      Object.assign(settings, body);
      await env.WEST_LIVE.put('settings', JSON.stringify(settings));
      console.log(`[admin] Settings updated: ${JSON.stringify(settings)}`);
      return json({ ok: true, settings });
    }

    return err('Not found', 404);
  }
};

// ── ACTIVATE SHOW ─────────────────────────────────────────────────────────────
// Called on heartbeat — flips status pending→active, updates name if set
async function activateShow(env, slug) {
  try {
    // Pending → Active on first heartbeat (never touches complete)
    const result = await env.WEST_DB.prepare(`
      UPDATE shows SET status = 'active', updated_at = datetime('now')
      WHERE slug = ? AND status = 'pending'
    `).bind(slug).run();
    if (result.meta.changes > 0) {
      console.log(`[activateShow] ${slug} — pending → active (first heartbeat)`);
    }
    await autoCompleteShow(env, slug);
    await autoCompleteStaleClasses(env, slug);
  } catch(e) {
    console.error(`[activateShow ERROR] ${e.message}`);
  }
}

// ── AUTO-COMPLETE SHOW AFTER END DATE ─────────────────────────────────────────
// If end_date has passed and show is still active, auto-flip to complete
async function autoCompleteShow(env, slug) {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const result = await env.WEST_DB.prepare(`
      UPDATE shows SET status = 'complete', updated_at = datetime('now')
      WHERE slug = ? AND status = 'active' AND end_date IS NOT NULL AND end_date < ?
    `).bind(slug, today).run();
    if (result.meta.changes > 0) {
      console.log(`[autoCompleteShow] ${slug} — end_date passed, auto-completed`);
    }
  } catch(e) {
    console.error(`[autoCompleteShow ERROR] ${e.message}`);
  }
}

// ── AUTO-COMPLETE STALE CLASSES ──────────────────────────────────────────────
// Classes not updated in 3+ hours get marked complete (unless show is locked)
async function autoCompleteStaleClasses(env, slug) {
  try {
    const result = await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'complete', updated_at = datetime('now')
      WHERE show_id = (SELECT id FROM shows WHERE slug = ? AND status != 'complete')
        AND status = 'active'
        AND updated_at < datetime('now', '-30 minutes')
    `).bind(slug).run();
    if (result.meta.changes > 0) {
      console.log(`[autoComplete] ${slug} — ${result.meta.changes} class(es) auto-completed`);
    }
  } catch(e) {
    console.error(`[autoComplete ERROR] ${e.message}`);
  }
}

// ── REOPEN CLASS IF COMPLETE ─────────────────────────────────────────────────
// Called on CLASS_SELECTED — flips class back to active unless show is locked
async function reopenClassIfComplete(env, slug, ring, classNum) {
  try {
    await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'active', updated_at = datetime('now')
      WHERE show_id = (SELECT id FROM shows WHERE slug = ? AND status != 'complete')
        AND ring = ? AND class_num = ? AND status = 'complete'
    `).bind(slug, ring, classNum).run();
  } catch(e) {
    console.error(`[reopenClass ERROR] ${e.message}`);
  }
}

// ── RECORD FIRST HORSE ───────────────────────────────────────────────────────
// Sets first_horse_at on ring_activity — only if not already set for today
async function recordFirstHorse(env, slug, ring) {
  try {
    const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
    if (!show) return;
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    const today = now.split(' ')[0];
    // Only set if first_horse_at is null for today — never overwrite
    await env.WEST_DB.prepare(`
      UPDATE ring_activity SET first_horse_at = ?
      WHERE show_id = ? AND ring = ? AND date = ? AND first_horse_at IS NULL
    `).bind(now, show.id, ring, today).run();
  } catch(e) {
    console.error(`[recordFirstHorse ERROR] ${e.message}`);
  }
}

// ── CHECK SHOW LOCKED ────────────────────────────────────────────────────────
async function isShowLocked(env, slug) {
  try {
    const show = await env.WEST_DB.prepare(
      'SELECT status FROM shows WHERE slug = ?'
    ).bind(slug).first();
    return show && show.status === 'complete';
  } catch(e) { return false; }
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

    // Freeze pre-computed results into D1 — permanent record
    const resultsKey = `results:${slug}:${ring}:${classNum}`;
    const kvResults = await env.WEST_LIVE.get(resultsKey);
    const finalResults = kvResults || null;

    await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'complete', updated_at = ?, final_results = ?
      WHERE show_id = ? AND ring = ? AND class_num = ?
    `).bind(now, finalResults, show.id, ring, classNum).run();
    console.log(`[markClassComplete] ${slug}:${ring} class ${classNum} — ${className}${finalResults ? ' [results frozen]' : ''}`);
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

    // Look up show — must be created in admin first, watcher does not create shows
    const show = await env.WEST_DB.prepare(
      'SELECT id, status FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) {
      console.log(`[D1] Show ${slug} not found — create it in admin first`);
      return;
    }
    // Update timestamp
    await env.WEST_DB.prepare(
      'UPDATE shows SET updated_at = ? WHERE id = ?'
    ).bind(now, show.id).run();

    // Upsert ring
    await env.WEST_DB.prepare(`
      INSERT INTO rings (show_id, ring_num, status) VALUES (?, ?, 'active')
      ON CONFLICT(show_id, ring_num) DO UPDATE SET status = 'active'
    `).bind(show.id, ring).run();

    // Track ring activity — first and last post per day
    const today = now.split(' ')[0]; // YYYY-MM-DD
    await env.WEST_DB.prepare(`
      INSERT INTO ring_activity (show_id, ring, date, first_post_at, last_post_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(show_id, ring, date) DO UPDATE SET last_post_at = excluded.last_post_at
    `).bind(show.id, ring, today, now, now).run();

    // Upsert class
    const classNum = (body.filename || '').replace('.cls', '');
    if (!classNum) return;

    await env.WEST_DB.prepare(`
      INSERT INTO classes (show_id, ring, class_num, class_name, class_type,
                           scoring_method, is_fei, show_flags, clock_precision, cls_raw, sponsor, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(show_id, ring, class_num) DO UPDATE SET
        class_name      = excluded.class_name,
        class_type      = excluded.class_type,
        scoring_method  = excluded.scoring_method,
        is_fei          = excluded.is_fei,
        show_flags      = excluded.show_flags,
        clock_precision = excluded.clock_precision,
        cls_raw         = excluded.cls_raw,
        sponsor         = excluded.sponsor,
        status          = 'active',
        updated_at      = excluded.updated_at
    `).bind(
      show.id, ring, classNum,
      body.className      || '',
      body.classType      || '',
      body.scoringMethod  || '',
      body.isFEI ? 1 : 0,
      body.showFlags ? 1 : 0,
      parseInt(body.clockPrecision) || 2,
      body.clsRaw         || '',
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
        INSERT INTO entries (class_id, entry_num, horse, rider, owner, country, sire, dam, city, state, horse_fei, rider_fei, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(class_id, entry_num) DO UPDATE SET
          horse = excluded.horse,
          rider = excluded.rider,
          owner = excluded.owner,
          country = excluded.country,
          sire = excluded.sire,
          dam = excluded.dam,
          city = excluded.city,
          state = excluded.state,
          horse_fei = excluded.horse_fei,
          rider_fei = excluded.rider_fei
      `).bind(cls.id, e.entryNum, e.horse || '', e.rider || '', e.owner || '',
        e.country || '', e.sire || '', e.dam || '', e.city || '', e.state || '',
        e.horseFEI || '', e.riderFEI || '', now).run();

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

// ── WRITE SCHEDULE ───────────────────────────────────────────────────────────
// Updates classes with scheduled_date, schedule_order, schedule_flag from tsked data
async function writeSchedule(env, slug, ring, schedClasses) {
  try {
    const show = await env.WEST_DB.prepare(
      'SELECT id FROM shows WHERE slug = ?'
    ).bind(slug).first();
    if (!show) return;

    for (const sc of schedClasses) {
      await env.WEST_DB.prepare(`
        UPDATE classes
        SET scheduled_date = ?, schedule_order = ?, schedule_flag = ?,
            updated_at = datetime('now')
        WHERE show_id = ? AND ring = ? AND class_num = ?
      `).bind(
        sc.date || null,
        sc.order != null ? sc.order : null,
        sc.flag || null,
        show.id, ring, sc.classNum
      ).run();
    }
    console.log(`[writeSchedule] ${slug}:${ring} — ${schedClasses.length} classes updated`);
  } catch(e) {
    console.error(`[writeSchedule ERROR] ${e.message}`);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function extractSlugRing(body, url) {
  let slug = url.searchParams.get('slug');
  let ring = url.searchParams.get('ring');
  if (!slug) slug = body.slug || null;
  if (!ring) ring = body.ring || '1';
  return { slug, ring };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE COMPUTATION — pre-compute results from watcher data
// Runs once in the Worker on every postClassData. Pages receive the finished
// result object and just render — no parsing, no ranking, no cls_raw needed.
//
// The .cls file is the source of truth. Ryegate scores and places. We only:
//   1. Parse — structure raw columns into clean fields
//   2. Rank per-judge — the ONE thing Ryegate doesn't give us (derby only)
//   3. Aggregate — fault buckets, averages, leaderboard (jumper stats)
//   4. Package — one JSON object, ready to render
// ═══════════════════════════════════════════════════════════════════════════════

// ── CLS PARSING (ported from display-config.js) ─────────────────────────────

function parseClsHeader(clsRaw) {
  if (!clsRaw) return [];
  const line = clsRaw.split(/\r?\n/)[0] || '';
  const r = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { r.push(c.trim()); c = ''; }
    else c += ch;
  }
  r.push(c.trim());
  return r;
}

function parseClsRows(clsRaw) {
  if (!clsRaw) return [];
  const lines = clsRaw.split(/\r?\n/);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line || line.charAt(0) === '@') continue;
    const r = []; let c = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { r.push(c); c = ''; }
      else c += ch;
    }
    r.push(c);
    if (r[0] && /^\d/.test(r[0])) rows.push(r);
  }
  return rows;
}

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── HUNTER HEADER INTERPRETATION ────────────────────────────────────────────
// H[2]=ClassMode (0=OverFences, 1=Flat, 2=Derby, 3=Special)
// H[5]=ScoringType (0=Forced, 1=Scored, 2=HiLo)
// H[7]=NumJudges
// H[10]=IsEquitation, H[11]=IsChampionship
// H[37]=DerbyType (only when H[2]=2)

const DERBY_TYPES = {
  '0': { label: 'International',       judges: 2 },
  '1': { label: 'National',            judges: 1 },
  '2': { label: 'National H&G',        judges: 1 },
  '3': { label: 'International H&G',   judges: 2 },
  '4': { label: 'USHJA Pony Derby',    judges: 1 },
  '5': { label: 'USHJA Pony Derby H&G',judges: 1 },
  '6': { label: 'USHJA 2\'6 Jr Derby', judges: 1 },
  '7': { label: 'USHJA 2\'6 Jr Derby H&G', judges: 1 },
  '8': { label: 'WCHR Derby Spec',     judges: 1 },
};

function getHunterClassInfo(h) {
  const classMode = h[2] || '0';
  const isDerby = classMode === '2';
  const isFlat = classMode === '1';
  const isSpecial = classMode === '3';
  const isEquitation = h[10] === 'True';
  const isChampionship = h[11] === 'True';
  const scoringType = h[5] || '0'; // 0=forced, 1=scored, 2=hilo
  const scoreMethod = h[6] || '0'; // 0=total, 1=average
  let judgeCount = parseInt(h[7]) || 1;
  if (isDerby) {
    const dt = DERBY_TYPES[String(h[37] || '0')];
    judgeCount = dt ? dt.judges : 1;
  }
  let label = 'Hunter';
  if (isDerby) {
    const dt = DERBY_TYPES[String(h[37] || '0')];
    label = dt ? dt.label : 'Hunter Derby';
  } else if (isSpecial) label = 'Hunter Special';
  else if (isFlat) label = 'Hunter Flat';
  else if (isEquitation) label = 'Equitation';
  else if (isChampionship) label = 'Hunter Championship';

  return { classMode, isDerby, isFlat, isSpecial, isEquitation, isChampionship,
           scoringType, scoreMethod, judgeCount, label };
}

// ── HUNTER DERBY: PARSE PER-JUDGE FROM CLS ROW ──────────────────────────────
// Column map (confirmed 2026-04-05):
//   R1:  [15]=hiOpt  [16]=J1base  [17]=hiOpt(mirror)  [18]=J2base
//   R2:  [24]=hiOpt  [25]=J1base  [26]=J1bonus  [27]=hiOpt(mirror)  [28]=J2base  [29]=J2bonus
//   [42]=R1total  [43]=R2total  [14]=place
//   [46]/[47]=R1/R2 numeric status  [52]/[53]=R1/R2 text status

function parseDerbyEntry(cols, judgeCount) {
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const r1 = [], r2 = [];
  const r1HiOpt = num(cols[15]), r2HiOpt = num(cols[24]);

  const j1r1b = num(cols[16]), j1r2b = num(cols[25]), j1r2bonus = num(cols[26]);
  r1.push({ base: j1r1b, hiopt: r1HiOpt, bonus: 0, phaseTotal: j1r1b + r1HiOpt });
  r2.push({ base: j1r2b, hiopt: r2HiOpt, bonus: j1r2bonus, phaseTotal: j1r2b + r2HiOpt + j1r2bonus });

  if (judgeCount >= 2) {
    const j2r1b = num(cols[18]), j2r2b = num(cols[28]), j2r2bonus = num(cols[29]);
    r1.push({ base: j2r1b, hiopt: r1HiOpt, bonus: 0, phaseTotal: j2r1b + r1HiOpt });
    r2.push({ base: j2r2b, hiopt: r2HiOpt, bonus: j2r2bonus, phaseTotal: j2r2b + r2HiOpt + j2r2bonus });
  }

  return {
    entry_num: cols[0] || '', horse: cols[1] || '', rider: cols[2] || '',
    country: cols[4] || '', owner: cols[5] || '', sire: cols[6] || '', dam: cols[7] || '',
    city: cols[8] || '', state: cols[9] || '',
    place: (cols[14] && cols[14] !== '0') ? cols[14] : '',
    r1, r2,
    r1Total: num(cols[42]), r2Total: num(cols[43]),
    combined: num(cols[42]) + num(cols[43]),
    r1NumericStatus: cols[46] || '', r2NumericStatus: cols[47] || '',
    r1TextStatus: cols[52] || '', r2TextStatus: cols[53] || '',
  };
}

// ── RANKING ENGINE ──────────────────────────────────────────────────────────
// Standard competition ranking (1,1,3). Ties share rank, next rank is skipped.

function assignRanks(items) {
  items.sort((a, b) => b.val - a.val);
  const ranks = {};
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && items[i].val === items[i - 1].val) {
      ranks[items[i].key] = ranks[items[i - 1].key];
    } else {
      ranks[items[i].key] = i + 1;
    }
  }
  return ranks;
}

function hasR1(e) {
  if (e.r1TextStatus) return false;
  return e.r1 && e.r1.some(p => p.phaseTotal > 0);
}
function hasR2(e) {
  if (e.r2TextStatus) return false;
  return e.r2 && e.r2.some(p => p.phaseTotal > 0);
}

function computeDerbyRankings(entries, judgeCount) {
  entries.forEach(e => {
    e.r1Ranks = []; e.r2Ranks = [];
    e.judgeCardTotals = []; e.judgeCardRanks = [];
    e.r1OverallRank = null; e.r2OverallRank = null;
    e.movement = null; e.combinedRank = null;
  });

  // Per-judge per-round ranks
  for (let j = 0; j < judgeCount; j++) {
    let items = entries.filter(hasR1).map(e => ({ key: e.entry_num, val: e.r1[j].phaseTotal }));
    let ranks = assignRanks(items);
    entries.forEach(e => { e.r1Ranks[j] = ranks[e.entry_num] || null; });

    items = entries.filter(hasR2).map(e => ({ key: e.entry_num, val: e.r2[j].phaseTotal }));
    ranks = assignRanks(items);
    entries.forEach(e => { e.r2Ranks[j] = ranks[e.entry_num] || null; });
  }

  // Judge card totals + ranks
  for (let j = 0; j < judgeCount; j++) {
    entries.forEach(e => {
      e.judgeCardTotals[j] = (hasR1(e) && hasR2(e))
        ? e.r1[j].phaseTotal + e.r2[j].phaseTotal : null;
    });
    const items = entries.filter(e => e.judgeCardTotals[j] !== null)
      .map(e => ({ key: e.entry_num, val: e.judgeCardTotals[j] }));
    const ranks = assignRanks(items);
    entries.forEach(e => { e.judgeCardRanks[j] = ranks[e.entry_num] || null; });
  }

  // R1/R2 overall ranks (aggregate across judges)
  let r1Items = entries.filter(hasR1).map(e => {
    let sum = 0; for (let j = 0; j < judgeCount; j++) sum += e.r1[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  const r1Ranks = assignRanks(r1Items);

  let r2Items = entries.filter(hasR2).map(e => {
    let sum = 0; for (let j = 0; j < judgeCount; j++) sum += e.r2[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  const r2Ranks = assignRanks(r2Items);

  entries.forEach(e => {
    e.r1OverallRank = r1Ranks[e.entry_num] || null;
    e.r2OverallRank = r2Ranks[e.entry_num] || null;
    e.combinedRank = parseInt(e.place) || null;
    if (e.r1OverallRank && e.combinedRank && hasR2(e)) {
      e.movement = e.r1OverallRank - e.combinedRank;
    }
  });

  return entries;
}

// Split decision check — judges disagree on any of positions 1/2/3
function isSplitDecision(entries, judgeCount) {
  if (judgeCount < 2) return false;
  for (let pos = 1; pos <= 3; pos++) {
    const atPos = [];
    for (let j = 0; j < judgeCount; j++) {
      const found = entries.find(e => e.judgeCardRanks && e.judgeCardRanks[j] === pos);
      if (found) atPos.push(found.entry_num);
    }
    if (atPos.length >= 2 && atPos.some(n => n !== atPos[0])) return true;
  }
  return false;
}

// ── COMPUTE CLASS RESULTS ────────────────────────────────────────────────────
// Main entry point. Takes the body from postClassData (parsed .cls + clsRaw).
// Returns a pre-computed results object ready for page rendering.

function computeClassResults(body) {
  const clsRaw = body.clsRaw || '';
  const h = parseClsHeader(clsRaw);
  const classType = h[0] || body.classType || 'U';

  const base = {
    classNum: (body.filename || '').replace('.cls', ''),
    className: body.className || h[1] || '',
    classType,
    sponsor: body.sponsor || '',
    trophy: body.trophy || '',
  };

  if (classType === 'H') return computeHunterResults(body, h, base);
  if (classType === 'J' || classType === 'T') return computeJumperResults(body, h, base);

  // Unformatted — just pass entries with place
  return { ...base, label: 'Unformatted', entries: (body.entries || []).map(e => ({
    entry_num: e.entryNum, horse: e.horse, rider: e.rider, owner: e.owner,
    place: e.place || '', hasGone: e.hasGone,
  })) };
}

// ── HUNTER RESULTS ──────────────────────────────────────────────────────────

function computeHunterResults(body, h, base) {
  const info = getHunterClassInfo(h);
  const clsRaw = body.clsRaw || '';

  const result = {
    ...base,
    label: info.label,
    isDerby: info.isDerby,
    isFlat: info.isFlat,
    isSpecial: info.isSpecial,
    isEquitation: info.isEquitation,
    isChampionship: info.isChampionship,
    judgeCount: info.judgeCount,
    scoringType: info.scoringType,
    scoreMethod: info.scoreMethod,
    classMode: info.classMode,
    clockPrecision: parseInt(h[5]) || 0,
    showFlags: body.showFlags || false,
    isSplitDecision: false,
    entries: [],
  };

  if (info.isDerby) {
    // Parse per-judge data from cls rows
    const rows = parseClsRows(clsRaw);
    let entries = rows.map(r => parseDerbyEntry(r, info.judgeCount));
    entries = computeDerbyRankings(entries, info.judgeCount);
    result.isSplitDecision = isSplitDecision(entries, info.judgeCount);

    // Sort: placed first by place, then by combined desc
    entries.sort((a, b) => {
      const pa = parseInt(a.place) || 999, pb = parseInt(b.place) || 999;
      if (pa !== pb) return pa - pb;
      return (b.combined || 0) - (a.combined || 0);
    });

    result.entries = entries;
  } else {
    // Non-derby hunter — use watcher-parsed entries
    result.entries = (body.entries || []).map(e => ({
      entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
      owner: e.owner || '', country: e.country || '',
      sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
      place: e.place || '', score: e.score || '',
      r1Total: e.r1Total || '', r2Total: e.r2Total || e.r2Score || '',
      combined: e.combined || '',
      hasGone: e.hasGone, statusCode: e.statusCode || '',
    }));
  }

  return result;
}

// ── JUMPER RESULTS + STATS ──────────────────────────────────────────────────

function computeJumperResults(body, h, base) {
  const entries = body.entries || [];
  const sm = h[2] || '';
  const clockPrecision = parseInt(h[5]) || 0;
  const ta = { r1: parseFloat(h[8]) || 0, r2: parseFloat(h[11]) || 0, r3: parseFloat(h[14]) || 0 };
  const isOptimum = sm === '6';
  const optimumTime = isOptimum && ta.r1 > 0 ? ta.r1 - 4 : 0;

  // Build structured entries with all round data
  const structured = entries.map(e => ({
    entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
    owner: e.owner || '', country: e.country || '',
    sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
    place: e.overallPlace || e.place || '',
    hasGone: e.hasGone, statusCode: e.statusCode || '',
    r1StatusCode: e.r1StatusCode || '', r2StatusCode: e.r2StatusCode || '',
    r1Time: e.r1Time || '', r1TotalTime: e.r1TotalTime || '',
    r1JumpFaults: e.r1JumpFaults || '0', r1TimeFaults: e.r1TimeFaults || '0',
    r1TotalFaults: e.r1TotalFaults || '0',
    r2Time: e.r2Time || '', r2TotalTime: e.r2TotalTime || '',
    r2JumpFaults: e.r2JumpFaults || '0', r2TimeFaults: e.r2TimeFaults || '0',
    r2TotalFaults: e.r2TotalFaults || '0',
    r3Time: e.r3Time || '', r3TotalTime: e.r3TotalTime || '',
    r3JumpFaults: e.r3JumpFaults || '0', r3TimeFaults: e.r3TimeFaults || '0',
    r3TotalFaults: e.r3TotalFaults || '0',
  }));

  // ── Stats computation ──────────────────────────────────────────────────────
  const elimStatuses = ['EL','RF','HF','OC','WD','DNS','DNF','SC','RT'];
  const isElim = sc => elimStatuses.includes((sc || '').toUpperCase());

  const competed = structured.filter(e => e.hasGone);
  const r1Valid = competed.filter(e => !isElim(e.statusCode) && !isElim(e.r1StatusCode) && e.r1TotalTime);
  const r1Elim = competed.filter(e => isElim(e.statusCode) || isElim(e.r1StatusCode));
  const r1Faults = r1Valid.map(e => parseFloat(e.r1TotalFaults) || 0);
  const r1Times = r1Valid.map(e => parseFloat(e.r1TotalTime) || 0).filter(t => t > 0);

  const clearCount = r1Faults.filter(f => f === 0).length;
  const avgFaults = r1Faults.length ? r1Faults.reduce((a, b) => a + b, 0) / r1Faults.length : 0;
  const timeFaultCount = r1Valid.filter(e => parseFloat(e.r1TimeFaults) > 0).length;
  const avgTime = r1Times.length ? r1Times.reduce((a, b) => a + b, 0) / r1Times.length : 0;

  const clearTimes = r1Valid.filter(e => parseFloat(e.r1TotalFaults) === 0)
    .map(e => parseFloat(e.r1TotalTime) || 0).filter(t => t > 0);
  const avgClearTime = clearTimes.length ? clearTimes.reduce((a, b) => a + b, 0) / clearTimes.length : 0;

  // Fault buckets: 0-8 individual, 9-11 grouped, 12+ grouped
  const faultBuckets = [];
  const faultSet = {};
  r1Faults.forEach(f => { faultSet[f] = true; });
  Object.keys(faultSet).map(Number).sort((a, b) => a - b)
    .filter(f => f <= 8)
    .forEach(f => {
      faultBuckets.push({ label: f + ' faults', value: f, count: r1Faults.filter(x => x === f).length });
    });
  const mid = r1Faults.filter(f => f >= 9 && f <= 11);
  if (mid.length) faultBuckets.push({ label: '9-11 faults', value: 'mid', count: mid.length });
  const high = r1Faults.filter(f => f >= 12);
  if (high.length) faultBuckets.push({ label: '12+ faults', value: 'high', count: high.length });
  if (r1Elim.length) faultBuckets.push({ label: 'Eliminated', value: 'elim', count: r1Elim.length });

  // Fastest 4-fault
  const f4 = r1Valid.filter(e => parseFloat(e.r1TotalFaults) === 4);
  let fastest4Fault = null;
  if (f4.length) {
    const best = f4.reduce((b, e) => {
      const t = parseFloat(e.r1TotalTime) || 999;
      return t < (b.time || 999) ? { entry_num: e.entry_num, horse: e.horse, rider: e.rider, time: t } : b;
    }, { time: 999 });
    if (best.entry_num) fastest4Fault = best;
  }

  // Leaderboard: sorted by faults asc, then time asc, with gap from leader
  const leaderboard = r1Valid.slice().sort((a, b) => {
    const fa = parseFloat(a.r1TotalFaults) || 0, fb = parseFloat(b.r1TotalFaults) || 0;
    if (fa !== fb) return fa - fb;
    return (parseFloat(a.r1TotalTime) || 0) - (parseFloat(b.r1TotalTime) || 0);
  });
  const leaderTime = leaderboard.length ? (parseFloat(leaderboard[0].r1TotalTime) || 0) : 0;
  const leaderFaults = leaderboard.length ? (parseFloat(leaderboard[0].r1TotalFaults) || 0) : 0;
  const leaderboardWithGap = leaderboard.map((e, i) => {
    const f = parseFloat(e.r1TotalFaults) || 0;
    const t = parseFloat(e.r1TotalTime) || 0;
    let gap = '';
    if (i > 0) {
      if (f > leaderFaults) gap = '+' + (f - leaderFaults) + ' flt';
      else if (t > leaderTime) gap = '+' + (t - leaderTime).toFixed(3) + 's';
    }
    return { ...e, rank: i + 1, gap };
  });

  return {
    ...base,
    label: 'Jumper',
    scoringMethod: sm,
    clockPrecision,
    showFlags: body.showFlags || false,
    ta,
    isOptimum,
    optimumTime,
    entries: structured,
    stats: {
      totalEntries: structured.length,
      competed: competed.length,
      eliminated: r1Elim.length,
      clearRounds: clearCount,
      clearPct: r1Faults.length ? Math.round(clearCount / r1Faults.length * 1000) / 10 : 0,
      avgFaults: Math.round(avgFaults * 100) / 100,
      timeFaultCount,
      avgTime: Math.round(avgTime * 1000) / 1000,
      avgClearTime: Math.round(avgClearTime * 1000) / 1000,
      faultBuckets,
      fastest4Fault,
      leaderboard: leaderboardWithGap,
    },
  };
}
