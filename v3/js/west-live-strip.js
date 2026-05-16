// WEST.liveStrip — shared "live ring" strip module.
//
// Drop-in commentator/spectator strip showing every live ring on a
// show. One WebSocket per ring (parallels live.html transport); no
// client-side clock interpolation per Bill 2026-05-06 ("we ran into
// this problem before with trying to extrapolate the times" — see
// memory feedback_no_clock_extrapolation.md).
//
// Usage on any v3 page:
//
//   <link rel="stylesheet" href="west.css"><!-- styles already in west.css -->
//   <div id="liveStrip" class="live-strip" hidden></div>
//   <script src="../js/west-api.js"></script>
//   <script src="../js/west-format.js"></script>
//   <script src="../js/west-live-strip.js"></script>
//   <script>
//     WEST.liveStrip.mount({
//       container: document.getElementById('liveStrip'),
//       slug: 'show-slug-here',
//       ringFilter: 1,    // only show ring 1's strip (option A — same-ring scope)
//                         // or omit / pass null to show every live ring on the show
//     });
//   </script>
//
// Returns a handle with .destroy() if the page needs to tear it down
// (single-page navigation, etc).

(function (root) {
  'use strict';
  var WEST = root.WEST = root.WEST || {};
  WEST.liveStrip = WEST.liveStrip || {};

  var escapeHtml = WEST.format && WEST.format.escapeHtml
    ? WEST.format.escapeHtml
    : function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
      }); };

  // UDP fault / rank tags carry prefixes ("JUMP 4" / "TIME 2" /
  // "RANK: 1"). Extract the leading number the same way live.html does.
  function extractNum(val) {
    if (val == null) return null;
    var m = String(val).match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function fmtFaults(fp) {
    if (!fp) return null;
    var jf = extractNum(fp.jump_faults);
    var tf = extractNum(fp.time_faults);
    if (jf == null && tf == null) return null;
    var tot = (jf || 0) + (tf || 0);
    return tot === 0 ? '0F' : (tot + 'F');
  }

  function chipHtml(slug, ringNum, ringName, snapshot) {
    var liveUrl = 'live.html?slug=' + encodeURIComponent(slug) + '&ring_num=' + ringNum;
    var ringLabel = escapeHtml(ringName || ('Ring ' + ringNum));
    var fp = (snapshot && snapshot.focus_preview) || {};

    // Class line — id + name.
    var classIds = (snapshot && snapshot.live_class_ids) || [];
    var classId = fp.class_id || classIds[0] || null;
    var classLabel = classId ? 'Class ' + escapeHtml(String(classId)) : 'Live';
    var className = fp.class_name ? ' — ' + escapeHtml(fp.class_name) : '';

    // On-course line — entry info + stats. Hidden when no on-course
    // identity (between rounds, intro hasn't fired).
    var idBits = [];
    if (fp.entry_num) idBits.push('<span class="ls-entry">#' + escapeHtml(fp.entry_num) + '</span>');
    if (fp.horse)     idBits.push('<span class="ls-horse">' + escapeHtml(fp.horse) + '</span>');
    if (fp.rider)     idBits.push('<span class="ls-rider">' + escapeHtml(fp.rider) + '</span>');
    var stats = [];
    var cd = (fp.countdown || '').replace(/^-/, '');
    if (cd && cd !== '0' && cd !== '00') {
      stats.push('<span class="ls-stat ls-cd">CD ' + escapeHtml(cd) + '</span>');
    } else if (fp.clock) {
      stats.push('<span class="ls-stat ls-clock">' + escapeHtml(fp.clock) + 's</span>');
    }
    if (fp.rank) stats.push('<span class="ls-stat ls-rank">' + escapeHtml(fp.rank) + '</span>');
    var faults = fmtFaults(fp);
    if (faults && faults !== '0F') {
      stats.push('<span class="ls-stat ls-faults">' + escapeHtml(faults) + '</span>');
    }

    var onCourseLine = idBits.length ? (
      '<div class="ls-row ls-row-oc">' +
        '<span class="ls-oc-lbl">On Course</span>' +
        '<span class="ls-id">' + idBits.join(' ') + '</span>' +
        (stats.length ? '<span class="ls-stats">' + stats.join(' ') + '</span>' : '') +
      '</div>'
    ) : '';

    return '<a class="live-strip-chip" data-ring="' + ringNum + '" href="' + liveUrl + '">' +
      '<div class="ls-row ls-row-hdr">' +
        '<span class="ls-dot"></span>' +
        '<span class="ls-ring">' + ringLabel + '</span>' +
      '</div>' +
      '<div class="ls-row ls-row-cls">' +
        '<span class="ls-cls">' + classLabel + '</span>' +
        '<span class="ls-cname">' + className + '</span>' +
      '</div>' +
      onCourseLine +
    '</a>';
  }

  WEST.liveStrip.mount = function (opts) {
    if (!opts || !opts.container || !opts.slug) {
      throw new Error('WEST.liveStrip.mount requires { container, slug }');
    }
    var container = opts.container;
    var slug = opts.slug;
    var ringFilter = (opts.ringFilter == null || isNaN(opts.ringFilter)) ? null : Number(opts.ringFilter);

    // Per-ring runtime state. Keyed by ring_num.
    //   ws       — WebSocket connection
    //   snapshot — last snapshot received
    var stripRings = {};
    var destroyed = false;

    function rerender() {
      if (destroyed) return;
      var liveRings = [];
      for (var k in stripRings) {
        if (!Object.prototype.hasOwnProperty.call(stripRings, k)) continue;
        var r = stripRings[k];
        if (!r.snapshot || !r.snapshot.is_live) continue;
        if (ringFilter != null && r.ring_num !== ringFilter) continue;
        liveRings.push(r);
      }
      liveRings.sort(function (a, b) { return a.ring_num - b.ring_num; });
      if (!liveRings.length) {
        container.hidden = true;
        container.innerHTML = '';
        return;
      }
      container.hidden = false;
      container.innerHTML = liveRings
        .map(function (r) { return chipHtml(slug, r.ring_num, r.ring_name, r.snapshot); })
        .join('');
    }

    function openRingWS(ringNum, ringName) {
      if (destroyed) return;
      var ringState = stripRings[ringNum] = stripRings[ringNum] || { ring_num: ringNum, ring_name: ringName };
      ringState.ring_name = ringName;
      var wsUrl = (WEST.api.BASE.replace(/^http/, 'ws')) +
        '/v3/live?slug=' + encodeURIComponent(slug) + '&ring_num=' + ringNum;
      var ws;
      try { ws = new WebSocket(wsUrl); }
      catch (e) { return; }
      ringState.ws = ws;
      ws.addEventListener('message', function (ev) {
        if (destroyed) return;
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type !== 'snapshot' || !msg.data) return;
        ringState.snapshot = msg.data;
        rerender();
      });
      ws.addEventListener('close', function () {
        if (destroyed) return;
        // 3s reconnect backoff. Commentators tolerate brief gaps; we
        // don't hammer the worker if a DO is restarting.
        setTimeout(function () {
          if (destroyed) return;
          if (stripRings[ringNum] && stripRings[ringNum].ws === ws) {
            openRingWS(ringNum, ringName);
          }
        }, 3000);
      });
      ws.addEventListener('error', function () { /* close handler reconnects */ });
    }

    // Discover rings via /v3/getShowLiveStatus — lightest public
    // endpoint for ring discovery (listRings returns the same set).
    WEST.api.fetchJson('/v3/getShowLiveStatus?slug=' + encodeURIComponent(slug))
      .then(function (data) {
        if (destroyed) return;
        var rings = (data && data.rings) || [];
        rings.forEach(function (r) {
          if (ringFilter != null && r.ring_num !== ringFilter) return;
          openRingWS(r.ring_num, r.ring_name);
        });
      })
      .catch(function () { /* quiet — strip stays empty if discovery fails */ });

    return {
      destroy: function () {
        destroyed = true;
        for (var k in stripRings) {
          if (!Object.prototype.hasOwnProperty.call(stripRings, k)) continue;
          var r = stripRings[k];
          if (r.ws) { try { r.ws.close(); } catch (e) {} }
        }
        stripRings = {};
        container.hidden = true;
        container.innerHTML = '';
      },
    };
  };
})(typeof window !== 'undefined' ? window : global);
