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

  // S46 — class-action context menu (Bill 2026-05-06). Renders a small
  // floating menu near the cursor when the operator right-clicks a class
  // in the Live pane. Three actions: Clear live, Make Final, Make Focus.
  // Click outside / Escape closes it. Only one menu open at a time.
  let openMenuEl = null;
  function closeClassActionMenu() {
    if (openMenuEl && openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl);
    openMenuEl = null;
    document.removeEventListener('click', closeClassActionMenu, true);
    document.removeEventListener('contextmenu', closeClassActionMenu, true);
    document.removeEventListener('keydown', onMenuKeydown, true);
  }
  function onMenuKeydown(e) {
    if (e.key === 'Escape') closeClassActionMenu();
  }
  function openClassActionMenu(x, y, classId, anchorEl) {
    closeClassActionMenu();
    if (!classId) return;
    const menu = document.createElement('div');
    menu.className = 'class-action-menu';
    menu.innerHTML = `
      <div class="cam-header">Class <strong>${classId}</strong></div>
      <button type="button" data-action="clear">Clear live</button>
      <button type="button" data-action="finalize">Make Final</button>
      <button type="button" data-action="focus">Make Focus</button>`;
    document.body.appendChild(menu);
    // Position — clamp to viewport so it never gets clipped.
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const px = Math.min(x, window.innerWidth  - w - 6);
    const py = Math.min(y, window.innerHeight - h - 6);
    menu.style.left = px + 'px';
    menu.style.top  = py + 'px';
    menu.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-action');
        closeClassActionMenu();
        const r = await window.westEngine.setClassLiveState(classId, action);
        if (!r || !r.ok) {
          alert(`Class action failed: ${(r && r.error) || 'unknown error'}`);
        }
      });
    });
    openMenuEl = menu;
    // Defer so the contextmenu event that opened us doesn't immediately close.
    setTimeout(() => {
      document.addEventListener('click', closeClassActionMenu, true);
      document.addEventListener('contextmenu', closeClassActionMenu, true);
      document.addEventListener('keydown', onMenuKeydown, true);
    }, 0);
  }

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
  let credsDirty = false;

  function populateSettings(settings) {
    if (!settings) return;
    if (!settingsDirty) {
      $('#setClsDir').value       = settings.clsDir          || '';
      $('#setTskedPath').value    = settings.tskedPath       || '';
      $('#setRyegateConf').value  = settings.ryegateConfPath || '';
    }
    if (!credsDirty) {
      $('#setWorkerUrl').value = settings.workerUrl || '';
      $('#setAuthKey').value   = settings.authKey   || '';
    }
    // Read-only fields refresh on every state push (auto-detected values).
    $('#setInputPort').value    = settings.inputPort    || '';
    $('#setRsserverPort').value = settings.rsserverPort || '';
    $('#setFocusPort').value    = settings.focusPort    || '';
    // Scoreboard tab — editable port override fields (3.1.9). Each input
    // shows the saved override (or empty when none); placeholder shows the
    // auto-detected fallback so operators see what they'd get with no
    // override. Source label below switches to "manual" in amber when an
    // override is active.
    setPortInput(
      $('#sbInputPortInput'),
      $('#sbInputSource'),
      settings.inputPortOverride,
      settings.detectedInputPort || settings.inputPort,
      settings.inputPortSource || 'auto from config.dat'
    );
    setPortInput(
      $('#sbRsserverPortInput'),
      $('#sbRsserverPortSource'),
      settings.rsserverPortOverride,
      (settings.detectedInputPort || settings.inputPort) + 1,
      settings.rsserverPortSource || 'listen + 1'
    );
    setHostInput(
      $('#sbRsserverHostInput'),
      $('#sbRsserverHostSource'),
      settings.rsserverHostOverride,
      '127.0.0.1',
      settings.rsserverHostSource || 'localhost'
    );
    // Protocol tab — show which port we'd be listening on.
    const protoIn = document.getElementById('protoInputPort');
    if (protoIn) protoIn.textContent = settings.inputPort || '—';
  }

  // Per-feature in-flight set. A state push that arrives while we're still
  // waiting for saveFeature() to resolve must NOT overwrite the checkbox —
  // the in-flight save's value is the truth, not whatever main has pushed
  // (which was sampled before writeConfig completed).
  const featureSaveInFlight = new Set();
  // Same trick for port override fields — don't let a state push stomp on
  // the value while the operator is editing or a save is in flight.
  const portSaveInFlight = new Set();

  // 3.2.0 — track the shape of the rendered reconciliation lists so we
  // only rebuild rows when the diff actually changes. Avoids wiping out
  // operator checkbox selections during a 60s background refresh.
  let lastReconKey = '';
  function reconKey(r) {
    if (!r) return '';
    const lo = (r.localOnly  || []).map(f => f.class_id).join(',');
    const so = (r.serverOnly || []).map(f => f.class_id).join(',');
    return `lo:${lo}|so:${so}`;
  }
  function fmtMtime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString();
  }
  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n}B`;
    return `${(n / 1024).toFixed(1)}K`;
  }
  function gateLabel(gate) {
    if (!gate) return '';
    if (gate.allow) {
      const r = gate.reason || '';
      if (r === 'test-show' || r === 'test-class') return `<span class="gate allowed">${r}</span>`;
      if (r === 'no-meta')   return `<span class="gate allowed">would upload (no meta)</span>`;
      return `<span class="gate allowed">date ok</span>`;
    }
    return `<span class="gate blocked">blocked: ${gate.reason || '?'}</span>`;
  }
  function renderReconciliation(r) {
    const pill = $('#reconPill');
    const pane = $('#reconPane');
    if (!r || r.inSync) {
      pill.hidden = true;
      pane.hidden = true;
      return;
    }
    pill.hidden = false;
    pane.hidden = false;
    const counts = [];
    if (r.serverOnly.length) counts.push(`${r.serverOnly.length} on website only`);
    if (r.localOnly.length)  counts.push(`${r.localOnly.length} local only`);
    $('#reconPillText').textContent = counts.join(' · ') || 'Mismatch';
    $('#reconSummary').textContent = (r.refreshing ? '· refreshing · ' : '') +
      counts.join(' · ') +
      (r.both ? ` · ${r.both} matched` : '') +
      (r.loadedAt ? ` · checked ${fmtAgo(r.loadedAt)}` : '');

    const errEl = $('#reconError');
    if (r.error) {
      errEl.textContent = r.error;
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }

    const key = reconKey(r);
    if (key === lastReconKey) return;          // shape unchanged — keep operator selections
    lastReconKey = key;

    // ── server-only list (restore candidates) ──
    const soSec  = $('#reconServerOnly');
    const soList = $('#reconServerOnlyList');
    if (r.serverOnly.length) {
      soSec.hidden = false;
      soList.innerHTML = r.serverOnly.map(f => `
        <li class="recon-row">
          <input type="checkbox" class="recon-pick recon-pick-server" data-cid="${esc(f.class_id)}" checked>
          <span class="cid">${esc(f.class_id)}</span>
          <span class="meta">${fmtSize(f.size)} · uploaded ${esc(f.uploaded || '—')}</span>
          <span></span>
        </li>`).join('');
      $('#reconServerOnlyAll').checked = true;
    } else {
      soSec.hidden = true;
    }

    // ── local-only list (upload candidates) ──
    const loSec  = $('#reconLocalOnly');
    const loList = $('#reconLocalOnlyList');
    if (r.localOnly.length) {
      loSec.hidden = false;
      loList.innerHTML = r.localOnly.map(f => {
        const allow = f.gate && f.gate.allow;
        // Default: blocked files = unchecked (operator opts in), allowed
        // files = unchecked too in this list (they'll upload normally via
        // the watcher anyway; this list is for FORCE-upload override).
        // We surface them all so the operator can see the full diff.
        const checked = '';
        return `
        <li class="recon-row">
          <input type="checkbox" class="recon-pick recon-pick-local" data-cid="${esc(f.class_id)}" ${checked}>
          <span class="cid">${esc(f.class_id)}</span>
          <span class="meta">${fmtSize(f.size)} · ${fmtMtime(f.mtimeMs)}</span>
          ${gateLabel(f.gate)}
        </li>`;
      }).join('');
      $('#reconLocalOnlyAll').checked = false;
    } else {
      loSec.hidden = true;
    }
  }
  // Helper — html escape (renderer already has one but it's deeper; small
  // local copy keeps this block independent).
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // 3.1.9 — port override helpers. Each routing field shows the saved
  // override value (or empty) with the auto-detected fallback as
  // placeholder. Source label flips to amber "manual" when override
  // active. Skipped while the input has focus (don't fight the operator's
  // typing) and while a save is in flight.
  function setPortInput(input, sourceEl, override, autoVal, autoLabel) {
    if (!input) return;
    const key = input.id;
    const hasOverride = override !== null && override !== undefined && override !== '';
    if (document.activeElement !== input && !portSaveInFlight.has(key)) {
      input.value = hasOverride ? String(override) : '';
    }
    if (autoVal != null) input.placeholder = String(autoVal);
    if (sourceEl) {
      sourceEl.textContent = hasOverride ? 'manual' : autoLabel;
      sourceEl.classList.toggle('manual', hasOverride);
    }
  }
  function setHostInput(input, sourceEl, override, autoVal, autoLabel) {
    if (!input) return;
    const key = input.id;
    const hasOverride = !!(override && String(override).trim());
    if (document.activeElement !== input && !portSaveInFlight.has(key)) {
      input.value = hasOverride ? String(override) : '';
    }
    if (autoVal != null) input.placeholder = String(autoVal);
    if (sourceEl) {
      sourceEl.textContent = hasOverride ? 'manual' : autoLabel;
      sourceEl.classList.toggle('manual', hasOverride);
    }
  }

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
    if (!featureSaveInFlight.has('autoStart')) {
      const el = $('#featAutoStart');
      if (el) el.checked = !!features.autoStart;
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

    // First-run wizard takes priority over everything else — if config.json
    // is missing required fields, the operator can't do anything else.
    maybeShowWizard(state);

    // Top bar — show / ring identity. Friendly name on top, slug below
    // for confirmation. Slug element collapses (CSS :empty) when unset.
    const cfg = state.config;
    if (cfg && cfg.showSlug) {
      const display = (cfg.showName || cfg.showSlug) + ' · Ring ' + cfg.ringNum;
      $('#currentShowRing').textContent = display;
      $('#currentShowSlug').textContent = cfg.showName ? cfg.showSlug : '';
    } else {
      $('#currentShowRing').textContent = '— not selected —';
      $('#currentShowSlug').textContent = '';
    }

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

    // Updater — surface latest version + install button when a newer
    // engine is available. Topbar pill appears only when update.available;
    // Settings fieldset always visible with current version.
    const upd = state.update || {};
    $('#updateCurrentVersion').textContent = state.engineVersion || '—';
    const updPill   = $('#updatePill');
    const updPillTx = $('#updatePillText');
    const installBtn = $('#btnInstallUpdate');
    const latestRow = $('#updateLatestRow');
    const notesRow  = $('#updateNotesRow');
    const lastCheck = $('#updateLastCheck');
    if (upd.available && upd.latestVersion) {
      updPill.hidden = false;
      updPillTx.textContent = 'Update ' + upd.latestVersion;
      latestRow.hidden = false;
      $('#updateLatestVersion').textContent = upd.latestVersion;
      installBtn.hidden = false;
      if (upd.releaseNotes) {
        notesRow.hidden = false;
        $('#updateReleaseNotes').textContent = upd.releaseNotes;
      } else {
        notesRow.hidden = true;
      }
    } else {
      updPill.hidden = true;
      latestRow.hidden = true;
      notesRow.hidden = true;
      installBtn.hidden = true;
    }
    if (upd.installing) {
      installBtn.disabled = true;
      installBtn.textContent = 'Installing…';
    } else {
      installBtn.disabled = false;
      installBtn.textContent = 'Install & restart';
    }
    if (upd.lastCheckError) {
      lastCheck.textContent = 'Last check failed: ' + upd.lastCheckError;
    } else if (upd.checking) {
      lastCheck.textContent = 'Checking…';
    } else if (upd.lastCheckAt) {
      lastCheck.textContent = 'Last checked ' + fmtAgo(upd.lastCheckAt);
    } else {
      lastCheck.textContent = 'Checking on launch + hourly';
    }

    // 3.2.2 — rollback button. Enabled only when app.asar.previous exists
    // (operator has installed at least one OTA update on this machine).
    const rollbackBtn  = $('#btnRollback');
    const rollbackHint = $('#rollbackHint');
    const prev = upd.previous;
    if (prev && prev.available) {
      rollbackBtn.disabled = false;
      rollbackBtn.textContent = prev.version
        ? `Roll back to ${prev.version}`
        : 'Roll back to previous';
      rollbackHint.textContent = 'Restores the previously-installed engine and restarts. Used to undo an OTA update that introduced a regression.';
    } else {
      rollbackBtn.disabled = true;
      rollbackBtn.textContent = 'Roll back';
      rollbackHint.textContent = 'No previous version stored — rollback unavailable. After the next OTA update, this will become available so you can swap back if the new version misbehaves.';
    }

    // Health pill — surfaces the watchdog's degraded list. Recovery actions
    // are handled in main; the pill is read-only.
    const wd = state.watchdog || {};
    const degraded = wd.degraded || [];
    const recoveryCount = wd.recoveriesPerformed || 0;
    const healthPill = $('#healthPill');
    const healthDot  = $('#healthDot');
    const healthText = $('#healthPillText');
    healthPill.classList.remove('degraded', 'fail');
    healthDot.classList.remove('ok', 'degraded', 'fail');
    if (degraded.length === 0) {
      healthDot.classList.add('ok');
      healthText.textContent = recoveryCount ? `Healthy · ${recoveryCount} recovered` : 'Healthy';
      healthPill.title = wd.lastCheckAt
        ? `Last check ${fmtAgo(wd.lastCheckAt)}\nRecoveries: ${recoveryCount}`
        : 'Watchdog warming up';
    } else {
      healthPill.classList.add('degraded');
      healthDot.classList.add('degraded');
      healthText.textContent = `${degraded.length} issue${degraded.length === 1 ? '' : 's'}`;
      healthPill.title = degraded.join('\n');
    }

    // Mode pill — four states from {show selected} × {pass-through enabled}.
    // Independent of the live-scoring pause (which is a transient override
    // shown via banner, not a structural mode).
    const showSel = !!state.config;
    const ptOn    = state.passthrough !== false;
    const pill    = $('#modePill');
    const pillVal = $('#modePillValue');
    let modeClass, modeText;
    if (showSel && ptOn)        { modeClass = 'full';        modeText = 'WEBSITE + PASS-THROUGH'; }
    else if (showSel && !ptOn)  { modeClass = 'website';     modeText = 'WEBSITE ONLY'; }
    else if (!showSel && ptOn)  { modeClass = 'passthrough'; modeText = 'PASS-THROUGH ONLY'; }
    else                        { modeClass = 'idle';        modeText = 'IDLE'; }
    pill.classList.remove('full', 'website', 'passthrough', 'idle');
    pill.classList.add(modeClass);
    pillVal.textContent = modeText;

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

    // S46 — Live-on-website pane (Bill 2026-05-06). Mirrors the worker's
    // ring-wide is_live flag + lists every open class with state badges
    // (LIVE / FOCUS / FINAL). Right-click any class number for the
    // manual override menu (Clear live / Make Final / Make Focus).
    const liveBody = $('#liveBody');
    const ls = state.liveState || {};
    const classes = Array.isArray(ls.classes) ? ls.classes : [];
    if (state.config && state.lastUdpAt) {
      const sinceText = ls.liveSince ? fmtAgo(ls.liveSince) : null;
      const headerCls = ls.isLive ? 'is-live' : 'not-live';
      const headerTxt = ls.isLive ? 'LIVE' : 'Not live';
      const sinceHtml = ls.isLive && sinceText
        ? `<span class="live-since">since ${escapeHtml(sinceText)}</span>`
        : '';
      let classesHtml;
      if (classes.length) {
        classesHtml = classes.map(c => {
          const tags = [];
          if (c.is_live)  tags.push('<span class="live-tag t-live">LIVE</span>');
          if (String(c.class_id) === String(ls.focusedClassId)) tags.push('<span class="live-tag t-focus">FOCUS</span>');
          if (String(c.class_id) === String(ls.forcedFocusClassId)) tags.push('<span class="live-tag t-forced">PINNED</span>');
          if (c.is_final) tags.push('<span class="live-tag t-final">FINAL</span>');
          const itemClasses = ['live-class-item'];
          if (c.is_live)  itemClasses.push('is-live');
          if (c.is_final) itemClasses.push('is-final');
          if (String(c.class_id) === String(ls.focusedClassId)) itemClasses.push('is-focus');
          const name = c.class_name ? `<span class="live-class-name">${escapeHtml(c.class_name)}</span>` : '';
          return `<button class="${itemClasses.join(' ')}" data-class-id="${escapeHtml(String(c.class_id))}" type="button" title="Right-click for actions">
            <span class="live-class-num">${escapeHtml(String(c.class_id))}</span>
            ${name}
            <span class="live-class-tags">${tags.join('')}</span>
          </button>`;
        }).join('');
      } else {
        classesHtml = '<span class="live-class-empty">No classes seen yet.</span>';
      }
      liveBody.classList.remove('is-live', 'not-live');
      liveBody.classList.add(headerCls);
      liveBody.innerHTML = `
        <div class="live-row">
          <span class="live-status-dot"></span>
          <span class="live-status-text">${headerTxt}</span>
          ${sinceHtml}
        </div>
        <div class="live-classes-row">
          <span class="live-classes-label">Classes</span>
          <span class="live-classes-list">${classesHtml}</span>
        </div>
        <div class="live-hint-row">Right-click a class for Clear live · Make Final · Make Focus.</div>`;
      // Wire right-click context menu on each class item.
      liveBody.querySelectorAll('.live-class-item').forEach(btn => {
        btn.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          const cid = btn.getAttribute('data-class-id');
          openClassActionMenu(ev.clientX, ev.clientY, cid, btn);
        });
      });
    } else {
      liveBody.classList.remove('is-live', 'not-live');
      liveBody.innerHTML = '<div class="live-empty">Worker hasn\'t reported yet.</div>';
    }

    // S46 — On-the-air preview pane (Bill 2026-05-06). Mirrors what the
    // public live box is showing for the FOCUSED class. Pulled raw from
    // the snapshot's last_identity + last_scoring tags so the operator
    // can verify the public view without opening the live page.
    const fpBody = $('#focusPreviewBody');
    const fp = ls.focusPreview;
    if (fp && fp.class_id) {
      const headerBits = [`<span class="fp-class-num">${escapeHtml(String(fp.class_id))}</span>`];
      if (fp.class_name) headerBits.push(`<span class="fp-class-name">${escapeHtml(fp.class_name)}</span>`);
      const stateTags = [];
      if (fp.is_live)  stateTags.push('<span class="live-tag t-live">LIVE</span>');
      if (fp.is_final) stateTags.push('<span class="live-tag t-final">FINAL</span>');
      const idLine = (fp.entry_num || fp.horse || fp.rider) ? `
          <div class="fp-id-row">
            ${fp.entry_num ? `<span class="fp-entry">#${escapeHtml(fp.entry_num)}</span>` : ''}
            ${fp.horse    ? `<span class="fp-horse">${escapeHtml(fp.horse)}</span>` : ''}
            ${fp.rider    ? `<span class="fp-rider">${escapeHtml(fp.rider)}</span>` : ''}
          </div>` : '';
      // Status line — mirror the live box: countdown OR clock, plus rank
      // and faults when present. Concise, single line.
      const stat = [];
      const cd = (fp.countdown || '').replace(/^-/, '');
      if (cd && cd !== '0' && cd !== '00') stat.push(`<span class="fp-stat fp-cd">CD ${escapeHtml(cd)}</span>`);
      else if (fp.clock) stat.push(`<span class="fp-stat fp-clock">${escapeHtml(fp.clock)}s</span>`);
      if (fp.rank)        stat.push(`<span class="fp-stat fp-rank">Rank ${escapeHtml(fp.rank)}</span>`);
      if (fp.label_or_ta && !fp.rank) stat.push(`<span class="fp-stat fp-ta">${escapeHtml(fp.label_or_ta)}</span>`);
      const jf = parseFloat(fp.jump_faults), tf = parseFloat(fp.time_faults);
      const totFaults = (Number.isFinite(jf) ? jf : 0) + (Number.isFinite(tf) ? tf : 0);
      if ((Number.isFinite(jf) || Number.isFinite(tf)) && totFaults > 0) {
        stat.push(`<span class="fp-stat fp-faults">${totFaults} F</span>`);
      }
      if (fp.target_time) stat.push(`<span class="fp-stat fp-tt">TA ${escapeHtml(fp.target_time)}s</span>`);
      const statLine = stat.length
        ? `<div class="fp-stat-row">${stat.join('')}</div>`
        : '<div class="fp-stat-row fp-stat-empty">No active scoring frame.</div>';
      // Just-finished overlay if present (mirrors the website's banner).
      const pe = fp.previous_entry;
      const jfLine = pe && pe.entry_num ? `
          <div class="fp-prev-row">
            <span class="fp-prev-label">Just finished</span>
            <span>#${escapeHtml(String(pe.entry_num))}</span>
            ${pe.horse_name ? `<span>${escapeHtml(pe.horse_name)}</span>` : ''}
            ${pe.faults != null ? `<span>${escapeHtml(String(pe.faults))}F</span>` : ''}
            ${pe.time != null ? `<span>${escapeHtml(String(pe.time))}s</span>` : ''}
            ${pe.overall_place != null ? `<span>· ${escapeHtml(String(pe.overall_place))}</span>` : ''}
          </div>` : '';
      fpBody.innerHTML = `
        <div class="fp-header-row">
          <div class="fp-header-left">${headerBits.join(' ')}</div>
          <div class="fp-header-right">${stateTags.join('')}</div>
        </div>
        ${idLine}
        ${statLine}
        ${jfLine}`;
    } else {
      fpBody.innerHTML = '<div class="focus-preview-empty">No focused class yet.</div>';
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

    // 3.2.0 — reconciliation pane + title-bar pill. Hidden when local
    // folder matches the website's R2 inventory. When mismatched, the
    // pane lists the two diff buckets (server-only = restore candidates,
    // local-only = upload candidates with per-file gate result). The
    // pill in the title bar lights up so the operator sees it without
    // having to be on the Status tab.
    renderReconciliation(state.reconciliation);

    // 3.1.8 — Test URL pane. Shown whenever a show is selected; the URL
    // form switches based on showMeta.is_test (TEST show = bare URL, real
    // show = ?test=1 to reveal test classes). state.testUrl is built in
    // main.js and pushed; renderer just displays.
    const testUrlPane = $('#testUrlPane');
    if (state.testUrl && state.testUrl.url) {
      testUrlPane.hidden = false;
      $('#testUrlVal').textContent = state.testUrl.url;
      $('#testUrlLabel').textContent = state.testUrl.label || 'Test URL';
      $('#testUrlHint').textContent = state.testUrl.kind === 'test-show'
        ? 'this show is hidden from the public homepage — direct link still works'
        : 'reveals test classes that are hidden from the public show page';
    } else {
      testUrlPane.hidden = true;
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

    // Pass-through toggle on Data Settings tab. Stays enabled regardless
    // of show selection — pass-through-only with no show is a valid
    // operating mode (engine acts as dumb local scoreboard relay).
    const fwdBtn = $('#btnPauseForwarding');
    const passthrough = state.passthrough !== false;
    fwdBtn.classList.toggle('is-active', !passthrough);
    fwdBtn.textContent = passthrough ? '⏸ Disable pass-through' : '▶ Enable pass-through';

    // Disable re-post controls when no show selected (no point reposting
    // nothing). Pass-through toggle stays live.
    const noShow = !state.config;
    $('#btnRepostCls').disabled = noShow;
    $('#btnRepostTsked').disabled = noShow;

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

  // ── First-run wizard ───────────────────────────────────────────────────
  // Triggered when state.configError indicates missing workerUrl/authKey.
  // Self-closes on successful save (next state push will have configError
  // null, render() decides whether to keep it open).
  const wzDlg     = $('#dlgWizard');
  const wzWorker  = $('#wzWorkerUrl');
  const wzKey     = $('#wzAuthKey');
  const wzError   = $('#wzError');
  const wzSuccess = $('#wzSuccess');
  const wzSave    = $('#btnWizardSave');
  let wizardShown = false;

  function maybeShowWizard(state) {
    const needsCreds = !!(state.configError && /workerurl|authkey|missing config/i.test(state.configError));
    if (needsCreds && !wizardShown && !wzDlg.open) {
      wizardShown = true;
      wzError.hidden = true;
      wzSuccess.hidden = true;
      wzDlg.showModal();
    } else if (!needsCreds && wzDlg.open) {
      // Credentials successfully saved — close wizard.
      wzDlg.close();
      wizardShown = false;
    }
  }

  wzSave.addEventListener('click', async () => {
    wzError.hidden = true;
    wzSuccess.hidden = true;
    wzSave.disabled = true;
    wzSave.textContent = 'Testing…';
    try {
      const res = await window.westEngine.saveCredentials(wzWorker.value, wzKey.value);
      if (!res.ok) {
        wzError.textContent = res.error || 'Save failed';
        wzError.hidden = false;
        wzSave.disabled = false;
        wzSave.textContent = 'Test & save';
        return;
      }
      wzSuccess.textContent = '✓ Connected. Saving…';
      wzSuccess.hidden = false;
      // Modal closes when next state push arrives without configError —
      // see maybeShowWizard.
    } catch (e) {
      wzError.textContent = 'Unexpected error: ' + e.message;
      wzError.hidden = false;
      wzSave.disabled = false;
      wzSave.textContent = 'Test & save';
    }
  });

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
  $('#btnPickerClear').addEventListener('click', async () => {
    const cur = lastState && lastState.config;
    if (!cur) { dlg.close(); return; } // already cleared
    const confirmed = confirm(
      `Clear show selection?\n\nThe engine will stop posting to the worker (.cls / tsked / UDP events / heartbeat).\n\nUDP pass-through to RSServer keeps running if it's enabled on Data Settings.`);
    if (!confirmed) return;
    try {
      await window.westEngine.clearShow();
      dlg.close();
    } catch (e) {
      pkError.textContent = 'Clear failed: ' + e.message;
      pkError.hidden = false;
    }
  });
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
      // Pull the display name from the picker's selected option so main can
      // persist it alongside slug. Falls back to null if option text doesn't
      // contain a friendly name (defensive — should always have one).
      const optText = pkShow.options[pkShow.selectedIndex] && pkShow.options[pkShow.selectedIndex].textContent || '';
      const name = optText.split(' · ')[0].trim() || null;
      await window.westEngine.switchShow(slug, ring, name);
      dlg.close();
      // If the picker was opened from the mode pill, apply the requested
      // pass-through state now that the show is set.
      if (pendingPassthroughAfterPick !== null) {
        const want = pendingPassthroughAfterPick;
        pendingPassthroughAfterPick = null;
        // Wait one state push so lastState reflects the new show
        setTimeout(() => { setPassthroughTo(want); }, 100);
      }
    } catch (e) {
      pkError.textContent = 'Switch failed: ' + e.message;
      pkError.hidden = false;
    }
  });

  // ── Manual control buttons ─────────────────────────────────────────────
  $('#btnFlushLive').addEventListener('click', async () => {
    const btn = $('#btnFlushLive');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Flushing…';
    try {
      const res = await window.westEngine.flushLiveAll();
      btn.textContent = res && res.ok ? '✓ Flushed' : '✗ ' + ((res && res.error) || 'failed');
    } catch (e) {
      btn.textContent = '✗ ' + e.message;
    }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  });

  // ── Reconciliation pane wiring (3.2.0) ─────────────────────────────────
  // Pill in the title bar takes you to the Status tab and scrolls the pane
  // into view; Refresh button forces a diff bypassing the 60s interval;
  // bulk-select toggles operate on the visible list; the two action
  // buttons fire the matching IPC handlers and surface a status pill.
  const reconPill          = $('#reconPill');
  const btnReconRefresh    = $('#btnReconRefresh');
  const reconServerAllCb   = $('#reconServerOnlyAll');
  const reconLocalAllCb    = $('#reconLocalOnlyAll');
  const btnReconRestore    = $('#btnReconRestore');
  const btnReconUpload     = $('#btnReconUploadOverride');
  const reconRestoreStatus = $('#reconRestoreStatus');
  const reconUploadStatus  = $('#reconUploadStatus');

  if (reconPill) {
    reconPill.addEventListener('click', () => {
      const statusTab = $('#tabStatus');
      if (statusTab) statusTab.click();
      const pane = $('#reconPane');
      if (pane && !pane.hidden) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  if (btnReconRefresh) {
    btnReconRefresh.addEventListener('click', async () => {
      btnReconRefresh.disabled = true;
      btnReconRefresh.textContent = '↻ Refreshing…';
      try { await window.westEngine.reconcileRefresh(); }
      catch (e) {}
      btnReconRefresh.textContent = '↻ Refresh';
      btnReconRefresh.disabled = false;
    });
  }
  if (reconServerAllCb) {
    reconServerAllCb.addEventListener('change', () => {
      document.querySelectorAll('.recon-pick-server').forEach(cb => { cb.checked = reconServerAllCb.checked; });
    });
  }
  if (reconLocalAllCb) {
    reconLocalAllCb.addEventListener('change', () => {
      document.querySelectorAll('.recon-pick-local').forEach(cb => { cb.checked = reconLocalAllCb.checked; });
    });
  }
  function gatherChecked(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter(cb => cb.checked)
      .map(cb => cb.getAttribute('data-cid'));
  }
  if (btnReconRestore) {
    btnReconRestore.addEventListener('click', async () => {
      const ids = gatherChecked('.recon-pick-server');
      if (!ids.length) {
        reconRestoreStatus.textContent = 'no rows selected';
        reconRestoreStatus.className = 'recon-status fail';
        setTimeout(() => { reconRestoreStatus.textContent = ''; reconRestoreStatus.className = 'recon-status'; }, 2200);
        return;
      }
      btnReconRestore.disabled = true;
      btnReconRestore.textContent = '↓ Restoring…';
      try {
        const res = await window.westEngine.reconcileRestore(ids);
        if (!res || !res.ok) throw new Error((res && res.error) || 'restore failed');
        reconRestoreStatus.textContent = `✓ ${res.restored} restored${res.failed ? ` · ${res.failed} failed` : ''}`;
        reconRestoreStatus.className = 'recon-status ok';
      } catch (e) {
        reconRestoreStatus.textContent = '✗ ' + e.message;
        reconRestoreStatus.className = 'recon-status fail';
      }
      setTimeout(() => { reconRestoreStatus.textContent = ''; reconRestoreStatus.className = 'recon-status'; }, 4000);
      btnReconRestore.textContent = '↓ Restore selected';
      btnReconRestore.disabled = false;
    });
  }
  if (btnReconUpload) {
    btnReconUpload.addEventListener('click', async () => {
      const ids = gatherChecked('.recon-pick-local');
      if (!ids.length) {
        reconUploadStatus.textContent = 'no rows selected';
        reconUploadStatus.className = 'recon-status fail';
        setTimeout(() => { reconUploadStatus.textContent = ''; reconUploadStatus.className = 'recon-status'; }, 2200);
        return;
      }
      if (!confirm(`Force-upload ${ids.length} file${ids.length === 1 ? '' : 's'}, bypassing the date gate? This is intended for pre-built classes or rare edge cases — don't use it to push prior-week leftovers.`)) return;
      btnReconUpload.disabled = true;
      btnReconUpload.textContent = '↑ Uploading…';
      try {
        const res = await window.westEngine.reconcileUploadOverride(ids);
        if (!res || !res.ok) throw new Error((res && res.error) || 'upload failed');
        reconUploadStatus.textContent = `✓ ${res.uploaded} uploaded${res.failed ? ` · ${res.failed} failed` : ''}`;
        reconUploadStatus.className = 'recon-status ok';
      } catch (e) {
        reconUploadStatus.textContent = '✗ ' + e.message;
        reconUploadStatus.className = 'recon-status fail';
      }
      setTimeout(() => { reconUploadStatus.textContent = ''; reconUploadStatus.className = 'recon-status'; }, 4000);
      btnReconUpload.textContent = '↑ Upload selected (override gate)';
      btnReconUpload.disabled = false;
    });
  }

  // Copy test URL — reads the visible value (which the render pass keeps
  // in sync with state.testUrl from main). Flash green on success.
  $('#btnCopyTestUrl').addEventListener('click', async () => {
    const btn  = $('#btnCopyTestUrl');
    const text = $('#testUrlVal').textContent.trim();
    if (!text || text === '—') return;
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add('copied');
      btn.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = 'Copy'; }, 1500);
    } catch (e) {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });

  $('#btnOpenTestUrl').addEventListener('click', () => {
    window.westEngine.openTestUrl();
  });

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

  // ── UDP routing — lock checkbox + editable port overrides (3.1.9) ──────
  // Fields default to LOCKED (read-only) so operators don't accidentally
  // edit during a show. Unlocking enables the inputs; saving on `change`
  // (blur or Enter) writes to config + rebinds UDP listeners. The lock
  // re-locks itself after a successful save so the operator can't forget.
  const sbRoutingLock = $('#sbRoutingLock');
  const portInputs = [
    { el: $('#sbInputPortInput'),    key: 'inputPortOverride'    },
    { el: $('#sbRsserverHostInput'), key: 'rsserverHostOverride' },
    { el: $('#sbRsserverPortInput'), key: 'rsserverPortOverride' },
  ];
  function applyRoutingLock() {
    const locked = sbRoutingLock.checked;
    for (const { el } of portInputs) {
      if (el) el.disabled = locked;
    }
  }
  if (sbRoutingLock) {
    sbRoutingLock.addEventListener('change', applyRoutingLock);
    applyRoutingLock();
  }

  // Save handler — fires on blur or Enter. Empty string = clear override
  // (revert to auto-detect). Status text shows the result for a moment.
  async function savePortField(input, key) {
    if (!input) return;
    const raw = input.value.trim();
    portSaveInFlight.add(input.id);
    const statusEl = $('#sbRoutingStatus');
    try {
      const patch = {};
      patch[key] = raw;
      const res = await window.westEngine.saveSettings(patch);
      if (!res.ok) throw new Error(res.error || 'save failed');
      if (statusEl) {
        statusEl.textContent = '✓ saved · listeners rebound';
        statusEl.className = 'sb-routing-status ok';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'sb-routing-status'; }, 2400);
      }
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = '✗ ' + e.message;
        statusEl.className = 'sb-routing-status fail';
        setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'sb-routing-status'; }, 4000);
      }
    } finally {
      portSaveInFlight.delete(input.id);
    }
  }
  for (const { el, key } of portInputs) {
    if (!el) continue;
    el.addEventListener('change', () => savePortField(el, key));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  }

  $('#btnOpenLog').addEventListener('click', () => window.westEngine.openLog());
  $('#btnOpenAdmin').addEventListener('click', () => window.westEngine.openAdmin());

  // ── Mode pill — click to change pipeline mode ──────────────────────────
  // Four modes from the {show selected × pass-through} matrix. Picking a
  // mode that requires a show, when no show is selected, opens the picker
  // first; the chosen pass-through state is then applied on save.
  const modePill     = $('#modePill');
  const modePillMenu = $('#modePillMenu');
  let pendingPassthroughAfterPick = null; // set when picker is opened from the menu

  function closeModeMenu() { modePillMenu.hidden = true; }
  function openModeMenu() {
    // Mark the current mode for visual emphasis
    const showSel = !!(lastState && lastState.config);
    const ptOn    = !lastState || lastState.passthrough !== false;
    const cur = showSel && ptOn ? 'full'
              : showSel && !ptOn ? 'website'
              : !showSel && ptOn ? 'passthrough'
              : 'idle';
    modePillMenu.querySelectorAll('.mode-pill-menu-item').forEach(b =>
      b.classList.toggle('is-current', b.dataset.mode === cur));
    modePillMenu.hidden = false;
  }

  modePill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modePillMenu.hidden) openModeMenu(); else closeModeMenu();
  });

  // Clicking outside the pill/menu closes it
  document.addEventListener('click', (e) => {
    if (modePillMenu.hidden) return;
    if (e.target.closest('.mode-pill-wrap')) return;
    closeModeMenu();
  });

  async function setPassthroughTo(want) {
    const cur = !lastState || lastState.passthrough !== false;
    if (cur === want) return; // no-op
    try { await window.westEngine.toggleForwarding(); } catch (e) {}
  }

  modePillMenu.querySelectorAll('.mode-pill-menu-item').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mode = btn.dataset.mode;
      const showSel = !!(lastState && lastState.config);
      closeModeMenu();

      if (mode === 'full' || mode === 'website') {
        const wantPt = (mode === 'full');
        if (!showSel) {
          // Need a show — open picker. Apply pass-through after save.
          pendingPassthroughAfterPick = wantPt;
          openPicker();
          return;
        }
        await setPassthroughTo(wantPt);
        return;
      }

      if (mode === 'passthrough' || mode === 'idle') {
        const wantPt = (mode === 'passthrough');
        if (showSel) {
          const ok = confirm(
            `Drop the current show?\n\nWorker posts (.cls / tsked / UDP events / heartbeat) will stop.\n\nUDP pass-through to RSServer will ${wantPt ? 'keep running' : 'also stop'}.`);
          if (!ok) return;
          try { await window.westEngine.clearShow(); } catch (e) {}
        }
        await setPassthroughTo(wantPt);
        return;
      }
    });
  });

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
  if ($('#featAutoStart')) wireFeatureToggle('featAutoStart', 'autoStart');

  // ── Settings inputs — dirty-track + Save / Revert ──────────────────────
  ['setClsDir', 'setTskedPath', 'setRyegateConf'].forEach(id => {
    document.getElementById(id).addEventListener('input', markSettingsDirty);
  });

  // ── Credentials — separate from path settings; reuses save-credentials IPC.
  ['setWorkerUrl', 'setAuthKey'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { credsDirty = true; });
  });

  // ── Updater buttons ────────────────────────────────────────────────────
  $('#btnCheckUpdate').addEventListener('click', async () => {
    const btn = $('#btnCheckUpdate');
    btn.disabled = true;
    try { await window.westEngine.checkForUpdate(); }
    finally { btn.disabled = false; }
  });

  $('#btnInstallUpdate').addEventListener('click', async () => {
    const ok = confirm('Download the update, verify, and restart the engine?\n\nThe engine will be unavailable for ~5 seconds during the swap. UDP listener and worker posts pause briefly.');
    if (!ok) return;
    const statusEl = $('#updateStatus');
    statusEl.textContent = 'downloading…';
    statusEl.className = 'update-status';
    try {
      const res = await window.westEngine.installUpdate();
      if (!res.ok) {
        statusEl.textContent = '✗ ' + (res.error || 'failed');
        statusEl.className = 'update-status fail';
        return;
      }
      statusEl.textContent = '✓ exiting…';
      statusEl.className = 'update-status ok';
      // Engine will exit and be relaunched by the swap helper.
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.className = 'update-status fail';
    }
  });

  // 3.2.2 — rollback button. Same restart cycle as install: writes a
  // swap batch, exits, batch relaunches off the previous asar.
  $('#btnRollback').addEventListener('click', async () => {
    const upd = (lastState && lastState.update) || {};
    const prev = upd.previous;
    const target = prev && prev.version ? `version ${prev.version}` : 'the previously-installed version';
    const ok = confirm(`Roll back the engine to ${target} and restart?\n\nThe engine will be unavailable for ~5 seconds during the swap. The current version remains as the new "previous" so you can swap forward again.`);
    if (!ok) return;
    const statusEl = $('#rollbackStatus');
    statusEl.textContent = 'rolling back…';
    statusEl.className = 'update-status';
    try {
      const res = await window.westEngine.rollbackEngine();
      if (!res || !res.ok) {
        statusEl.textContent = '✗ ' + ((res && res.error) || 'failed');
        statusEl.className = 'update-status fail';
        return;
      }
      statusEl.textContent = '✓ exiting…';
      statusEl.className = 'update-status ok';
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.className = 'update-status fail';
    }
  });

  // Topbar update pill → activate Settings tab
  $('#updatePill').addEventListener('click', () => {
    activateTab('settings');
    // Scroll the Updates fieldset into view
    setTimeout(() => {
      const el = document.querySelector('fieldset.settings-group legend');
      if (el && el.parentElement) el.parentElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  });

  $('#btnSaveCreds').addEventListener('click', async () => {
    const url = $('#setWorkerUrl').value.trim();
    const key = $('#setAuthKey').value.trim();
    const statusEl = $('#credsStatus');
    const btn = $('#btnSaveCreds');
    statusEl.textContent = 'testing…';
    statusEl.className = 'creds-status';
    btn.disabled = true;
    try {
      const res = await window.westEngine.saveCredentials(url, key);
      if (!res.ok) {
        statusEl.textContent = '✗ ' + (res.error || 'failed');
        statusEl.className = 'creds-status fail';
        return;
      }
      statusEl.textContent = '✓ saved';
      statusEl.className = 'creds-status ok';
      credsDirty = false;
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'creds-status'; }, 2400);
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.className = 'creds-status fail';
    } finally {
      btn.disabled = false;
    }
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
