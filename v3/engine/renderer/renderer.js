// WEST Engine renderer — vanilla JS. Subscribes to state pushes from main
// process via window.westEngine (set up in preload.js with contextBridge).
//
// Main → renderer state pushes:
//   westEngine.onState(handler)   — fires on every state change in main
//
// Renderer → main calls (return promises):
//   westEngine.fetchShows()           → list of shows from worker (filtered)
//   westEngine.fetchRings(slug)       → list of rings for a show
//   westEngine.switchShow(slug, ring) → main writes config, restarts watchers
//   westEngine.repostCls()            → toast result
//   westEngine.repostTsked()          → toast result
//   westEngine.toggleForwarding()     → returns new paused state
//   westEngine.openLog()              — open log folder
//   westEngine.openAdmin()            — open admin URL in default browser
//   westEngine.minimizeToTray()       — hide window
//
// All DOM updates are idempotent — render() reads state and rewrites
// affected nodes without diffing. Cheap at this state size.

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // Local cache of last state for stat formatting "Xs ago"-style fields.
  let lastState = null;

  function fmtAgo(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 0) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's ago';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm ago';
  }

  function fmtUptime(secs) {
    if (!secs && secs !== 0) return '—';
    if (secs < 60) return secs + 's';
    const m = Math.floor(secs / 60);
    if (m < 60) return m + 'm ' + (secs % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function setDot(el, level) {
    el.classList.remove('ok', 'warn', 'fail', 'idle');
    el.classList.add(level || 'idle');
  }

  // Settings fields the user can edit. Tracked separately from state so
  // unsaved edits aren't blown away by an incoming state push. Only paths
  // are editable — ports are auto-detected from Ryegate's config.dat.
  let settingsDirty = false;

  function populateSettings(settings) {
    if (!settings) return;
    if (!settingsDirty) {
      $('#setClsDir').value       = settings.clsDir          || '';
      $('#setTskedPath').value    = settings.tskedPath       || '';
      $('#setRyegateConf').value  = settings.ryegateConfPath || '';
    }
    // Read-only fields refresh on every state push (auto-detected values).
    $('#setInputPort').value    = settings.inputPort    || '';
    $('#setRsserverPort').value = settings.rsserverPort || '';
    $('#setFocusPort').value    = settings.focusPort    || '';
    $('#setWorkerUrl').value    = settings.workerUrl    || '';
    $('#setAuthKey').value      = settings.authKey      || '';
    // Scoreboard tab — same auto-detected values as Settings tab.
    $('#sbInputPort').textContent    = settings.inputPort    || '—';
    $('#sbRsserverPort').textContent = settings.rsserverPort || '—';
    // Protocol tab — show which port we'd be listening on.
    const protoIn = document.getElementById('protoInputPort');
    if (protoIn) protoIn.textContent = settings.inputPort || '—';
  }

  // Per-feature in-flight set. A state push that arrives while we're still
  // waiting for saveFeature() to resolve must NOT overwrite the checkbox —
  // the in-flight save's value is the truth, not whatever main has pushed
  // (which was sampled before writeConfig completed).
  const featureSaveInFlight = new Set();

  function populateFeatures(features) {
    if (!features) return;
    if (!featureSaveInFlight.has('runningTenth')) {
      $('#featRunningTenth').checked = !!features.runningTenth;
    }
    if (!featureSaveInFlight.has('holdTarget')) {
      $('#featHoldTarget').checked = !!features.holdTarget;
    }
    if (!featureSaveInFlight.has('liveRunningTenth')) {
      $('#featLiveRunningTenth').checked = !!features.liveRunningTenth;
    }
  }

  function markSettingsDirty() {
    settingsDirty = true;
    const el = $('#settingsStatus');
    el.textContent = '● unsaved changes';
    el.className = 'settings-status dirty';
  }

  function clearSettingsStatus() {
    settingsDirty = false;
    const el = $('#settingsStatus');
    el.textContent = '';
    el.className = 'settings-status';
  }

  function render(state) {
    lastState = state;

    // Top bar — show / ring identity
    const showRing = state.config && state.config.showSlug
      ? `${state.config.showSlug} · Ring ${state.config.ringNum}`
      : '— not selected —';
    $('#currentShowRing').textContent = showRing;

    // Connection dots
    setDot($('#dotWorker'),
      !state.config ? 'idle'
      : state.lastHeartbeatAt && state.lastHeartbeatOk ? 'ok'
      : state.lastHeartbeatAt ? 'fail'
      : 'idle');
    setDot($('#dotRsserver'), state.rsserverConnected ? 'ok' : 'idle');  // wire up when UDP forwarding lands
    setDot($('#dotUdp'), state.udpListening ? 'ok' : 'idle');           // wire up when UDP listener binds

    // Banners
    $('#emptyBanner').hidden = !!state.config;
    $('#lockBanner').hidden = !state.showLocked;
    $('#pausedBanner').hidden = !state.liveScoringPaused;

    // Top-bar pause button — flips label + style when paused
    const pauseBtn = $('#btnPauseLive');
    pauseBtn.classList.toggle('is-paused', !!state.liveScoringPaused);
    pauseBtn.querySelector('.btn-pause-icon').textContent = state.liveScoringPaused ? '▶' : '⏸';
    pauseBtn.querySelector('.btn-pause-text').textContent =
      state.liveScoringPaused ? 'Resume live scoring' : 'Pause live scoring';

    // Current focus pane (empty until 31000 fires)
    const focusBody = $('#focusBody');
    if (state.currentFocus) {
      focusBody.classList.add('has-focus');
      focusBody.innerHTML = `
        <div class="focus-class-num">${escapeHtml(state.currentFocus.classId || '?')}</div>
        <div class="focus-id">
          <span class="focus-class-name">${escapeHtml(state.currentFocus.className || '—')}</span>
          <span class="focus-meta">${escapeHtml(state.currentFocus.meta || '')}</span>
        </div>
        <div class="focus-when">${fmtAgo(state.currentFocus.at)}</div>`;
    } else {
      focusBody.classList.remove('has-focus');
      focusBody.innerHTML = '<div class="focus-empty">No focus signal received yet.</div>';
    }

    // Status grid
    if (state.lastHeartbeatAt) {
      const heartbeatEl = $('#statHeartbeat');
      heartbeatEl.textContent = state.lastHeartbeatOk
        ? `${state.heartbeatCount} ok · ${fmtAgo(state.lastHeartbeatAt)}`
        : `failing · ${fmtAgo(state.lastHeartbeatAt)}`;
      heartbeatEl.className = 'stat-val ' + (state.lastHeartbeatOk ? 'ok' : 'fail');
    } else {
      const heartbeatEl = $('#statHeartbeat');
      heartbeatEl.textContent = 'starting…';
      heartbeatEl.className = 'stat-val idle';
    }

    $('#statClsPosts').textContent = state.config
      ? `${state.clsPostCount} ok · ${state.clsPostFailCount} failed`
      : '—';
    $('#statTskedPosts').textContent = state.config
      ? `${state.tskedPostCount} ok · ${state.tskedSkipCount} skip`
      : '—';
    $('#statUdpFrames').textContent = state.udpFrameCount != null
      ? `${state.udpFrameCount} parsed`
      : '— (not yet)';
    $('#statLastUdp').textContent = fmtAgo(state.lastUdpAt);
    $('#statLastFocus').textContent = fmtAgo(state.lastFocusAt);

    // Recent events (last 50)
    const eventsBody = $('#eventsBody');
    if (state.recentEvents && state.recentEvents.length) {
      eventsBody.classList.add('has-events');
      eventsBody.innerHTML = state.recentEvents.map(ev =>
        `<div class="event-row">
          <span class="event-time">${escapeHtml(formatClock(ev.at))}</span>
          <span class="event-type ${escapeHtml(ev.type)}">${escapeHtml(ev.type)}</span>
          <span class="event-detail">${escapeHtml(ev.detail || '')}</span>
        </div>`
      ).join('');
    } else {
      eventsBody.classList.remove('has-events');
      eventsBody.innerHTML = '<div class="events-empty">No events yet.</div>';
    }

    // Manual controls — Scoreboard tab forwarding pause (separate from
    // the top-bar live-scoring pause).
    const fwdBtn = $('#btnPauseForwarding');
    fwdBtn.classList.toggle('is-active', !!state.forwardingPaused);
    fwdBtn.textContent = state.forwardingPaused ? '▶ Resume forwarding' : '⏸ Pause forwarding';

    // Disable controls when no show selected (no point reposting nothing)
    const noShow = !state.config;
    $('#btnRepostCls').disabled = noShow;
    $('#btnRepostTsked').disabled = noShow;
    $('#btnPauseForwarding').disabled = noShow;

    // Footer
    $('#footerVersion').textContent = state.engineVersion || '—';
    $('#footerUptime').textContent = fmtUptime(state.uptimeSeconds);
    const authEl = $('#footerAuth');
    if (state.authStatus === 'fail') {
      authEl.textContent = '🔓 unauthed';
      authEl.classList.add('fail');
    } else {
      authEl.textContent = '🔐 authed';
      authEl.classList.remove('fail');
    }

    // Settings — only refresh editable fields when not dirty so we don't
    // blow away unsaved edits. Read-only fields refresh always.
    populateSettings(state.settings);

    // Scoreboard feature toggles
    populateFeatures(state.features);

    // Frame samples — update if changed AND no proto-edit field is focused
    // (don't yank the cursor out of an in-progress description).
    if (state.frameSamples) {
      const incoming = JSON.stringify(state.frameSamples);
      const previous = JSON.stringify(frameSamples);
      if (incoming !== previous) {
        frameSamples = state.frameSamples;
        const editing = document.activeElement &&
          document.activeElement.classList &&
          document.activeElement.classList.contains('proto-edit');
        if (!editing) renderProtocolMap();
      }
    }
  }

  // Cheap per-second tick for "Xs ago" labels — main pushes state on
  // change but timestamps need to keep moving without a state push.
  setInterval(() => { if (lastState) render(lastState); }, 1000);

  function formatClock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Show picker modal ──────────────────────────────────────────────────
  const dlg = $('#dlgPicker');
  const pkShow = $('#pkShow');
  const pkRing = $('#pkRing');
  const pkError = $('#pkError');

  function setPickerSubmitEnabled() {
    const ok = pkShow.value && pkRing.value && !pkRing.disabled;
    $('#btnPickerSave').disabled = !ok;
  }

  async function openPicker() {
    pkError.hidden = true;
    pkShow.innerHTML = '<option value="">Loading…</option>';
    pkRing.innerHTML = '<option value="">Pick a show first</option>';
    pkRing.disabled = true;
    setPickerSubmitEnabled();
    dlg.showModal();
    try {
      const shows = await window.westEngine.fetchShows();
      if (!shows.length) {
        // Empty state — explain WHY and where to go.
        pkShow.innerHTML = '<option value="">— no unlocked shows —</option>';
        pkError.innerHTML = 'No unlocked shows are visible to the engine. ' +
          '<a href="#" id="pkErrAdmin">Open admin →</a> to add a show, ' +
          'or flip <code>lock_override</code> to <em>unlocked</em> on an existing show.';
        pkError.hidden = false;
        const adminLink = document.getElementById('pkErrAdmin');
        if (adminLink) {
          adminLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.westEngine.openAdmin();
          });
        }
        setPickerSubmitEnabled();
        return;
      }
      const cur = lastState && lastState.config && lastState.config.showSlug;
      pkShow.innerHTML = shows.map(s =>
        `<option value="${escapeHtml(s.slug)}" ${s.slug === cur ? 'selected' : ''}>${escapeHtml(s.name)} · ${escapeHtml(s.slug)}${s.engine_live ? ' 🟢' : ''}</option>`
      ).join('');
      // Auto-load rings for the selected show
      await loadRings(pkShow.value);
    } catch (e) {
      pkError.textContent = 'Failed to fetch shows: ' + e.message;
      pkError.hidden = false;
      setPickerSubmitEnabled();
    }
  }

  async function loadRings(slug) {
    if (!slug) {
      pkRing.innerHTML = '<option value="">Pick a show first</option>';
      pkRing.disabled = true;
      setPickerSubmitEnabled();
      return;
    }
    pkRing.innerHTML = '<option value="">Loading…</option>';
    pkRing.disabled = true;
    setPickerSubmitEnabled();
    try {
      const rings = await window.westEngine.fetchRings(slug);
      if (!rings.length) {
        pkRing.innerHTML = '<option value="">No rings on this show</option>';
        setPickerSubmitEnabled();
        return;
      }
      const curRing = lastState && lastState.config && lastState.config.ringNum;
      const curSlug = lastState && lastState.config && lastState.config.showSlug;
      pkRing.innerHTML = rings.map(r =>
        `<option value="${r.ring_num}" ${(slug === curSlug && r.ring_num === curRing) ? 'selected' : ''}>Ring ${r.ring_num}${r.name ? ' · ' + escapeHtml(r.name) : ''}</option>`
      ).join('');
      pkRing.disabled = false;
      setPickerSubmitEnabled();
    } catch (e) {
      pkError.textContent = 'Failed to fetch rings: ' + e.message;
      pkError.hidden = false;
      setPickerSubmitEnabled();
    }
  }

  pkShow.addEventListener('change', () => loadRings(pkShow.value));
  pkRing.addEventListener('change', setPickerSubmitEnabled);

  // Click outside the dialog (on the backdrop) closes it. Native <dialog>
  // already handles ESC; backdrop-click has to be wired manually.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });

  $('#btnSwitchShow').addEventListener('click', openPicker);
  $('#btnSwitchFromLock').addEventListener('click', openPicker);
  $('#btnSwitchFromEmpty').addEventListener('click', openPicker);

  $('#btnPickerCancel').addEventListener('click', () => dlg.close());
  $('#btnPickerSave').addEventListener('click', async () => {
    const slug = pkShow.value;
    const ring = parseInt(pkRing.value, 10);
    if (!slug) { pkError.textContent = 'Pick a show.'; pkError.hidden = false; return; }
    if (!Number.isFinite(ring)) { pkError.textContent = 'Pick a ring.'; pkError.hidden = false; return; }
    const sameAsCurrent = lastState && lastState.config &&
      lastState.config.showSlug === slug && lastState.config.ringNum === ring;
    if (!sameAsCurrent) {
      const confirmed = confirm(`Switch engine to:\n\n${slug} · Ring ${ring}\n\nThis changes which show + ring receives UDP forwarding and .cls posts.`);
      if (!confirmed) return;
    }
    try {
      await window.westEngine.switchShow(slug, ring);
      dlg.close();
    } catch (e) {
      pkError.textContent = 'Switch failed: ' + e.message;
      pkError.hidden = false;
    }
  });

  // ── Manual control buttons ─────────────────────────────────────────────
  $('#btnRepostCls').addEventListener('click', async () => {
    const btn = $('#btnRepostCls');
    btn.disabled = true;
    btn.textContent = '↻ Reposting…';
    try {
      const res = await window.westEngine.repostCls();
      btn.textContent = `✓ ${res.ok} ok · ${res.failed} failed`;
      setTimeout(() => { btn.textContent = '↻ Re-post all .cls'; btn.disabled = false; }, 2400);
    } catch (e) {
      btn.textContent = '✗ ' + e.message;
      setTimeout(() => { btn.textContent = '↻ Re-post all .cls'; btn.disabled = false; }, 3000);
    }
  });

  $('#btnRepostTsked').addEventListener('click', async () => {
    const btn = $('#btnRepostTsked');
    btn.disabled = true;
    btn.textContent = '↻ Reposting…';
    try {
      const res = await window.westEngine.repostTsked();
      btn.textContent = res.ok ? '✓ posted' : '✗ ' + (res.error || 'failed');
      setTimeout(() => { btn.textContent = '↻ Re-post tsked'; btn.disabled = false; }, 2400);
    } catch (e) {
      btn.textContent = '✗ ' + e.message;
      setTimeout(() => { btn.textContent = '↻ Re-post tsked'; btn.disabled = false; }, 3000);
    }
  });

  $('#btnPauseForwarding').addEventListener('click', async () => {
    try { await window.westEngine.toggleForwarding(); } catch (e) {}
  });

  $('#btnOpenLog').addEventListener('click', () => window.westEngine.openLog());
  $('#btnOpenAdmin').addEventListener('click', () => window.westEngine.openAdmin());

  // ── Tabs — vanilla single-tab visibility toggle ─────────────────────────
  // Always open on Status. Operator's last-used tab does NOT persist across
  // engine launches — Status is the operational dashboard, that's where
  // someone should land when they re-open the window.
  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(t =>
      t.classList.toggle('is-active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach(p =>
      p.hidden = p.dataset.tab !== name);
  }
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => activateTab(t.dataset.tab)));
  activateTab('status');

  // When main brings the window back from tray, reset to Status.
  if (window.westEngine.onWindowShown) {
    window.westEngine.onWindowShown(() => activateTab('status'));
  }

  // ── Top-bar pause-live button ──────────────────────────────────────────
  $('#btnPauseLive').addEventListener('click', async () => {
    try { await window.westEngine.toggleLiveScoring(); } catch (e) {}
  });
  $('#btnResumeFromBanner').addEventListener('click', async () => {
    try { await window.westEngine.toggleLiveScoring(); } catch (e) {}
  });

  // ── Scoreboard tab — feature toggles + forwarding pause ────────────────
  function wireFeatureToggle(id, key) {
    document.getElementById(id).addEventListener('change', async (e) => {
      const statusEl = $('#sbFeaturesStatus');
      statusEl.textContent = 'saving…';
      statusEl.className = 'settings-status';
      featureSaveInFlight.add(key);
      try {
        const res = await window.westEngine.saveFeature(key, e.target.checked);
        if (!res.ok) throw new Error(res.error);
        statusEl.textContent = '✓ saved';
        statusEl.className = 'settings-status ok';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'settings-status'; }, 1800);
      } catch (err) {
        statusEl.textContent = '✗ ' + err.message;
        statusEl.className = 'settings-status fail';
        // Save failed — DO revert to the last-known-good main state.
        featureSaveInFlight.delete(key);
        if (lastState && lastState.features) populateFeatures(lastState.features);
        return;
      }
      // Hold the lock briefly so a state push that was in flight at save
      // time doesn't clobber the just-saved value. The push that was
      // SCHEDULED post-save will arrive within a state-throttle window
      // and reflect the new value; after that we can release.
      setTimeout(() => featureSaveInFlight.delete(key), 600);
    });
  }
  wireFeatureToggle('featRunningTenth',     'runningTenth');
  wireFeatureToggle('featHoldTarget',       'holdTarget');
  wireFeatureToggle('featLiveRunningTenth', 'liveRunningTenth');

  // ── Settings inputs — dirty-track + Save / Revert ──────────────────────
  ['setClsDir', 'setTskedPath', 'setRyegateConf'].forEach(id => {
    document.getElementById(id).addEventListener('input', markSettingsDirty);
  });

  $('#btnSettingsRevert').addEventListener('click', () => {
    if (!lastState || !lastState.settings) return;
    settingsDirty = false;       // bypass the dirty-guard
    populateSettings(lastState.settings);
    clearSettingsStatus();
  });

  $('#btnSettingsSave').addEventListener('click', async () => {
    const patch = {
      clsDir:          $('#setClsDir').value.trim(),
      tskedPath:       $('#setTskedPath').value.trim(),
      ryegateConfPath: $('#setRyegateConf').value.trim(),
    };
    const statusEl = $('#settingsStatus');
    statusEl.textContent = 'saving…';
    statusEl.className = 'settings-status';
    try {
      const res = await window.westEngine.saveSettings(patch);
      if (!res.ok) {
        statusEl.textContent = '✗ ' + res.error;
        statusEl.className = 'settings-status fail';
        return;
      }
      statusEl.textContent = '✓ saved';
      statusEl.className = 'settings-status ok';
      settingsDirty = false;
      setTimeout(() => clearSettingsStatus(), 2400);
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.className = 'settings-status fail';
    }
  });

  // Main asks us to open the picker on first-run (no show selected yet).
  if (window.westEngine.onOpenPicker) {
    window.westEngine.onOpenPicker(() => openPicker());
  }

  // ── Protocol tab — Ryegate frame map (static reference) ───────────────
  // Sourced from docs/v3-planning/UDP-PROTOCOL-REFERENCE.md. Update both
  // when frame knowledge changes — the doc is the truth, this is a render.
  // tagFmt is "{N} desc" pairs. status: 'mapped' | 'ignored' | 'unknown'.
  const FRAMES_CHANNEL_A = [
    { fr: 0, name: 'Clear scoreboard', lens: 'both', purpose: 'Operator blanked the scoreboard display.', status: 'mapped',
      tags: [{ n: 1, d: 'entry number (often empty)' }] },
    { fr: 1, name: 'Jumper packet', lens: 'jumper', purpose: 'All live jumper scoring data at ~1Hz. THE only frame jumper classes use.', status: 'mapped',
      tags: [
        { n: 1,  d: 'entry number' },
        { n: 2,  d: 'horse name' },
        { n: 3,  d: 'rider name' },
        { n: 4,  d: 'owner name (confirmed S42 2026-05-02)' },
        { n: 5,  d: 'NAT — 3-letter country code (confirmed S42 2026-05-02)' },
        { n: 8,  d: 'rank/place — FINISH signal (strip "RANK" prefix)' },
        { n: 13, d: 'time allowed TA (strip "TA:" prefix)' },
        { n: 14, d: 'jump faults (strip "JUMP" prefix). Equitation: text "TIME"' },
        { n: 15, d: 'time faults (strip "TIME" prefix). Equitation: text "FLTS"' },
        { n: 17, d: 'elapsed seconds — ONCOURSE signal. Numeric only when {fr}=1. Equitation DISPLAY_SCORES: equitation score, not elapsed.' },
        { n: 18, d: 'TTB — time to beat. Disappears mid-round; HOLD target re-injects.' },
        { n: 19, d: 'equitation score (Method 7 / Timed Equitation). Authoritative on jumper-side; frame 1 still carries jumper protocol.' },
        { n: 23, d: 'countdown — CD signal (negative, e.g. "-44")' },
      ] },
    { fr: '2–10', name: 'Reserved / unused', lens: 'both', purpose: 'Never observed at any show through Culpeper 2026.', status: 'unknown',
      tags: [] },
    { fr: 11, name: 'Hunter intro / on course', lens: 'hunter', purpose: 'Horse goes on course. Cycles three pages (A/B/C) at fr=11. NEW: Ryegate is adding INTRO-click → 31000 trigger to match hunters.', status: 'mapped',
      tags: [
        { n: 1,  d: 'entry number' },
        { n: 2,  d: 'horse name (Page A/B); empty in equitation' },
        { n: 3,  d: 'rider name (Page A); empty on Page C' },
        { n: 4,  d: 'owner name (Page A)' },
        { n: 6,  d: 'city, state — equitation Page C only' },
        { n: 7,  d: 'rider name in EQ (NOT {3})' },
        { n: 14, d: 'class HIGH score (Page A; not this horse)' },
        { n: 17, d: 'scoreboard message — NEVER elapsed at fr=11' },
        { n: 18, d: 'sire name (Page B)' },
        { n: 19, d: '"X" filler (Page B)' },
        { n: 20, d: 'dam name (Page B)' },
      ] },
    { fr: 12, name: 'Hunter display scores', lens: 'hunter', purpose: 'Operator pressed Display Scores (non-derby scored).', status: 'mapped',
      tags: [
        { n: 1,  d: 'entry number' },
        { n: 2,  d: 'horse name' },
        { n: 3,  d: 'rider name' },
        { n: 8,  d: 'RANK: place (strip prefix)' },
        { n: 14, d: 'T: total score (strip "T:" prefix)' },
        { n: '21+', d: 'per-judge scores ("1: 78.00", "2: 80.00", …)' },
      ] },
    { fr: 13, name: 'Hunter standings', lens: 'hunter', purpose: 'Between-rounds standings view. Tags not mapped; .cls is authoritative.', status: 'ignored',
      tags: [] },
    { fr: 14, name: 'Hunter ribbons / results', lens: 'hunter', purpose: 'Operator clicks through ribbons one entry at a time. Engine accumulates HUNTER_RESULT events.', status: 'mapped',
      tags: [
        { n: 1, d: 'entry number' },
        { n: 2, d: 'horse name' },
        { n: 3, d: 'rider name' },
        { n: 4, d: 'owner name' },
        { n: 8, d: 'place text ("1st" / "2nd" / …)' },
        { n: 14, d: 'score (often empty for forced/flat)' },
      ] },
    { fr: 15, name: 'Hunter jog / standby', lens: 'hunter', purpose: 'Jog for soundness or generic standby graphic. Operator handles verbally.', status: 'ignored',
      tags: [] },
    { fr: 16, name: 'Hunter display scores — derby', lens: 'hunter', purpose: 'Operator pressed Display Scores for a derby class. APPEARS TO BE MULTI-PAGE like frame 11 — same tag carries different data depending on which display Ryegate is on (T vs OV vs LEADING etc.). Need multi-page capture to disentangle.', status: 'mapped',
      tags: [
        { n: 1,  d: 'entry number' },
        { n: 2,  d: 'horse name' },
        { n: 3,  d: 'rider name' },
        { n: 8,  d: 'RANK: place' },
        { n: 11, d: 'page-dependent total — appears as R2 Total on at least one page; needs multi-page capture' },
        { n: 14, d: 'page-dependent total — cycles through R1 / R2 / Overall depending on display mode (prefix "T" vs "OV" indicates which)' },
        { n: 15, d: 'R1 Total (S42 2026-05-02 — confirmed in single-page capture)' },
        { n: 21, d: 'Judge 1 base + bonus (e.g. "1:4.000 + 76")' },
        { n: 22, d: 'Judge 2 base + bonus (S42 2026-05-02)' },
        { n: 25, d: 'page-dependent total — appears as R2 Total on at least one page; needs multi-page capture' },
      ] },
  ];

  const FRAMES_CHANNEL_B = [
    { fr: '—', name: 'Focus packet', lens: 'both',
      purpose: 'Operator selected / clicked a class in Ryegate. NEW behavior coming: Ryegate will also fire on every Hunter INTRO click and carry a "final" tag on Upload Results so we can mark classes finalized.',
      status: 'mapped',
      tags: [
        { n: 26, d: 'classNum + "s" suffix (sponsor graphic — IGNORE)' },
        { n: 27, d: 'clean class number — USE THIS' },
        { n: 28, d: 'class name (bonus info)' },
        { n: '?', d: 'NEW: "final" tag on Upload Results click (Ryegate update pending)' },
      ] },
  ];

  // Default map (shipped with the build) — frozen so we can compare against
  // it to know which fields are operator-edited.
  const DEFAULT_MAP = {
    A: JSON.parse(JSON.stringify(FRAMES_CHANNEL_A)),
    B: JSON.parse(JSON.stringify(FRAMES_CHANNEL_B)),
  };
  const PROTO_LS_KEY = 'engineProtocolOverrides';

  // Active map — defaults plus any operator overrides + added tags/frames.
  // We persist the WHOLE map for simplicity (vs diff-against-defaults). If a
  // future build updates DEFAULT_MAP, operators hit Reset to pick up the new
  // defaults and lose their local notes — explicit and predictable.
  let protoMap = JSON.parse(JSON.stringify(DEFAULT_MAP));

  function loadProtoOverrides() {
    try {
      const raw = localStorage.getItem(PROTO_LS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && Array.isArray(saved.A) && Array.isArray(saved.B)) {
        protoMap = saved;
      }
    } catch (e) { console.warn('proto overrides parse failed', e); }
  }

  function saveProtoOverrides() {
    try { localStorage.setItem(PROTO_LS_KEY, JSON.stringify(protoMap)); }
    catch (e) { console.warn('proto overrides save failed', e); }
  }

  function isEdited(ch, i, field, tagIdx) {
    const def = (DEFAULT_MAP[ch] || [])[i];
    const cur = protoMap[ch][i];
    if (!def) return true;                                // added frame
    if (field === 'tag') {
      const dt = def.tags[tagIdx];
      const ct = cur.tags[tagIdx];
      if (!dt) return true;                              // added tag
      return ct.d !== dt.d || String(ct.n) !== String(dt.n);
    }
    return cur[field] !== def[field];
  }

  // Per-frame raw sample (most recent) — keyed `${ch}:${fr}` from state.
  let frameSamples = {};

  function renderFrameCard(f, ch, i) {
    const lensClass = 'lens-' + f.lens;
    const statusClass = 'status-' + f.status;
    const editClass = (field, tagIdx) =>
      isEdited(ch, i, field, tagIdx) ? ' is-edited' : '';
    const isAddedFrame = !(DEFAULT_MAP[ch] || [])[i];
    const sample = frameSamples[`${ch}:${f.fr}`];
    const sampleHtml = sample
      ? `<details class="proto-sample">
           <summary>view last raw frame · ${escapeHtml(fmtAgo(sample.at))}</summary>
           <pre class="proto-sample-body">${escapeHtml(sample.text)}</pre>
         </details>`
      : '';
    const tagRows = f.tags.map((t, j) => {
      const isAdded = !((DEFAULT_MAP[ch][i] || {}).tags || [])[j];
      const removeBtn = isAdded
        ? `<button class="proto-tag-rm" data-ch="${ch}" data-i="${i}" data-tag="${j}" title="Remove this tag">✕</button>`
        : '';
      const autoBadge = t.auto
        ? `<span class="proto-auto-badge" title="Engine observed this tag in live UDP — describe what it means">auto</span>`
        : '';
      return `<div class="proto-tag${t.auto ? ' is-auto' : ''}">` +
        `<span class="proto-tag-num proto-edit${editClass('tag', j)}" ` +
        `contenteditable="true" data-ch="${ch}" data-i="${i}" data-tag="${j}" data-field="tag-num">` +
        `{${escapeHtml(String(t.n))}}</span>` +
        `<span class="proto-tag-desc proto-edit${editClass('tag', j)}" ` +
        `contenteditable="true" data-ch="${ch}" data-i="${i}" data-tag="${j}" data-field="tag-desc">` +
        `${escapeHtml(t.d)}</span>` +
        autoBadge +
        removeBtn + `</div>`;
    }).join('');
    const tagsHtml = `<div class="proto-tags">${tagRows}</div>` +
      `<button class="proto-add-tag" data-ch="${ch}" data-i="${i}">+ Add tag</button>`;
    const statusOptions = ['mapped', 'ignored', 'unknown']
      .map(s => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${s}</option>`)
      .join('');
    const removeFrameBtn = isAddedFrame
      ? `<button class="proto-frame-rm" data-ch="${ch}" data-i="${i}" title="Remove this added frame">✕ remove frame</button>`
      : '';
    const autoFrameBadge = f.auto
      ? `<span class="proto-auto-badge" title="Engine observed this frame in live UDP — describe what it carries">auto</span>`
      : '';
    // Frame number (`{fr}=N`) is editable for ADDED frames only — protocol
    // facts on shipped defaults stay locked.
    const frNumHtml = isAddedFrame
      ? `<span class="proto-frame-num proto-edit is-edited" contenteditable="true" ` +
        `data-ch="${ch}" data-i="${i}" data-field="fr">{fr}=${escapeHtml(String(f.fr))}</span>`
      : `<span class="proto-frame-num">{fr}=${escapeHtml(String(f.fr))}</span>`;
    return `<div class="proto-frame ${statusClass}${f.auto ? ' is-auto' : ''}" data-ch="${ch}" data-i="${i}">
      <div class="proto-frame-head">
        ${frNumHtml}
        <span class="proto-frame-name proto-edit${editClass('name')}" ` +
          `contenteditable="true" data-ch="${ch}" data-i="${i}" data-field="name">` +
          `${escapeHtml(f.name)}</span>
        <span class="proto-frame-lens ${lensClass}">${escapeHtml(f.lens)}</span>
        <select class="proto-status-select status-${f.status}${editClass('status')}" ` +
          `data-ch="${ch}" data-i="${i}" data-field="status">${statusOptions}</select>
        ${autoFrameBadge}
        ${removeFrameBtn}
      </div>
      <div class="proto-frame-purpose proto-edit${editClass('purpose')}" ` +
        `contenteditable="true" data-ch="${ch}" data-i="${i}" data-field="purpose">` +
        `${escapeHtml(f.purpose)}</div>
      ${tagsHtml}
      ${sampleHtml}
    </div>`;
  }

  function renderProtocolMap() {
    document.getElementById('protoFramesA').innerHTML =
      protoMap.A.map((f, i) => renderFrameCard(f, 'A', i)).join('') +
      `<button class="proto-add-frame" data-ch="A">+ Add frame</button>`;
    document.getElementById('protoFramesB').innerHTML =
      protoMap.B.map((f, i) => renderFrameCard(f, 'B', i)).join('') +
      `<button class="proto-add-frame" data-ch="B">+ Add frame</button>`;
  }

  function commitProtoEdit(el) {
    const ch = el.dataset.ch;
    const i = parseInt(el.dataset.i, 10);
    const field = el.dataset.field;
    if (!protoMap[ch] || !protoMap[ch][i]) return;
    const rawText = (el.textContent || '').trim();
    if (field === 'tag-num' || field === 'tag-desc') {
      const j = parseInt(el.dataset.tag, 10);
      const tag = protoMap[ch][i].tags[j];
      if (!tag) return;
      if (field === 'tag-num') {
        // Strip optional surrounding braces so operators can type {N} or N.
        const cleaned = rawText.replace(/^\{|\}$/g, '').trim();
        if (cleaned === '' || String(tag.n) === cleaned) return;
        tag.n = cleaned;
      } else {
        if (tag.d === rawText) return;
        tag.d = rawText;
      }
    } else if (field === 'fr') {
      const cleaned = rawText.replace(/^\{?fr\}?=?/, '').replace(/^\{|\}$/g, '').trim();
      if (cleaned === '' || String(protoMap[ch][i].fr) === cleaned) return;
      protoMap[ch][i].fr = cleaned;
    } else {
      const newVal = el.tagName === 'SELECT' ? el.value : rawText;
      if (protoMap[ch][i][field] === newVal) return;
      protoMap[ch][i][field] = newVal;
    }
    saveProtoOverrides();
    renderProtocolMap();
  }

  function addTag(ch, i, opts) {
    if (!protoMap[ch] || !protoMap[ch][i]) return;
    const tag = (opts && opts.auto)
      ? { n: opts.n, d: 'auto-discovered — describe', auto: true }
      : { n: '?', d: 'new tag — describe' };
    protoMap[ch][i].tags.push(tag);
    saveProtoOverrides();
    renderProtocolMap();
  }

  function removeTag(ch, i, j) {
    if (!protoMap[ch] || !protoMap[ch][i]) return;
    const tag = protoMap[ch][i].tags[j];
    const frame = protoMap[ch][i];
    protoMap[ch][i].tags.splice(j, 1);
    saveProtoOverrides();
    renderProtocolMap();
    // If we just removed an auto-discovered tag, tell main to forget it
    // so the next packet with this tag re-triggers discovery.
    if (tag && tag.auto && window.westEngine.forgetDiscovered) {
      window.westEngine.forgetDiscovered({ ch, fr: frame.fr, tag: tag.n });
    }
  }

  function addFrame(ch, opts) {
    if (!protoMap[ch]) return;
    const auto = !!(opts && opts.auto);
    protoMap[ch].push({
      fr: auto ? String(opts.fr) : '?',
      name: auto ? 'auto-discovered frame — name it' : 'new frame — name it',
      lens: 'both',
      purpose: auto
        ? 'engine observed this frame in incoming UDP. Document what it carries.'
        : 'observed in UDP stream — document what it carries.',
      status: 'unknown',
      tags: [],
      auto,
    });
    saveProtoOverrides();
    renderProtocolMap();
  }

  // Auto-discovery handlers — main calls these when the UDP listener sees
  // a frame or tag that isn't in our current map. Idempotent: if the
  // frame/tag already exists, no-op.
  function handleDiscoveredFrame(info) {
    if (!info || !info.ch || info.fr == null) return;
    const ch = info.ch;
    if (!protoMap[ch]) return;
    const exists = protoMap[ch].some(f => String(f.fr) === String(info.fr));
    if (exists) return;
    addFrame(ch, { auto: true, fr: info.fr });
  }
  function handleDiscoveredTag(info) {
    if (!info || !info.ch || info.fr == null || info.tag == null) return;
    const ch = info.ch;
    const i = (protoMap[ch] || []).findIndex(f => String(f.fr) === String(info.fr));
    if (i < 0) {
      // Frame itself is unknown — bootstrap the frame first, then add the tag.
      handleDiscoveredFrame({ ch, fr: info.fr });
      const ni = protoMap[ch].findIndex(f => String(f.fr) === String(info.fr));
      if (ni >= 0) addTag(ch, ni, { auto: true, n: info.tag });
      return;
    }
    const tagExists = protoMap[ch][i].tags.some(t => String(t.n) === String(info.tag));
    if (tagExists) return;
    addTag(ch, i, { auto: true, n: info.tag });
  }
  if (window.westEngine.onDiscoveredFrame) window.westEngine.onDiscoveredFrame(handleDiscoveredFrame);
  if (window.westEngine.onDiscoveredTag)   window.westEngine.onDiscoveredTag(handleDiscoveredTag);

  function removeFrame(ch, i) {
    if (!confirm('Remove this added frame? Local notes for it will be lost.')) return;
    const frame = protoMap[ch][i];
    protoMap[ch].splice(i, 1);
    saveProtoOverrides();
    renderProtocolMap();
    // Auto-discovered frame removal → tell main to forget it (and its
    // tags) so re-sending the same packets re-discovers them.
    if (frame && frame.auto && window.westEngine.forgetDiscovered) {
      window.westEngine.forgetDiscovered({ ch, fr: frame.fr });
    }
  }

  // Event delegation: blur on contenteditable spans + change on selects +
  // click for add/remove buttons.
  ['protoFramesA', 'protoFramesB'].forEach(id => {
    const root = document.getElementById(id);
    if (!root) return;
    root.addEventListener('blur', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('proto-edit')) {
        commitProtoEdit(e.target);
      }
    }, true);
    root.addEventListener('change', (e) => {
      if (e.target && e.target.tagName === 'SELECT' && e.target.dataset.field) {
        commitProtoEdit(e.target);
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.classList.contains('proto-edit')) {
        e.preventDefault();
        e.target.blur();
      }
    });
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.classList.contains('proto-add-tag')) {
        addTag(t.dataset.ch, parseInt(t.dataset.i, 10));
      } else if (t.classList.contains('proto-tag-rm')) {
        removeTag(t.dataset.ch, parseInt(t.dataset.i, 10), parseInt(t.dataset.tag, 10));
      } else if (t.classList.contains('proto-add-frame')) {
        addFrame(t.dataset.ch);
      } else if (t.classList.contains('proto-frame-rm')) {
        removeFrame(t.dataset.ch, parseInt(t.dataset.i, 10));
      }
    });
  });

  document.getElementById('btnProtoReset').addEventListener('click', () => {
    if (!confirm('Wipe all local protocol-map edits on this PC?')) return;
    localStorage.removeItem(PROTO_LS_KEY);
    protoMap = JSON.parse(JSON.stringify(DEFAULT_MAP));
    renderProtocolMap();
  });

  // Export — dump the FULL current map (includes operator edits + auto-
  // discovered + added entries) to clipboard as pretty-printed JSON.
  // Reviewer rolls into bundled defaults / UDP-PROTOCOL-REFERENCE.md.
  document.getElementById('btnProtoExport').addEventListener('click', async () => {
    const json = JSON.stringify(protoMap, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      const btn = document.getElementById('btnProtoExport');
      const original = btn.textContent;
      btn.textContent = '✓ copied (' + Math.round(json.length / 1024) + ' KB)';
      setTimeout(() => { btn.textContent = original; }, 2200);
    } catch (e) {
      // Clipboard API can fail in unusual contexts — fall back to a window
      // prompt the operator can copy from manually.
      window.prompt('Clipboard write failed — copy manually:', json);
    }
  });

  // Import — paste a JSON dump from another PC. Validate shape, apply.
  document.getElementById('btnProtoImport').addEventListener('click', () => {
    const raw = window.prompt('Paste exported JSON to apply (replaces current local edits):');
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { alert('Invalid JSON: ' + e.message); return; }
    if (!parsed || !Array.isArray(parsed.A) || !Array.isArray(parsed.B)) {
      alert('JSON must have arrays for both "A" and "B" channels.');
      return;
    }
    if (!confirm(`Replace local edits with imported map? A=${parsed.A.length} frames, B=${parsed.B.length} frames.`)) return;
    protoMap = parsed;
    saveProtoOverrides();
    renderProtocolMap();
  });

  loadProtoOverrides();
  renderProtocolMap();

  // Initial state subscription
  window.westEngine.onState(render);

  // Ask main for the first state push (in case state pre-existed before
  // this window was created — main's tray click reuses an existing window).
  window.westEngine.requestState();
})();
