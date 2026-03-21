/**
 * WEST Scoring Live — Worker 2.0
 * Handles live class data and UDP events from west-watcher.js
 * Stores in KV for website consumption
 *
 * KV Namespace: WEST_LIVE (bound as env.WEST_LIVE)
 *
 * ENDPOINTS:
 *   POST /postClassData   — watcher posts .cls standings on every change
 *   POST /postUdpEvent    — watcher posts UDP events (RIDE_START, FAULT etc)
 *   POST /heartbeat       — watcher alive signal every 60s
 *   GET  /getLiveClass    — website polls for live class + event data
 *   GET  /ping            — health check
 */

const AUTH_KEY_NAME = 'X-West-Key';

// ── CORS HEADERS ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ── AUTH ──────────────────────────────────────────────────────────────────────
function isAuthed(request, env) {
  const key = request.headers.get(AUTH_KEY_NAME);
  return key && key === env.WEST_AUTH_KEY;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET /ping ─────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/ping') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    // ── POST /postClassData ───────────────────────────────────────────────────
    // Watcher posts full .cls standings JSON on every file change
    if (method === 'POST' && path === '/postClassData') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);

      let body;
      try { body = await request.json(); }
      catch(e) { return err('Invalid JSON'); }

      const { slug, ring } = extractSlugRing(body, url);
      if (!slug || !ring) return err('Missing slug or ring');

      const key = `live:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(body), { expirationTtl: 7200 });

      console.log(`[postClassData] ${key} — ${body.competed}/${body.numEntries} competed`);
      return json({ ok: true, key });
    }

    // ── POST /postUdpEvent ────────────────────────────────────────────────────
    // Watcher posts each UDP event — only latest matters, overwrites previous
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
    // Watcher alive signal — TTL 120s so we know if watcher goes offline
    if (method === 'POST' && path === '/heartbeat') {
      if (!isAuthed(request, env)) return err('Unauthorized', 401);

      let body;
      try { body = await request.json(); }
      catch(e) { body = {}; }

      const slug = url.searchParams.get('slug') || body.slug || 'unknown';
      const ring = url.searchParams.get('ring') || body.ring || '1';

      const payload = {
        ts:      new Date().toISOString(),
        slug,
        ring,
        version: body.version || '2.0',
      };

      const key = `heartbeat:${slug}:${ring}`;
      await env.WEST_LIVE.put(key, JSON.stringify(payload), { expirationTtl: 120 });

      console.log(`[heartbeat] ${key}`);
      return json({ ok: true });
    }

    // ── GET /getLiveClass ─────────────────────────────────────────────────────
    // Website polls this — returns class standings + latest UDP event
    if (method === 'GET' && path === '/getLiveClass') {
      const slug = url.searchParams.get('slug');
      const ring = url.searchParams.get('ring') || '1';

      if (!slug) return err('Missing slug');

      const [classRaw, eventRaw, heartbeatRaw] = await Promise.all([
        env.WEST_LIVE.get(`live:${slug}:${ring}`),
        env.WEST_LIVE.get(`event:${slug}:${ring}`),
        env.WEST_LIVE.get(`heartbeat:${slug}:${ring}`),
      ]);

      const classData    = classRaw    ? JSON.parse(classRaw)    : null;
      const latestEvent  = eventRaw    ? JSON.parse(eventRaw)    : null;
      const heartbeat    = heartbeatRaw? JSON.parse(heartbeatRaw): null;
      const watcherAlive = !!heartbeat;

      return json({
        ok: true,
        classData,
        latestEvent,
        watcherAlive,
        heartbeatTs: heartbeat?.ts || null,
        ts: new Date().toISOString(),
      });
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    return err('Not found', 404);
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Extract slug and ring from the posted class data body or URL params
// Slug comes from config.dat FTP path, ring from /r1 /r2 etc
function extractSlugRing(body, url) {
  // Try URL params first (watcher can pass as query string)
  let slug = url.searchParams.get('slug');
  let ring = url.searchParams.get('ring');

  // Fall back to body fields
  if (!slug) slug = body.slug || null;
  if (!ring) ring = body.ring || (body.liveState && body.liveState.ring) || '1';

  return { slug, ring };
}
