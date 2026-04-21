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

// v3 feature flag. Reads env.V3_ENABLED (wrangler.toml [vars] or Cloudflare
// dashboard override). Default OFF — production stays safe until cutover.
// Use this helper at the entry of every v3 endpoint:
//   if (!isV3Enabled(env)) return new Response('v3 disabled', { status: 404 });
// Never check env.V3_ENABLED directly — go through this helper so we can
// evolve it later (e.g., add per-show toggles or staged rollout percentages).
function isV3Enabled(env) {
  return env.V3_ENABLED === 'true' || env.V3_ENABLED === true;
}

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

// ETag-aware JSON response. If the client sent If-None-Match and the
// data hasn't changed, returns 304 (zero bytes). Otherwise returns the
// full response with an ETag header. Uses a simple FNV-1a hash — fast,
// no crypto overhead, collisions don't matter (worst case = one extra fetch).
async function jsonWithEtag(request, data) {
  const body = JSON.stringify(data);
  // FNV-1a 32-bit hash
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const etag = '"' + (h >>> 0).toString(36) + '"';
  const clientEtag = request.headers.get('If-None-Match');
  if (clientEtag === etag) {
    return new Response(null, { status: 304, headers: CORS });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'ETag': etag, ...CORS },
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
      // Preserve previously-set per-entry status codes across postClassData
      // writes. Old watchers that don't read Farmtek col[38] correctly (or
      // miss UDP overlays) leave r1/r2StatusCode empty in the body; previous
      // overlays would be lost on every save. Only fill gaps — don't
      // overwrite statuses the incoming body actually set.
      try {
        const prevRaw = await env.WEST_LIVE.get(key);
        if (prevRaw && body && Array.isArray(body.entries)) {
          const prev = JSON.parse(prevRaw);
          const prevByEntry = {};
          (prev.entries || []).forEach(pe => { if (pe && pe.entryNum) prevByEntry[pe.entryNum] = pe; });
          body.entries.forEach(e => {
            const p = prevByEntry[e.entryNum];
            if (!p) return;
            // Only backfill status from previous KV if the incoming entry has
            // NO status on ANY round. If the cls parser set a status on one
            // round (e.g. r2=OC), that's the authoritative picture — don't
            // pull stale statuses from a previous UDP overlay into other rounds.
            const incomingHasStatus = !!(e.r1StatusCode || e.r2StatusCode || e.statusCode);
            if (!incomingHasStatus) {
              if (p.r1StatusCode) e.r1StatusCode = p.r1StatusCode;
              if (p.r2StatusCode) e.r2StatusCode = p.r2StatusCode;
              if (p.statusCode)   e.statusCode   = p.statusCode;
            }
          });
        }
      } catch (e) { /* best-effort merge — ignore parse errors */ }
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 7200 });

      // Pre-compute results — runs once here instead of on every viewer's phone.
      // Stored in KV for live polling, and written to D1 on CLASS_COMPLETE.
      const computed = computeClassResults(body);
      const resultsKey = `results:${slug}:${ring}:${classNum}`;
      await env.WEST_LIVE.put(resultsKey, JSON.stringify(computed), { expirationTtl: 7200 });

      // If OOG exists, persist to D1 so it survives KV expiry (watcher offline overnight)
      if (computed.orderOfGo && computed.orderOfGo.length) {
        ctx.waitUntil((async () => {
          try {
            const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
            if (show) {
              await env.WEST_DB.prepare(
                'UPDATE classes SET final_results = ? WHERE show_id = ? AND ring = ? AND class_num = ? AND (final_results IS NULL OR status != ?)'
              ).bind(JSON.stringify(computed), show.id, ring, classNum, 'complete').run();
            }
          } catch(e) { console.error('[OOG persist]', e.message); }
        })());
      }

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
          city: body.city || '', state: body.state || '',
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
            active[idx].ring = ring;
          } else {
            active.push({ classNum: sel.classNum, className: sel.className || '', ring, ts: new Date().toISOString() });
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
          city: body.city || prev.city || '', state: body.state || prev.state || '',
          phase: 'FINISH', ta: prev.ta || body.ta || '',
          elapsed: body.elapsed || prev.elapsed || '', jumpFaults: body.jumpFaults || '0',
          timeFaults: body.timeFaults || '0', rank: body.rank || '',
          eqScore: body.eqScore || prev.eqScore || '',
          hunterScore: body.hunterScore || '', isHunter: !!body.isHunter,
          round: body.round || 1, label: body.label || '',
          ts: new Date().toISOString()
        }), { expirationTtl: 600 }); // 10 min — hunters hold finish display indefinitely on page, need long KV persistence
        console.log(`[FINISH] ${slug}:${ring} — #${body.entry} rank=${body.rank}`);
        // If elapsed is a status code (WD/RT/EL/etc.), overlay it onto the
        // entry's r{round}StatusCode in classData + computed KV so the
        // standings row picks it up. Ryegate doesn't always write text
        // statuses (col[82]/[83]) for declined rounds, so the UDP finish
        // event is the only source for those cases.
        const elap = String(body.elapsed || '').toUpperCase().trim();
        const STATUS_SET = ['WD','RT','EL','RF','HF','OC','DNS','DNF','SC','DQ','RO','EX'];
        const isStatusElapsed = elap && STATUS_SET.indexOf(elap) >= 0;
        if (isStatusElapsed && body.entry) {
          ctx.waitUntil(overlayFinishStatus(env, slug, ring, String(body.entry), parseInt(body.round) || 1, elap));
        }
        return json({ ok: true, event: 'FINISH', entry: body.entry });
      }

      if (event === 'CD_START') {
        const key = `oncourse:${slug}:${ring}`;
        await env.WEST_LIVE.put(key, JSON.stringify({
          entry: body.entry, horse: body.horse, rider: body.rider, owner: body.owner,
          city: body.city || '', state: body.state || '',
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
          city: body.city || '', state: body.state || '',
          phase: 'ONCOURSE', elapsed: body.elapsed || 0, ta: body.ta || '',
          round: body.round || 1, label: body.label || '',
          fpi: body.faultsPerInterval || 1, ti: body.timeInterval || 1, ps: body.penaltySeconds || 6,
          isHunter: !!body.isHunter,
          flatEntries: body.flatEntries || null,
          paused: false,
          ts: new Date().toISOString()
        }), { expirationTtl: 300 });
        // Hunter: persist entries-seen list per class so live page can show
        // who has gone even before the .cls writes (forced placement classes)
        if (body.isHunter && body.flatEntries && body.flatEntries.length) {
          const selRaw = await env.WEST_LIVE.get(`selected:${slug}:${ring}`);
          if (selRaw) {
            const sel = JSON.parse(selRaw);
            const seenKey = `hunterseen:${slug}:${ring}:${sel.classNum}`;
            // Merge with existing — watcher resets flatEntriesSeen on class re-select
            const existingRaw = await env.WEST_LIVE.get(seenKey);
            const existing = existingRaw ? JSON.parse(existingRaw) : [];
            const merged = {};
            existing.forEach(e => { merged[e.entry] = e; });
            body.flatEntries.forEach(e => { merged[e.entry] = e; });
            await env.WEST_LIVE.put(seenKey, JSON.stringify(Object.values(merged)), { expirationTtl: 7200 });
          }
        }
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
          active[idx].ring = ring;
        } else {
          active.push({ classNum, className, ring, ts: now });
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
        recent.unshift({ classNum, className, ring, completedAt: new Date().toISOString() });
        await env.WEST_LIVE.put(recentKey, JSON.stringify(recent), { expirationTtl: 1800 });

        // Mark class complete in D1
        ctx.waitUntil(markClassComplete(env, slug, ring, classNum, className));
        console.log(`[CLASS_COMPLETE] ${slug}:${ring} — class ${classNum} (${active.length} remaining, ${recent.length} recent)`);
        return json({ ok: true, event: 'CLASS_COMPLETE', classNum });
      }

      if (event === 'ORDER_POSTED') {
        console.log(`[ORDER_POSTED] ${slug}:${ring} class ${classNum} (via peek)`);
        return json({ ok: true, event: 'ORDER_POSTED', classNum });
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
      if (body.clock) payload.clock = body.clock;
      const key = `heartbeat:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(payload), { expirationTtl: 120 });
      // Persistent last-seen — never expires. Only refresh every ~10s to avoid
      // pounding a never-expiring key when watcher heartbeats at 1/sec.
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec % 10 === 0) {
        await env.WEST_LIVE.put(`lastseen:${slug}:${ring}`, JSON.stringify(payload));
      }
      ctx.waitUntil(activateShow(env, slug));
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
      const computedMap = {};
      const hunterSeenMap = {};
      if (active.length) {
        const [classReads, resultsReads, seenReads] = await Promise.all([
          Promise.all(active.map(a => env.WEST_LIVE.get(`live:${slug}:${ring}:${a.classNum}`))),
          Promise.all(active.map(a => env.WEST_LIVE.get(`results:${slug}:${ring}:${a.classNum}`))),
          Promise.all(active.map(a => env.WEST_LIVE.get(`hunterseen:${slug}:${ring}:${a.classNum}`))),
        ]);
        active.forEach((a, i) => {
          if (classReads[i]) classDataMap[a.classNum] = JSON.parse(classReads[i]);
          if (resultsReads[i]) computedMap[a.classNum] = JSON.parse(resultsReads[i]);
          if (seenReads[i]) hunterSeenMap[a.classNum] = JSON.parse(seenReads[i]);
        });
      }

      // Filter recent completions — drop anything older than 30 min
      let recentClasses = recentRaw ? JSON.parse(recentRaw) : [];
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      recentClasses = recentClasses.filter(r => r.completedAt > thirtyMinAgo);

      return jsonWithEtag(request, {
        ok:             true,
        activeClasses:  active,
        recentClasses:  recentClasses,
        selected:       selected,
        classData:      classDataMap,
        computed:       computedMap,
        hunterSeen:     hunterSeenMap,
        latestEvent:    eventRaw     ? JSON.parse(eventRaw)     : null,
        onCourse:       oncourseRaw  ? JSON.parse(oncourseRaw)  : null,
        watcherAlive:   !!heartbeatRaw,
        watcherVersion: heartbeatRaw ? JSON.parse(heartbeatRaw).version : (lastseenRaw ? JSON.parse(lastseenRaw).version : null),
        heartbeatTs:    heartbeatRaw ? JSON.parse(heartbeatRaw).ts : null,
        heartbeatClock: heartbeatRaw ? JSON.parse(heartbeatRaw).clock || null : null,
        lastSeenTs:     lastseenRaw  ? JSON.parse(lastseenRaw).ts  : null,
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
          'SELECT id, slug, name, venue, dates, location, year, status, rings_count, start_date, end_date FROM shows WHERE slug = ?'
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

    // ── GET /getShowStats ─────────────────────────────────────────────────────
    // Aggregated show-level stats: top riders, top horses, prize money leaders
    if (method === 'GET' && path === '/getShowStats') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, stats: null });

        // Total entries, unique riders, unique horses
        const totals = await env.WEST_DB.prepare(`
          SELECT COUNT(*) as totalEntries,
                 COUNT(DISTINCT e.rider) as uniqueRiders,
                 COUNT(DISTINCT e.horse) as uniqueHorses
          FROM entries e
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
        `).bind(show.id).first();

        // Entries per day
        const perDay = await env.WEST_DB.prepare(`
          SELECT c.scheduled_date as date, COUNT(*) as entries
          FROM entries e
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND c.scheduled_date IS NOT NULL AND c.scheduled_date != ''
          GROUP BY c.scheduled_date
          ORDER BY c.scheduled_date
        `).bind(show.id).all();

        // Top riders by 1st places (blues) — excludes championship classes
        const topRiders = await env.WEST_DB.prepare(`
          SELECT e.rider,
                 COUNT(CASE WHEN r.place = '1' THEN 1 END) as blues,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 3 THEN 1 END) as podiums,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 6 THEN 1 END) as ribbons,
                 COUNT(DISTINCT c.id) as classes
          FROM entries e
          JOIN results r ON r.entry_id = e.id AND r.round = 1
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND COALESCE(json_extract(c.final_results, '$.isChampionship'), 0) != 1
            AND r.place IS NOT NULL AND r.place != '' AND CAST(r.place AS INTEGER) > 0
          GROUP BY UPPER(e.rider)
          HAVING blues > 0
          ORDER BY blues DESC, podiums DESC, ribbons DESC
          LIMIT 10
        `).bind(show.id).all();

        // Top horses by 1st places — excludes championship classes
        const topHorses = await env.WEST_DB.prepare(`
          SELECT e.horse, e.rider,
                 COUNT(CASE WHEN r.place = '1' THEN 1 END) as blues,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 3 THEN 1 END) as podiums,
                 COUNT(CASE WHEN CAST(r.place AS INTEGER) BETWEEN 1 AND 6 THEN 1 END) as ribbons,
                 COUNT(DISTINCT c.id) as classes
          FROM entries e
          JOIN results r ON r.entry_id = e.id AND r.round = 1
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND e.horse IS NOT NULL AND e.horse != ''
            AND COALESCE(json_extract(c.final_results, '$.isChampionship'), 0) != 1
            AND r.place IS NOT NULL AND r.place != '' AND CAST(r.place AS INTEGER) > 0
          GROUP BY UPPER(e.horse)
          HAVING blues > 0
          ORDER BY blues DESC, podiums DESC, ribbons DESC
          LIMIT 10
        `).bind(show.id).all();

        // Champions & Reserve Champions — parse H[11] from cls_raw header
        const champClasses = await env.WEST_DB.prepare(`
          SELECT c.id, c.class_name, c.cls_raw, c.class_type
          FROM classes c
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND c.class_type = 'H' AND c.cls_raw IS NOT NULL AND c.cls_raw != ''
        `).bind(show.id).all();
        const champClassIds = [];
        for (const cc of (champClasses.results || [])) {
          const header = cc.cls_raw.split(/\r?\n/)[0].split(',');
          if (header[11] === 'True') champClassIds.push(cc);
        }
        let champResults = [];
        for (const cc of champClassIds) {
          const rows = await env.WEST_DB.prepare(`
            SELECT e.horse, e.rider, r.place
            FROM entries e
            JOIN results r ON r.entry_id = e.id AND r.round = 1
            WHERE e.class_id = ? AND r.place IS NOT NULL AND r.place != ''
              AND CAST(r.place AS INTEGER) BETWEEN 1 AND 2
            ORDER BY CAST(r.place AS INTEGER)
          `).bind(cc.id).all();
          for (const row of (rows.results || [])) {
            champResults.push({ horse: row.horse, rider: row.rider, class_name: cc.class_name, place: row.place });
          }
        }
        champResults.sort((a, b) => a.class_name.localeCompare(b.class_name) || parseInt(a.place) - parseInt(b.place));

        // Prize money leaders (by horse)
        const prizeLeaders = await env.WEST_DB.prepare(`
          SELECT e.horse, e.rider, c.class_num, c.class_name,
                 r.place, c.cls_raw
          FROM entries e
          JOIN results r ON r.entry_id = e.id AND r.round = 1
          JOIN classes c ON e.class_id = c.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND r.place IS NOT NULL AND r.place != '' AND CAST(r.place AS INTEGER) > 0
            AND e.horse IS NOT NULL AND e.horse != ''
        `).bind(show.id).all();

        // Compute prize money from cls_raw @money rows
        const prizeTotals = {};
        const classMoneyCache = {};
        for (const row of (prizeLeaders.results || [])) {
          if (!row.cls_raw) continue;
          if (!classMoneyCache[row.class_num]) {
            const moneyLine = row.cls_raw.split(/\r?\n/).find(l => l.startsWith('@money'));
            classMoneyCache[row.class_num] = moneyLine ? moneyLine.split(',').slice(1).map(Number) : [];
          }
          const prizes = classMoneyCache[row.class_num];
          const p = parseInt(row.place);
          if (p > 0 && p <= prizes.length && prizes[p - 1] > 0) {
            const key = row.horse.toUpperCase();
            if (!prizeTotals[key]) prizeTotals[key] = { horse: row.horse, rider: row.rider, total: 0, classes: 0 };
            prizeTotals[key].total += prizes[p - 1];
            prizeTotals[key].classes++;
          }
        }
        const moneyLeaders = Object.values(prizeTotals)
          .sort((a, b) => b.total - a.total)
          .slice(0, 10);

        return jsonWithEtag(request, {
          ok: true,
          stats: {
            totalEntries: totals.totalEntries || 0,
            uniqueRiders: totals.uniqueRiders || 0,
            uniqueHorses: totals.uniqueHorses || 0,
            entriesPerDay: perDay.results || [],
            topRiders: topRiders.results || [],
            topHorses: topHorses.results || [],
            champions: champResults,
            moneyLeaders: moneyLeaders,
          }
        });
      } catch(e) { return err('DB error: ' + e.message); }
    }

    // ── GET /getShowWeather ──────────────────────────────────────────────────
    // Per-day weather for show dates. Checks D1 cache first, fetches from
    // Open-Meteo (historical or forecast) for missing days, stores permanently.
    if (method === 'GET' && path === '/getShowWeather') {
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id, location, start_date, end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show || !show.start_date || !show.location) return json({ ok: true, days: [] });

        const startDate = show.start_date;
        const endDate = show.end_date || show.start_date;

        // Get cached days from D1
        const cached = await env.WEST_DB.prepare(
          'SELECT date, temp_high, temp_low, weather_code, precip_mm, wind_max, humidity_mean FROM show_weather WHERE show_id = ? ORDER BY date'
        ).bind(show.id).all();
        const cachedMap = {};
        (cached.results || []).forEach(r => { cachedMap[r.date] = r; });

        // Build list of all show dates
        const allDates = [];
        let cur = new Date(startDate + 'T12:00:00Z');
        const end = new Date(endDate + 'T12:00:00Z');
        while (cur <= end) {
          allDates.push(cur.toISOString().split('T')[0]);
          cur.setDate(cur.getDate() + 1);
        }

        // Find missing dates
        const today = new Date().toISOString().split('T')[0];
        const missingPast = allDates.filter(d => d <= today && !cachedMap[d]);
        const missingFuture = allDates.filter(d => d > today && !cachedMap[d]);

        // Geocode location
        let lat = null, lon = null;
        if (missingPast.length || missingFuture.length) {
          const city = show.location.split(',')[0].trim();
          const geoR = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1');
          if (geoR.ok) {
            const geo = await geoR.json();
            if (geo.results && geo.results.length) {
              lat = geo.results[0].latitude;
              lon = geo.results[0].longitude;
            }
          }
        }

        // Fetch historical for past missing dates
        if (lat && missingPast.length) {
          const histStart = missingPast[0];
          const histEnd = missingPast[missingPast.length - 1];
          try {
            const hr = await fetch('https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lon
              + '&start_date=' + histStart + '&end_date=' + histEnd
              + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean'
              + '&timezone=America/New_York&temperature_unit=fahrenheit');
            if (hr.ok) {
              const hd = await hr.json();
              if (hd.daily && hd.daily.time) {
                const now = new Date().toISOString().replace('T', ' ').split('.')[0];
                for (let i = 0; i < hd.daily.time.length; i++) {
                  const date = hd.daily.time[i];
                  if (!cachedMap[date]) {
                    const row = {
                      date, temp_high: hd.daily.temperature_2m_max[i],
                      temp_low: hd.daily.temperature_2m_min[i],
                      weather_code: hd.daily.weathercode[i],
                      precip_mm: hd.daily.precipitation_sum ? hd.daily.precipitation_sum[i] : null,
                      wind_max: hd.daily.windspeed_10m_max ? hd.daily.windspeed_10m_max[i] : null,
                      humidity_mean: hd.daily.relative_humidity_2m_mean ? hd.daily.relative_humidity_2m_mean[i] : null,
                    };
                    cachedMap[date] = row;
                    await env.WEST_DB.prepare(
                      'INSERT INTO show_weather (show_id, date, temp_high, temp_low, weather_code, precip_mm, wind_max, humidity_mean, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(show_id, date) DO UPDATE SET temp_high=excluded.temp_high, temp_low=excluded.temp_low, weather_code=excluded.weather_code, precip_mm=excluded.precip_mm, wind_max=excluded.wind_max, humidity_mean=excluded.humidity_mean, updated_at=excluded.updated_at'
                    ).bind(show.id, date, row.temp_high, row.temp_low, row.weather_code, row.precip_mm, row.wind_max, row.humidity_mean, now).run();
                  }
                }
              }
            }
          } catch(e) { console.error('[weather hist]', e.message); }
        }

        // Fetch forecast for future missing dates
        if (lat && missingFuture.length) {
          try {
            const fr = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon
              + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean'
              + '&timezone=America/New_York&temperature_unit=fahrenheit&forecast_days=14');
            if (fr.ok) {
              const fd = await fr.json();
              if (fd.daily && fd.daily.time) {
                for (let i = 0; i < fd.daily.time.length; i++) {
                  const date = fd.daily.time[i];
                  if (missingFuture.includes(date) && !cachedMap[date]) {
                    cachedMap[date] = {
                      date, temp_high: fd.daily.temperature_2m_max[i],
                      temp_low: fd.daily.temperature_2m_min[i],
                      weather_code: fd.daily.weathercode[i],
                      precip_mm: fd.daily.precipitation_sum ? fd.daily.precipitation_sum[i] : null,
                      wind_max: fd.daily.windspeed_10m_max ? fd.daily.windspeed_10m_max[i] : null,
                      humidity_mean: fd.daily.relative_humidity_2m_mean ? fd.daily.relative_humidity_2m_mean[i] : null,
                    };
                    // Don't persist forecasts — they change daily
                  }
                }
              }
            }
          } catch(e) { console.error('[weather forecast]', e.message); }
        }

        // Build response — only show dates
        const days = allDates.map(d => cachedMap[d] || { date: d }).filter(d => d.temp_high != null);

        return jsonWithEtag(request, { ok: true, days });
      } catch(e) { return err('Weather error: ' + e.message); }
    }

    // ── GET /searchShow ────────────────────────────────────────────────────────
    // Search for rider or horse across all classes at a show
    if (method === 'GET' && path === '/searchShow') {
      const slug = url.searchParams.get('slug');
      const q = (url.searchParams.get('q') || '').trim();
      if (!slug) return err('Missing slug');
      if (!q || q.length < 2) return json({ ok: true, results: [] });
      try {
        const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
        if (!show) return json({ ok: true, results: [] });
        const pattern = '%' + q + '%';
        const rows = await env.WEST_DB.prepare(`
          SELECT e.entry_num, e.horse, e.rider, e.owner, e.sire, e.dam, e.city, e.state,
                 c.class_num, c.class_name, c.class_type, c.ring,
                 r.round, r.time, r.jump_faults, r.time_faults, r.total, r.place, r.status_code
          FROM entries e
          JOIN classes c ON e.class_id = c.id
          LEFT JOIN results r ON r.entry_id = e.id
          WHERE c.show_id = ? AND (c.hidden = 0 OR c.hidden IS NULL)
            AND (e.horse LIKE ? OR e.rider LIKE ?)
          ORDER BY e.horse, e.rider, c.class_num, r.round
        `).bind(show.id, pattern, pattern).all();

        // Group by unique horse+rider combo
        const grouped = {};
        for (const row of (rows.results || [])) {
          const key = (row.horse || '').toUpperCase() + '|' + (row.rider || '').toUpperCase();
          if (!grouped[key]) {
            grouped[key] = {
              entry_num: row.entry_num, horse: row.horse, rider: row.rider,
              owner: row.owner, sire: row.sire, dam: row.dam,
              city: row.city, state: row.state, classes: {}
            };
          }
          const cn = row.class_num;
          if (!grouped[key].classes[cn]) {
            grouped[key].classes[cn] = {
              class_num: cn, class_name: row.class_name,
              class_type: row.class_type, ring: row.ring, rounds: []
            };
          }
          if (row.round) {
            grouped[key].classes[cn].rounds.push({
              round: row.round, time: row.time, jump_faults: row.jump_faults,
              time_faults: row.time_faults, total: row.total,
              place: row.place, status_code: row.status_code
            });
          }
        }

        // Convert to array, classes as array
        const results = Object.values(grouped).map(g => ({
          ...g, classes: Object.values(g.classes)
        }));

        return jsonWithEtag(request, { ok: true, results });
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
        return jsonWithEtag(request, { ok: true, classes: result.results });
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
          const computed = JSON.parse(kvResults);
          // For OOG classes with no results, attach pre-show stats (cached in KV)
          if (computed.orderOfGo && computed.orderOfGo.length && (!computed.entries || !computed.entries.length)) {
            const psKey = `prestats:${slug}:${ring}:${classNum}`;
            const cached = await env.WEST_LIVE.get(psKey);
            if (cached) {
              computed.preShowStats = JSON.parse(cached);
            } else {
              try {
                const ps = await buildPreShowStats(env, slug, computed.orderOfGo);
                computed.preShowStats = ps;
                if (ps) await env.WEST_LIVE.put(psKey, JSON.stringify(ps), { expirationTtl: 300 }); // 5 min cache
              } catch(e) { console.error('[preShowStats]', e.message); }
            }
          }
          return jsonWithEtag(request, { ok: true, source: 'live', computed });
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
          return jsonWithEtag(request, { ok: true, source: 'final', computed: JSON.parse(cls.final_results) });
        }

        // Last resort: compute on-the-fly from D1 cls_raw if available.
        // This handles historical classes completed before the computation engine
        // was deployed. Once computed, the result is NOT cached (one-off).
        if (cls.cls_raw) {
          try {
            // Fetch D1 entries to populate the body for jumper computation
            // (hunter derby reads from clsRaw, but jumper needs the entries array)
            const d1Entries = await env.WEST_DB.prepare(`
              SELECT e.entry_num, e.horse, e.rider, e.owner, e.country,
                     e.sire, e.dam, e.city, e.state, e.horse_fei, e.rider_fei,
                     r.round, r.time, r.jump_faults, r.time_faults,
                     r.total, r.place, r.status_code
              FROM entries e
              LEFT JOIN results r ON r.entry_id = e.id
              WHERE e.class_id = ?
              ORDER BY e.entry_num, r.round
            `).bind(cls.id).all();

            // Map D1 rows into the watcher's entry shape (grouped by entry_num)
            const entryMap = {};
            (d1Entries.results || []).forEach(row => {
              if (!entryMap[row.entry_num]) {
                entryMap[row.entry_num] = {
                  entryNum: row.entry_num, horse: row.horse, rider: row.rider,
                  owner: row.owner, country: row.country, sire: row.sire, dam: row.dam,
                  city: row.city, state: row.state, hasGone: false,
                  place: '', overallPlace: '', statusCode: '',
                };
              }
              const e = entryMap[row.entry_num];
              if (row.round === 1) {
                e.r1Time = row.time || ''; e.r1TotalTime = row.time || '';
                e.r1JumpFaults = row.jump_faults || '0'; e.r1TimeFaults = row.time_faults || '0';
                e.r1TotalFaults = row.total || '0'; e.hasGone = true;
                e.r1StatusCode = row.status_code || '';
              } else if (row.round === 2) {
                e.r2Time = row.time || ''; e.r2TotalTime = row.time || '';
                e.r2JumpFaults = row.jump_faults || '0'; e.r2TimeFaults = row.time_faults || '0';
                e.r2TotalFaults = row.total || '0';
                e.r2StatusCode = row.status_code || '';
              } else if (row.round === 3) {
                e.r3Time = row.time || ''; e.r3TotalTime = row.time || '';
                e.r3JumpFaults = row.jump_faults || '0'; e.r3TimeFaults = row.time_faults || '0';
                e.r3TotalFaults = row.total || '0';
              }
              if (row.place) { e.place = row.place; e.overallPlace = row.place; }
              if (row.status_code) e.statusCode = row.status_code;
            });

            const fakeBody = {
              filename: cls.class_num + '.cls',
              classType: cls.class_type || 'U',
              className: cls.class_name || '',
              sponsor: cls.sponsor || '',
              trophy: '',
              showFlags: !!cls.show_flags,
              clsRaw: cls.cls_raw,
              entries: Object.values(entryMap),
            };
            const computed = computeClassResults(fakeBody);
            return jsonWithEtag(request, { ok: true, source: 'computed-fallback', computed });
          } catch(e) {
            console.error('[getResults] On-the-fly compute failed:', e.message);
          }
        }

        // Absolute last resort: raw D1 entries (no cls_raw sent to client)
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

        const { cls_raw: _raw, ...clsSafe } = cls;
        return jsonWithEtag(request, { ok: true, source: 'db', class: clsSafe, entries: entries.results });
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
      const { slug, name, venue, dates, location, rings_count, stats_eligible,
              start_date, end_date } = body;
      if (!slug) return err('Missing slug');
      const now  = new Date().toISOString().replace('T', ' ').split('.')[0];
      const year = new Date().getFullYear();
      try {
        await env.WEST_DB.prepare(`
          INSERT INTO shows (slug, name, venue, dates, location, year, rings_count,
                             stats_eligible, status, start_date, end_date,
                             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            name           = excluded.name,
            venue          = excluded.venue,
            dates          = excluded.dates,
            location       = excluded.location,
            rings_count    = excluded.rings_count,
            stats_eligible = excluded.stats_eligible,
            start_date     = excluded.start_date,
            end_date       = excluded.end_date,
            updated_at     = excluded.updated_at
        `).bind(
          slug, name || '', venue || '', dates || '', location || '',
          year, rings_count || 1,
          stats_eligible !== false ? 1 : 0,
          start_date || null, end_date || null,
          now, now
        ).run();
        const show = await env.WEST_DB.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        // Auto-create Ring 1 on new shows so the Watcher Status card has
        // something to point at immediately. No-op if rings already exist.
        if (show) {
          const ringCount = await env.WEST_DB.prepare(
            'SELECT COUNT(*) AS n FROM rings WHERE show_id = ?'
          ).bind(show.id).first();
          if (!ringCount || !ringCount.n) {
            await env.WEST_DB.prepare(`
              INSERT INTO rings (show_id, ring_num, ring_name, sort_order, status)
              VALUES (?, '1', 'Ring 1', 0, 'active')
              ON CONFLICT(show_id, ring_num) DO NOTHING
            `).bind(show.id).run();
            console.log(`[admin] Auto-created Ring 1 for new show ${slug}`);
          }
        }
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
      // If admin is explicitly setting status=active, bump end_date if it's in the past
      // so autoCompleteShow doesn't immediately flip it back.
      if (fields.status === 'active' && !('end_date' in fields)) {
        const cur = await env.WEST_DB.prepare(
          'SELECT end_date FROM shows WHERE slug = ?'
        ).bind(slug).first();
        const today = new Date().toISOString().split('T')[0];
        if (cur && cur.end_date && cur.end_date < today) {
          sets.push('end_date = ?');
          params.push(today);
        }
      }
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

    // ── POST /admin/deleteShow ────────────────────────────────────────────────
    // Cascade-delete a show and all its child data from D1. Pass
    // `?confirm=1` or { confirm: true } to actually run — otherwise we
    // return a preview of what would be deleted so the admin UI can show
    // the user a count before they pull the trigger.
    if (method === 'POST' && path === '/admin/deleteShow') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
      const slug = body.slug;
      const confirm = body.confirm === true || url.searchParams.get('confirm') === '1';
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB.prepare(
          'SELECT id, name FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        const counts = await env.WEST_DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM classes WHERE show_id = ?) AS classes,
            (SELECT COUNT(*) FROM entries WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)) AS entries,
            (SELECT COUNT(*) FROM results WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)) AS results
        `).bind(show.id, show.id, show.id).first();
        if (!confirm) {
          return json({ ok: true, preview: true, show, counts });
        }
        // Delete children first, then the show.
        await env.WEST_DB.prepare(
          'DELETE FROM results WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)'
        ).bind(show.id).run();
        await env.WEST_DB.prepare(
          'DELETE FROM entries WHERE class_id IN (SELECT id FROM classes WHERE show_id = ?)'
        ).bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM classes WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM rings WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM ring_activity WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM show_weather WHERE show_id = ?').bind(show.id).run();
        await env.WEST_DB.prepare('DELETE FROM shows WHERE id = ?').bind(show.id).run();
        console.log(`[deleteShow] ${slug} — cascaded delete (classes=${counts.classes}, entries=${counts.entries}, results=${counts.results})`);
        return json({ ok: true, deleted: true, show, counts });
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
        "CREATE TABLE IF NOT EXISTS show_weather (id INTEGER PRIMARY KEY AUTOINCREMENT, show_id INTEGER NOT NULL, date TEXT NOT NULL, temp_high REAL, temp_low REAL, weather_code INTEGER, precip_mm REAL, wind_max REAL, humidity_mean REAL, source TEXT DEFAULT 'open-meteo', updated_at TEXT, UNIQUE(show_id, date))",
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

    // ── DELETE /admin/clearClassCache ─────────────────────────────────────────
    // Delete ONLY the cached computed-results KV entry for a specific class
    // so the next /getResults call rebuilds from D1 (e.g. after a D1 patch).
    // Does NOT delete the live:* class data KV — that has no D1 fallback
    // and deleting it blanks the live page until the watcher re-posts, which
    // is unsafe on a spotty scoring-PC network.
    if (method === 'DELETE' && path === '/admin/clearClassCache') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug     = url.searchParams.get('slug');
      const ring     = url.searchParams.get('ring') || '1';
      const classNum = url.searchParams.get('classNum');
      if (!slug || !classNum) return err('Missing slug or classNum');
      await env.WEST_LIVE.delete(`results:${slug}:${ring}:${classNum}`);
      console.log(`[admin] Cleared results cache: ${slug}:${ring}:${classNum}`);
      return json({ ok: true, message: `Results cache cleared for class ${classNum}` });
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

    // ═══════════════════════════════════════════════════════════════════════
    // v3 endpoints — all gated by isV3Enabled(env). Reads/writes WEST_DB_V3
    // (separate D1 from v2's WEST_DB). Phase 1: shows + rings only.
    // Slug validation: ^[a-z][a-z0-9-]{2,59}$
    // ═══════════════════════════════════════════════════════════════════════

    // ── GET /v3/listShows ─────────────────────────────────────────────────────
    if (method === 'GET' && path === '/v3/listShows') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      try {
        const { results } = await env.WEST_DB_V3.prepare(
          'SELECT id, slug, name, start_date, end_date, created_at, updated_at FROM shows ORDER BY start_date DESC, id DESC'
        ).all();
        return json({ ok: true, shows: results || [] });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/createShow ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/v3/createShow') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, name, start_date, end_date } = body;
      if (!slug) return err('Missing slug');
      if (!/^[a-z][a-z0-9-]{2,59}$/.test(slug)) {
        return err('Invalid slug — must match ^[a-z][a-z0-9-]{2,59}$');
      }
      if (!name || !name.trim()) return err('Missing name');
      try {
        await env.WEST_DB_V3.prepare(`
          INSERT INTO shows (slug, name, start_date, end_date)
          VALUES (?, ?, ?, ?)
        `).bind(slug, name.trim(), start_date || null, end_date || null).run();
        const show = await env.WEST_DB_V3.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        console.log(`[v3] Created show: ${slug}`);
        return json({ ok: true, show });
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) return err('Slug already exists', 409);
        return err('DB error: ' + e.message);
      }
    }

    // ── GET /v3/getShow?slug=X ────────────────────────────────────────────────
    if (method === 'GET' && path === '/v3/getShow') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        return json({ ok: true, show });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/updateShow ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/v3/updateShow') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, name, start_date, end_date } = body;
      if (!slug) return err('Missing slug');
      const updates = [];
      const binds = [];
      if (name !== undefined) { updates.push('name = ?'); binds.push(name.trim()); }
      if (start_date !== undefined) { updates.push('start_date = ?'); binds.push(start_date || null); }
      if (end_date !== undefined) { updates.push('end_date = ?'); binds.push(end_date || null); }
      if (!updates.length) return err('No fields to update');
      updates.push("updated_at = datetime('now')");
      binds.push(slug);
      try {
        const res = await env.WEST_DB_V3.prepare(
          `UPDATE shows SET ${updates.join(', ')} WHERE slug = ?`
        ).bind(...binds).run();
        if (!res.meta || !res.meta.changes) return err('Show not found', 404);
        const show = await env.WEST_DB_V3.prepare(
          'SELECT * FROM shows WHERE slug = ?'
        ).bind(slug).first();
        console.log(`[v3] Updated show: ${slug}`);
        return json({ ok: true, show });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── GET /v3/listRings?slug=X ──────────────────────────────────────────────
    // Returns rings for a show. Each ring includes its last_heartbeat
    // (if any) from KV so the admin page can render engine status.
    if (method === 'GET' && path === '/v3/listRings') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      const slug = url.searchParams.get('slug');
      if (!slug) return err('Missing slug');
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        const { results } = await env.WEST_DB_V3.prepare(
          'SELECT id, ring_num, name, sort_order, created_at, updated_at FROM rings WHERE show_id = ? ORDER BY sort_order, ring_num'
        ).bind(show.id).all();
        // Attach engine heartbeat state per ring (KV lookup)
        const rings = results || [];
        for (const r of rings) {
          const raw = await env.WEST_LIVE.get(`engine:${slug}:${r.ring_num}`);
          r.last_heartbeat = raw ? JSON.parse(raw) : null;
        }
        return json({ ok: true, rings });
      } catch (e) { return err('DB error: ' + e.message); }
    }

    // ── POST /v3/engineHeartbeat ─────────────────────────────────────────────
    // Engine identifies itself to the worker every ~10s. Proves the engine is
    // alive + reports its identity (show slug + ring num) + version. Stored in
    // KV with 10min TTL so admin page can render freshness. No D1 writes.
    if (method === 'POST' && path === '/v3/engineHeartbeat') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, engine_version, timestamp, hostname, uptime_seconds } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt)) return err('Invalid ring_num');
      // Verify show + ring exist in v3 DB before accepting heartbeats —
      // prevents noise from misconfigured engines claiming shows we don't know.
      try {
        const ring = await env.WEST_DB_V3.prepare(`
          SELECT r.id FROM rings r
          JOIN shows s ON s.id = r.show_id
          WHERE s.slug = ? AND r.ring_num = ?
        `).bind(slug, ringNumInt).first();
        if (!ring) return err('Unknown show/ring pair', 404);
      } catch (e) { return err('DB error: ' + e.message); }
      const received_at = new Date().toISOString();
      const payload = {
        slug, ring_num: ringNumInt,
        engine_version: engine_version || 'unknown',
        timestamp: timestamp || null,
        hostname: hostname || null,
        uptime_seconds: Number.isFinite(uptime_seconds) ? uptime_seconds : null,
        received_at,
      };
      await env.WEST_LIVE.put(
        `engine:${slug}:${ringNumInt}`,
        JSON.stringify(payload),
        { expirationTtl: 600 } // 10 minutes
      );
      return json({ ok: true, received_at });
    }

    // ── POST /v3/createRing ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/v3/createRing') {
      if (!isV3Enabled(env)) return err('v3 disabled', 404);
      if (!isAuthed(request, env)) return err('Unauthorized', 401);
      let body;
      try { body = await request.json(); } catch (e) { return err('Invalid JSON'); }
      const { slug, ring_num, name, sort_order } = body;
      if (!slug) return err('Missing slug');
      if (ring_num === undefined || ring_num === null) return err('Missing ring_num');
      const ringNumInt = parseInt(ring_num, 10);
      if (!Number.isFinite(ringNumInt) || ringNumInt < 1 || ringNumInt > 99) {
        return err('Invalid ring_num — must be integer 1-99');
      }
      try {
        const show = await env.WEST_DB_V3.prepare(
          'SELECT id FROM shows WHERE slug = ?'
        ).bind(slug).first();
        if (!show) return err('Show not found', 404);
        await env.WEST_DB_V3.prepare(`
          INSERT INTO rings (show_id, ring_num, name, sort_order)
          VALUES (?, ?, ?, ?)
        `).bind(
          show.id, ringNumInt, (name || '').trim() || null,
          Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 0
        ).run();
        const ring = await env.WEST_DB_V3.prepare(
          'SELECT * FROM rings WHERE show_id = ? AND ring_num = ?'
        ).bind(show.id, ringNumInt).first();
        console.log(`[v3] Created ring: ${slug}/ring-${ringNumInt}`);
        return json({ ok: true, ring });
      } catch (e) {
        if (String(e.message || '').includes('UNIQUE')) return err('Ring already exists for this show', 409);
        return err('DB error: ' + e.message);
      }
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

// ── OVERLAY UDP FINISH STATUS ON LIVE ENTRY ──────────────────────────────────
// When a UDP FINISH event carries a non-time status (WD/RT/EL/…), Ryegate
// doesn't always write the text status into the .cls file (cols[82]/[83]).
// This overlay injects the status into the matching entry's
// r{round}StatusCode on both the classData live KV and the computed KV so
// the standings row renders the status label (e.g. "JO WD").
async function overlayFinishStatus(env, slug, ring, entryNum, round, statusCode) {
  try {
    const selRaw = await env.WEST_LIVE.get(`selected:${slug}:${ring}`);
    if (!selRaw) return;
    const sel = JSON.parse(selRaw);
    const classNum = String(sel.classNum || '');
    if (!classNum) return;
    const liveKey = `live:${slug}:${ring}:${classNum}`;
    const resultsKey = `results:${slug}:${ring}:${classNum}`;
    const roundStatusKey = `r${round}StatusCode`;
    const [liveRaw, resultsRaw] = await Promise.all([
      env.WEST_LIVE.get(liveKey), env.WEST_LIVE.get(resultsKey),
    ]);
    const writes = [];
    if (liveRaw) {
      const cd = JSON.parse(liveRaw);
      if (cd && cd.entries) {
        const e = cd.entries.find(x => String(x.entryNum) === entryNum);
        if (e && e[roundStatusKey] !== statusCode) {
          e[roundStatusKey] = statusCode;
          e.statusCode = statusCode;
          e.hasGone = true;
          writes.push(env.WEST_LIVE.put(liveKey, JSON.stringify(cd), { expirationTtl: 7200 }));
        }
      }
    }
    if (resultsRaw) {
      const comp = JSON.parse(resultsRaw);
      if (comp && comp.entries) {
        const e = comp.entries.find(x => String(x.entry_num) === entryNum);
        if (e && e[roundStatusKey] !== statusCode) {
          e[roundStatusKey] = statusCode;
          e.statusCode = statusCode;
          writes.push(env.WEST_LIVE.put(resultsKey, JSON.stringify(comp), { expirationTtl: 7200 }));
        }
      }
    }
    if (writes.length) {
      await Promise.all(writes);
      console.log(`[overlayFinishStatus] ${slug}:${ring} cls ${classNum} #${entryNum} r${round}=${statusCode}`);
    }
    // Persist to D1 so the status survives KV expiry (historical view).
    try {
      const classRow = await env.WEST_DB.prepare(
        'SELECT c.id FROM classes c JOIN shows s ON c.show_id = s.id WHERE s.slug = ? AND c.class_num = ? AND c.ring = ?'
      ).bind(slug, classNum, ring).first();
      if (classRow && classRow.id) {
        const entryRow = await env.WEST_DB.prepare(
          'SELECT id FROM entries WHERE class_id = ? AND entry_num = ?'
        ).bind(classRow.id, entryNum).first();
        if (entryRow && entryRow.id) {
          const now = new Date().toISOString().replace('T', ' ').split('.')[0];
          await upsertResult(env, entryRow.id, classRow.id, round,
            '', '0', '0', '', '', statusCode, now);
          console.log(`[overlayFinishStatus D1] cls ${classNum} #${entryNum} r${round}=${statusCode}`);
        }
      }
    } catch(d1e) {
      console.error(`[overlayFinishStatus D1 ERROR] ${d1e.message}`);
    }
  } catch(e) {
    console.error(`[overlayFinishStatus ERROR] ${e.message}`);
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
// Classes not updated in 15 min get marked complete (unless show is locked).
// Safe because any .cls write or Ctrl+A reopens the class immediately.
async function autoCompleteStaleClasses(env, slug) {
  try {
    const result = await env.WEST_DB.prepare(`
      UPDATE classes SET status = 'complete', updated_at = datetime('now')
      WHERE show_id = (SELECT id FROM shows WHERE slug = ? AND status != 'complete')
        AND status = 'active'
        AND updated_at < datetime('now', '-60 minutes')
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
        status          = CASE WHEN classes.cls_raw = excluded.cls_raw THEN classes.status ELSE 'active' END,
        updated_at      = CASE WHEN classes.cls_raw = excluded.cls_raw THEN classes.updated_at ELSE excluded.updated_at END
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
      // Watcher field names confirmed 2026-03-22 from live class 221.
      // Also write status-only rows (e.g. WD in JO) so declined rounds
      // persist to D1 where Ryegate would normally have recorded them.
      if (isJumper && (e.r1TotalTime || e.r1StatusCode)) {
        await upsertResult(env, entry.id, cls.id, 1,
          e.r1TotalTime, e.r1JumpFaults, e.r1TimeFaults,
          e.r1TotalFaults, e.overallPlace, e.r1StatusCode || e.statusCode, now);
      }
      if (isJumper && (e.r2TotalTime || e.r2StatusCode)) {
        await upsertResult(env, entry.id, cls.id, 2,
          e.r2TotalTime, e.r2JumpFaults, e.r2TimeFaults,
          e.r2TotalFaults, e.overallPlace, e.r2StatusCode || e.statusCode, now);
      }
      if (isJumper && (e.r3TotalTime || e.r3StatusCode)) {
        await upsertResult(env, entry.id, cls.id, 3,
          e.r3TotalTime, e.r3JumpFaults, e.r3TimeFaults,
          e.r3TotalFaults, e.overallPlace, e.r3StatusCode || e.statusCode, now);
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

    // Auto-recompute classes with JO flag — if the class has live KV data,
    // re-run computeClassResults so the OOG populates immediately when the
    // operator sets the JO flag in tsked. Without this, the OOG wouldn't
    // show until the next .cls write.
    const joClasses = schedClasses.filter(sc => (sc.flag || '').toUpperCase() === 'JO');
    for (const sc of joClasses) {
      try {
        const liveKey = `live:${slug}:${ring}:${sc.classNum}`;
        const raw = await env.WEST_LIVE.get(liveKey);
        if (raw) {
          const body = JSON.parse(raw);
          const computed = computeClassResults(body);
          if (computed.orderOfGo && computed.orderOfGo.length) {
            const resultsKey = `results:${slug}:${ring}:${sc.classNum}`;
            await env.WEST_LIVE.put(resultsKey, JSON.stringify(computed), { expirationTtl: 7200 });
            console.log(`[writeSchedule] recomputed class ${sc.classNum} — OOG ${computed.orderOfGo.length} entries`);
          }
        }
      } catch (e) { /* best-effort recompute */ }
    }
  } catch(e) {
    console.error(`[writeSchedule ERROR] ${e.message}`);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
// ── PRE-SHOW STATS — cross-class data for OOG entries ────────────────────────
// For each horse in the order of go, query D1 for their results across all
// other classes at this show. Returns per-entry stats + class-level summary.
async function buildPreShowStats(env, slug, orderOfGo) {
  const show = await env.WEST_DB.prepare('SELECT id FROM shows WHERE slug = ?').bind(slug).first();
  if (!show) return null;

  // Get all horses from the OOG
  const horses = orderOfGo.map(e => e.horse).filter(Boolean);
  if (!horses.length) return null;

  // Query all results for these horses at this show
  // Using LIKE matching since horse names should be exact in the same show
  const placeholders = horses.map(() => '?').join(',');
  const results = await env.WEST_DB.prepare(`
    SELECT e.horse, e.rider, e.entry_num, e.country, e.sire, e.dam, e.city, e.state,
           c.class_num, c.class_name, c.class_type, c.scoring_method,
           r.round, r.time, r.jump_faults, r.time_faults, r.total, r.place, r.status_code
    FROM entries e
    JOIN classes c ON c.id = e.class_id
    LEFT JOIN results r ON r.entry_id = e.id
    WHERE c.show_id = ? AND e.horse IN (${placeholders}) AND c.class_type IN ('J','T')
    ORDER BY e.horse, c.class_num, r.round
  `).bind(show.id, ...horses).all();

  // Get prize money per class — parse @money from cls_raw
  const allClassNums = [...new Set((results.results || []).map(r => r.class_num))];
  const classPrizes = {};
  if (allClassNums.length) {
    const cp = allClassNums.map(() => '?').join(',');
    const clsRows = await env.WEST_DB.prepare(
      `SELECT class_num, cls_raw FROM classes WHERE show_id = ? AND class_num IN (${cp})`
    ).bind(show.id, ...allClassNums).all();
    (clsRows.results || []).forEach(row => {
      if (!row.cls_raw) return;
      const moneyLine = row.cls_raw.split(/\r?\n/).find(l => l.startsWith('@money'));
      if (moneyLine) {
        classPrizes[row.class_num] = moneyLine.split(',').slice(1).map(Number);
      }
    });
  }

  // Group by horse
  const byHorse = {};
  (results.results || []).forEach(row => {
    if (!byHorse[row.horse]) {
      byHorse[row.horse] = {
        horse: row.horse, rider: row.rider, entry_num: row.entry_num,
        country: row.country, sire: row.sire, dam: row.dam,
        city: row.city, state: row.state,
        classes: {},
      };
    }
    const h = byHorse[row.horse];
    if (!h.classes[row.class_num]) {
      h.classes[row.class_num] = {
        class_num: row.class_num, class_name: row.class_name,
        class_type: row.class_type, scoring_method: row.scoring_method,
        rounds: [],
      };
    }
    if (row.round) {
      h.classes[row.class_num].rounds.push({
        round: row.round, time: row.time, jump_faults: row.jump_faults,
        time_faults: row.time_faults, total: row.total,
        place: row.place, status_code: row.status_code,
      });
    }
  });

  // Build per-horse summary
  const entryStats = orderOfGo.map(oogEntry => {
    const h = byHorse[oogEntry.horse];
    if (!h) return { ...oogEntry, classCount: 0, clearRounds: 0, totalRounds: 0, clearPct: 0, results: [], breeding: '' };

    const classList = Object.values(h.classes);
    let clearRounds = 0, totalRounds = 0;
    const classResults = classList.map(cl => {
      const r1 = cl.rounds.find(r => r.round === 1);
      if (r1 && r1.total !== null) {
        totalRounds++;
        if (parseFloat(r1.total) === 0) clearRounds++;
      }
      const p = r1 && r1.place ? parseInt(r1.place) : 0;
      const cPrizes = classPrizes[cl.class_num] || [];
      const prize = (p > 0 && p <= cPrizes.length) ? cPrizes[p - 1] : 0;
      return {
        class_num: cl.class_num, class_name: cl.class_name, class_type: cl.class_type,
        place: r1 ? r1.place : null,
        faults: r1 ? r1.total : null,
        time: r1 ? r1.time : null,
        status: r1 ? r1.status_code : null,
        prize: prize,
      };
    });

    // Sort by best place (lowest first), take top 3
    const bestResults = classResults
      .filter(cr => !cr.status && cr.place)
      .sort((a, b) => (parseInt(a.place) || 999) - (parseInt(b.place) || 999))
      .slice(0, 3);

    // Total prize money won at the show
    const totalPrize = classResults.reduce((sum, cr) => sum + (cr.prize || 0), 0);

    const breeding = [h.sire, h.dam].filter(Boolean).join(' x ');
    return {
      ...oogEntry,
      breeding: breeding,
      city: h.city || oogEntry.city, state: h.state || oogEntry.state,
      classCount: classList.length,
      clearRounds: clearRounds,
      totalRounds: totalRounds,
      clearPct: totalRounds > 0 ? Math.round(clearRounds / totalRounds * 1000) / 10 : 0,
      totalPrize: totalPrize,
      results: bestResults,
    };
  });

  // Class-level summary
  const countries = {};
  orderOfGo.forEach(e => { if (e.country) countries[e.country] = (countries[e.country] || 0) + 1; });
  const uniqueRiders = new Set(orderOfGo.map(e => e.rider)).size;

  return {
    entryCount: orderOfGo.length,
    uniqueRiders: uniqueRiders,
    countries: Object.entries(countries).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    countryCount: Object.keys(countries).length,
    entries: entryStats,
  };
}

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

  // H[3] = NumRounds (1, 2, or 3). Ryegate max is 3.
  let numRounds = parseInt(h[3]) || 1;
  if (numRounds < 1) numRounds = 1;
  if (numRounds > 3) numRounds = 3;

  // H[4] = CurrentRound — which round tab the operator currently has selected
  // in Ryegate. 1/2/3 map to R1/R2/R3. Values > numRounds (e.g. 4 in a 3-round
  // class) mean the operator is on the "Overall" view; emit null in that case.
  let currentRound = parseInt(h[4]) || 0;
  if (currentRound < 1 || currentRound > numRounds) currentRound = null;

  // H[25]/H[26]/H[27] = phase labels. Custom labels are ONLY available on
  // Special classes in Ryegate — all other class types force "Phase 1"/"Phase 2"/
  // "Phase 3" defaults which we render as "R1"/"R2"/"R3". So we only emit
  // roundLabels when isSpecial is true; renderers fall back to R1/R2/R3 otherwise.
  const roundLabels = isSpecial
    ? [h[25] || 'R1', h[26] || 'R2', h[27] || 'R3']
    : null;

  return { classMode, isDerby, isFlat, isSpecial, isEquitation, isChampionship,
           scoringType, scoreMethod, judgeCount, numRounds, currentRound,
           roundLabels, label };
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
function hasR3(e) {
  if (e.r3TextStatus) return false;
  return e.r3 && e.r3.some(p => p.phaseTotal > 0);
}

function computeDerbyRankings(entries, judgeCount) {
  entries.forEach(e => {
    e.r1Ranks = []; e.r2Ranks = []; e.r3Ranks = [];
    e.judgeCardTotals = []; e.judgeCardRanks = [];
    e.r1OverallRank = null; e.r2OverallRank = null; e.r3OverallRank = null;
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

    items = entries.filter(hasR3).map(e => ({ key: e.entry_num, val: e.r3[j].phaseTotal }));
    ranks = assignRanks(items);
    entries.forEach(e => { e.r3Ranks[j] = ranks[e.entry_num] || null; });
  }

  // Judge card totals + ranks.
  // Per hunter rule "earlier rounds always hold" — if a later round is EL/RT/WD
  // the entry still keeps prior-round scores and competes for ribbons. So sum
  // whichever rounds are actually done. Null only when R1 never happened
  // (R1 elimination kills the entire card — earlier rounds don't exist).
  for (let j = 0; j < judgeCount; j++) {
    entries.forEach(e => {
      if (!hasR1(e)) { e.judgeCardTotals[j] = null; return; }
      let t = e.r1[j].phaseTotal;
      if (hasR2(e)) t += e.r2[j].phaseTotal;
      if (hasR3(e)) t += e.r3[j].phaseTotal;
      e.judgeCardTotals[j] = t;
    });
    const items = entries.filter(e => e.judgeCardTotals[j] !== null)
      .map(e => ({ key: e.entry_num, val: e.judgeCardTotals[j] }));
    const ranks = assignRanks(items);
    entries.forEach(e => { e.judgeCardRanks[j] = ranks[e.entry_num] || null; });
  }

  // R1/R2/R3 overall ranks (aggregate across judges)
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

  let r3Items = entries.filter(hasR3).map(e => {
    let sum = 0; for (let j = 0; j < judgeCount; j++) sum += e.r3[j].phaseTotal;
    return { key: e.entry_num, val: sum };
  });
  const r3Ranks = assignRanks(r3Items);

  entries.forEach(e => {
    e.r1OverallRank = r1Ranks[e.entry_num] || null;
    e.r2OverallRank = r2Ranks[e.entry_num] || null;
    e.r3OverallRank = r3Ranks[e.entry_num] || null;
    e.combinedRank = parseInt(e.place) || null;
    if (e.r1OverallRank && e.combinedRank && hasR2(e)) {
      e.movement = e.r1OverallRank - e.combinedRank;
    }
  });

  return entries;
}

// Split decision check — judges disagree on the placed top 3 entries.
// Compare each judge's top-N (by card total) against the overall placed
// top-N where N = min(3, number of entries the operator has actually placed).
// This avoids false positives mid-class when only some entries have been placed.
function isSplitDecision(entries, judgeCount) {
  if (judgeCount < 2) return false;

  // Overall placed entries, in place order
  const placed = entries
    .filter(e => parseInt(e.place) > 0)
    .sort((a, b) => parseInt(a.place) - parseInt(b.place));
  if (placed.length < 2) return false; // Need at least 2 placings to compare

  // Compare against top-N where N = min(3, placed.length). If the operator
  // has only placed 2, we compare top-2 — splits over the 3rd spot can't
  // be flagged until that 3rd ribbon exists.
  const N = Math.min(3, placed.length);
  const overallTopN = placed.slice(0, N).map(e => e.entry_num).sort().join(',');

  for (let j = 0; j < judgeCount; j++) {
    const sorted = entries
      .filter(e => e.judgeCardTotals && e.judgeCardTotals[j] != null && e.judgeCardTotals[j] > 0)
      .slice()
      .sort((a, b) => {
        const diff = (b.judgeCardTotals[j] || 0) - (a.judgeCardTotals[j] || 0);
        if (diff !== 0) return diff;
        // Tie-break by overall place to match final standings
        return (parseInt(a.place) || 999) - (parseInt(b.place) || 999);
      });
    const judgeTopN = sorted.slice(0, N).map(e => e.entry_num).sort().join(',');
    if (judgeTopN !== overallTopN) return true;
  }
  return false;
}

// ── COMPUTE CLASS RESULTS ────────────────────────────────────────────────────
// Main entry point. Takes the body from postClassData (parsed .cls + clsRaw).
// Returns a pre-computed results object ready for page rendering.

function computeClassResults(body) {
  const clsRaw = body.clsRaw || '';
  const h = parseClsHeader(clsRaw);
  // Watcher is authoritative on class type — it applies U→T inference from
  // scoring method / UDP hints. Prefer body.classType over raw header when
  // watcher has resolved a non-U type.
  const bodyType = (body.classType || '').toUpperCase();
  const headerType = (h[0] || '').toUpperCase();
  const classType = (bodyType && bodyType !== 'U') ? bodyType : (headerType || 'U');

  // Build Order of Go from ALL entries (regardless of hasGone), sorted by ride order.
  // Farmtek classes often have rideOrder=0 for all entries — fall back to .cls file
  // order (the sequence entries appear in the file IS the ride order).
  const allEntries = body.entries || [];
  const hasRideOrder = allEntries.some(e => parseInt(e.rideOrder) > 0);
  const oog = (hasRideOrder
    ? allEntries.filter(e => parseInt(e.rideOrder) > 0)
    : allEntries
  ).map((e, idx) => ({
      order: hasRideOrder ? (parseInt(e.rideOrder) || 0) : (idx + 1),
      entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
      owner: e.owner || '', country: e.country || '',
      city: e.city || '', state: e.state || '',
    }))
    .sort((a, b) => a.order - b.order);

  // Prize money: array indexed by place (0=1st, 1=2nd, etc.)
  const prizes = (body.prizes && body.prizes.length) ? body.prizes : null;

  const base = {
    classNum: (body.filename || '').replace('.cls', ''),
    className: body.className || h[1] || '',
    classType,
    sponsor: body.sponsor || '',
    trophy: body.trophy || '',
    orderOfGo: oog.length ? oog : null,
    hasRealOrder: hasRideOrder,
    prizes: prizes,
  };

  let result;
  if (classType === 'H') result = computeHunterResults(body, h, base);
  else if (classType === 'J' || classType === 'T') result = computeJumperResults(body, h, base);
  else {
    // Truly unformatted: watcher doesn't populate hasGone (no jumper/hunter
    // parsing runs), so only apply the hasGone filter if at least one entry
    // has it set. Otherwise fall through to showing all entries.
    const allEntries = body.entries || [];
    const anyGone = allEntries.some(e => e.hasGone);
    const filtered = anyGone ? allEntries.filter(e => e.hasGone) : allEntries;
    result = { ...base, label: 'Unformatted', entries: filtered.map(e => ({
      entry_num: e.entryNum, horse: e.horse, rider: e.rider, owner: e.owner,
      place: e.place || '', hasGone: e.hasGone,
    })) };
  }

  // Assign prize money per entry based on place
  if (prizes && result.entries) {
    result.entries.forEach(e => {
      const p = parseInt(e.place);
      if (p > 0 && p <= prizes.length) {
        e.prize = prizes[p - 1]; // prizes[0] = 1st place
      }
    });
  }

  return result;
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
    numRounds: info.numRounds,
    currentRound: info.currentRound,
    roundLabels: info.roundLabels,
    scoringType: info.scoringType,
    scoreMethod: info.scoreMethod,
    classMode: info.classMode,
    clockPrecision: parseInt(h[5]) || 0,
    showFlags: body.showFlags || false,
    isSplitDecision: false,
    entries: [],
  };

  // Numeric status map: 0=none, 1=DNS, 2=EL, 3=RT, 4=WD, 5=RF, 6=OC, 7=MR, 8=HC
  const numStatusMap = {'1':'DNS','2':'EL','3':'RT','4':'WD','5':'RF','6':'OC','7':'MR','8':'HC'};
  // Normalize text + numeric status into one canonical statusCode per round.
  // Used by both derby and non-derby paths (and the renderers downstream).
  const normalizeHunterStatus = (e) => {
    e.r1StatusCode = e.r1TextStatus || numStatusMap[e.r1NumericStatus] || '';
    e.r2StatusCode = e.r2TextStatus || numStatusMap[e.r2NumericStatus] || '';
    e.r3StatusCode = e.r3TextStatus || numStatusMap[e.r3NumericStatus] || '';
    e.statusCode = e.r3StatusCode || e.r2StatusCode || e.r1StatusCode || '';
  };

  if (info.isDerby) {
    // Parse per-judge data from cls rows
    const rows = parseClsRows(clsRaw);
    let entries = rows.map(r => parseDerbyEntry(r, info.judgeCount));
    entries.forEach(normalizeHunterStatus);
    entries = computeDerbyRankings(entries, info.judgeCount);
    result.isSplitDecision = isSplitDecision(entries, info.judgeCount);

    // Per-round competed counts. Same evidence-based rule as the non-derby
    // path: an entry counts as "gone" for a round if it has a real score on
    // that round OR a status code (EL/RT/etc.). Stuck hasGone flags alone
    // don't count. Derbies are 2-round in Ryegate so R3 is always 0 here.
    result.roundCompleted = [0, 0, 0];
    entries.forEach(e => {
      if (hasR1(e) || e.r1StatusCode) result.roundCompleted[0]++;
      if (hasR2(e) || e.r2StatusCode) result.roundCompleted[1]++;
      if (hasR3(e) || e.r3StatusCode) result.roundCompleted[2]++;
    });
    result.roundCompleted = result.roundCompleted.slice(0, info.numRounds);

    // Sort: placed first by place, then by combined desc
    entries.sort((a, b) => {
      const pa = parseInt(a.place) || 999, pb = parseInt(b.place) || 999;
      if (pa !== pb) return pa - pb;
      return (b.combined || 0) - (a.combined || 0);
    });

    result.entries = entries;
  } else if (info.scoringType === '1' || info.scoringType === '2') {
    // Non-derby scored hunter (scored or hi-lo) — watcher sends rN Judges arrays.
    // Build per-judge phase cards and compute rankings (same engine as derby).
    // Column map: R1=col[15+j], R2=col[24+j], R3=col[33+j] (confirmed 2026-04-08
    // for R1+R2 from class 1002, R3 confirmed 2026-04-10 from class 925 Special).
    // Special classes (H[2]=3) reuse this exact layout but support 1-3 rounds.
    const jc = info.judgeCount;
    const numRounds = info.numRounds || 2;
    let entries = (body.entries || []).filter(e => e.hasGone).map(e => {
      // Non-derby: phase cards are just { score, phaseTotal } — no hiopt/bonus fields.
      // The ABSENCE of hiopt/bonus tells the renderer to show score only.
      const buildPhases = (judgesArr) => {
        const arr = (judgesArr || []).map(v => {
          const s = parseFloat(v) || 0;
          return { score: s, phaseTotal: s };
        });
        while (arr.length < jc) arr.push({ score: 0, phaseTotal: 0 });
        return arr;
      };
      const r1 = buildPhases(e.r1Judges);
      const r2 = buildPhases(e.r2Judges);
      const r3 = buildPhases(e.r3Judges);

      const r1Total = parseFloat(e.r1Total) || 0;
      const r2Total = parseFloat(e.r2Total) || 0;
      const r3Total = parseFloat(e.r3Total) || 0;
      // Compute combined ourselves — col[45] is unreliable mid-class (only
      // accurate when operator views Overall in Ryegate). Sum the rounds we
      // actually have data for, capped by numRounds.
      let combined = r1Total;
      if (numRounds >= 2) combined += r2Total;
      if (numRounds >= 3) combined += r3Total;

      return {
        entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
        owner: e.owner || '', country: e.country || '',
        sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
        place: e.place || '',
        r1, r2, r3,
        r1Total, r2Total, r3Total,
        combined,
        r1NumericStatus: e.r1NumericStatus || '',
        r2NumericStatus: e.r2NumericStatus || '',
        r3NumericStatus: e.r3NumericStatus || '',
        r1TextStatus: e.r1TextStatus || '',
        r2TextStatus: e.r2TextStatus || '',
        r3TextStatus: e.r3TextStatus || '',
        hasGone: e.hasGone, statusCode: e.statusCode || '',
      };
    });

    // Normalize status codes (text + numeric → r1/r2/r3 StatusCode)
    entries.forEach(normalizeHunterStatus);

    // Normalize status codes (text + numeric → r1/r2/r3 StatusCode)
    entries.forEach(normalizeHunterStatus);

    // Compute per-judge rankings using the same engine as derby
    entries = computeDerbyRankings(entries, jc);
    result.isSplitDecision = isSplitDecision(entries, jc);

    // Per-round competed counts. Evidence-based: an entry counts as "gone"
    // for a round if it has a real score on that round OR a status code
    // (EL/RT/etc.). Stuck hasGone flags alone don't count.
    result.roundCompleted = [0, 0, 0];
    entries.forEach(e => {
      if (hasR1(e) || e.r1StatusCode) result.roundCompleted[0]++;
      if (hasR2(e) || e.r2StatusCode) result.roundCompleted[1]++;
      if (hasR3(e) || e.r3StatusCode) result.roundCompleted[2]++;
    });
    result.roundCompleted = result.roundCompleted.slice(0, numRounds);

    // Sort by place
    entries.sort((a, b) => {
      const pa = parseInt(a.place) || 999, pb = parseInt(b.place) || 999;
      if (pa !== pb) return pa - pb;
      return (b.combined || 0) - (a.combined || 0);
    });

    result.entries = entries;
  } else {
    // Forced/flat hunter (no scores) — only entries that competed
    result.entries = (body.entries || []).filter(e => e.hasGone).map(e => ({
      entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
      owner: e.owner || '', country: e.country || '',
      sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
      place: e.place || '', score: e.score || '',
      r1Total: e.r1Total || '', r2Total: e.r2Total || '',
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
  const isFaultsConverted = sm === '0';
  const optimumTime = isOptimum && ta.r1 > 0 ? ta.r1 - 4 : 0;

  // Build structured entries with all round data — only entries that competed
  const structured = entries.filter(e => e.hasGone).map(e => {
    // Table III: compute final time = clockTime + jumpFaults + penaltySeconds
    // Ryegate doesn't write the converted time to .cls, only sends it via UDP
    let r1FinalTime = e.r1TotalTime || e.r1Time || '';
    if (isFaultsConverted && r1FinalTime) {
      const clock = parseFloat(e.r1Time) || 0;
      const jf = parseFloat(e.r1JumpFaults) || 0;
      const ps = parseFloat(e.r1PenaltySec) || 0;
      r1FinalTime = (clock + jf + ps).toFixed(3);
    }
    return {
    entry_num: e.entryNum || '', horse: e.horse || '', rider: e.rider || '',
    owner: e.owner || '', country: e.country || '',
    sire: e.sire || '', dam: e.dam || '', city: e.city || '', state: e.state || '',
    place: e.overallPlace || e.place || '',
    rideOrder: parseInt(e.rideOrder) || 0,
    hasGone: e.hasGone, statusCode: e.statusCode || '',
    r1StatusCode: e.r1StatusCode || '', r2StatusCode: e.r2StatusCode || '',
    r1Time: e.r1Time || '', r1TotalTime: r1FinalTime,
    r1JumpFaults: e.r1JumpFaults || '0', r1TimeFaults: e.r1TimeFaults || '0',
    r1TotalFaults: e.r1TotalFaults || '0',
    r2Time: e.r2Time || '', r2TotalTime: e.r2TotalTime || '',
    r2JumpFaults: e.r2JumpFaults || '0', r2TimeFaults: e.r2TimeFaults || '0',
    r2TotalFaults: e.r2TotalFaults || '0',
    r3Time: e.r3Time || '', r3TotalTime: e.r3TotalTime || '',
    r3JumpFaults: e.r3JumpFaults || '0', r3TimeFaults: e.r3TimeFaults || '0',
    r3TotalFaults: e.r3TotalFaults || '0',
  }; });

  // ── Stats computation ──────────────────────────────────────────────────────
  const elimStatuses = ['EL','RF','HF','OC','WD','DNS','DNF','SC','RT'];
  const isElim = sc => elimStatuses.includes((sc || '').toUpperCase());
  const competed = structured.filter(e => e.hasGone);

  // Per-round stats builder
  function buildRoundStats(entries, rnd) {
    const fKey = `r${rnd}TotalFaults`, tKey = `r${rnd}TotalTime`, tfKey = `r${rnd}TimeFaults`, scKey = `r${rnd}StatusCode`;
    const valid = entries.filter(e => e[tKey] && !isElim(e[scKey]) && !isElim(e.statusCode));
    if (!valid.length) return null;
    const elim = entries.filter(e => e[tKey] && (isElim(e[scKey]) || isElim(e.statusCode)));
    const faults = valid.map(e => parseFloat(e[fKey]) || 0);
    const times = valid.map(e => parseFloat(e[tKey]) || 0).filter(t => t > 0);
    const clearCount = faults.filter(f => f === 0).length;
    const avgFaults = faults.length ? faults.reduce((a, b) => a + b, 0) / faults.length : 0;
    const timeFaultCount = valid.filter(e => parseFloat(e[tfKey]) > 0).length;
    const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const clearTimes = valid.filter(e => parseFloat(e[fKey]) === 0).map(e => parseFloat(e[tKey]) || 0).filter(t => t > 0);
    const avgClearTime = clearTimes.length ? clearTimes.reduce((a, b) => a + b, 0) / clearTimes.length : 0;

    // Fault buckets
    const faultBuckets = [];
    const faultSet = {};
    faults.forEach(f => { faultSet[f] = true; });
    Object.keys(faultSet).map(Number).sort((a, b) => a - b).filter(f => f <= 8).forEach(f => {
      faultBuckets.push({ label: f + ' faults', value: f, count: faults.filter(x => x === f).length });
    });
    const mid = faults.filter(f => f >= 9 && f <= 11);
    if (mid.length) faultBuckets.push({ label: '9-11 faults', value: 'mid', count: mid.length });
    const high = faults.filter(f => f >= 12);
    if (high.length) faultBuckets.push({ label: '12+ faults', value: 'high', count: high.length });
    if (elim.length) faultBuckets.push({ label: 'Eliminated', value: 'elim', count: elim.length });

    // Fastest 4-fault
    const f4 = valid.filter(e => parseFloat(e[fKey]) === 4);
    let fastest4Fault = null;
    if (f4.length) {
      const best = f4.reduce((b, e) => {
        const t = parseFloat(e[tKey]) || 999;
        return t < (b.time || 999) ? { entry_num: e.entry_num, horse: e.horse, rider: e.rider, time: t } : b;
      }, { time: 999 });
      if (best.entry_num) fastest4Fault = best;
    }

    // Leaderboard
    const leaderboard = valid.slice().sort((a, b) => {
      const fa = parseFloat(a[fKey]) || 0, fb = parseFloat(b[fKey]) || 0;
      if (fa !== fb) return fa - fb;
      return (parseFloat(a[tKey]) || 0) - (parseFloat(b[tKey]) || 0);
    });
    const leaderTime = leaderboard.length ? (parseFloat(leaderboard[0][tKey]) || 0) : 0;
    const leaderFaults = leaderboard.length ? (parseFloat(leaderboard[0][fKey]) || 0) : 0;
    const leaderboardWithGap = leaderboard.map((e, i) => {
      const f = parseFloat(e[fKey]) || 0;
      const t = parseFloat(e[tKey]) || 0;
      let gap = '';
      if (i > 0) {
        if (f > leaderFaults) gap = '+' + (f - leaderFaults) + ' flt';
        else if (t > leaderTime) gap = '+' + (t - leaderTime).toFixed(3) + 's';
      }
      return { ...e, rank: i + 1, gap };
    });

    return {
      total: valid.length,
      eliminated: elim.length,
      clearRounds: clearCount,
      clearPct: faults.length ? Math.round(clearCount / faults.length * 1000) / 10 : 0,
      avgFaults: Math.round(avgFaults * 100) / 100,
      timeFaultCount,
      avgTime: Math.round(avgTime * 1000) / 1000,
      avgClearTime: Math.round(avgClearTime * 1000) / 1000,
      faultBuckets,
      fastest4Fault,
      leaderboard: leaderboardWithGap,
    };
  }

  const r1Stats = buildRoundStats(competed, 1);
  const r2Stats = buildRoundStats(competed, 2);
  const r3Stats = buildRoundStats(competed, 3);

  return {
    ...base,
    label: 'Jumper',
    scoringMethod: sm,
    clockPrecision,
    showFlags: body.showFlags || false,
    ta,
    isOptimum,
    isFaultsConverted: sm === '0',
    optimumTime,
    entries: structured,
    stats: {
      totalEntries: structured.length,
      competed: competed.length,
      eliminated: r1Stats ? r1Stats.eliminated : 0,
      // Legacy R1 fields for backward compat
      clearRounds: r1Stats ? r1Stats.clearRounds : 0,
      clearPct: r1Stats ? r1Stats.clearPct : 0,
      avgFaults: r1Stats ? r1Stats.avgFaults : 0,
      timeFaultCount: r1Stats ? r1Stats.timeFaultCount : 0,
      avgTime: r1Stats ? r1Stats.avgTime : 0,
      avgClearTime: r1Stats ? r1Stats.avgClearTime : 0,
      faultBuckets: r1Stats ? r1Stats.faultBuckets : [],
      fastest4Fault: r1Stats ? r1Stats.fastest4Fault : null,
      leaderboard: r1Stats ? r1Stats.leaderboard : [],
      // Per-round stats
      r1: r1Stats,
      r2: r2Stats,
      r3: r3Stats,
    },
  };
}
