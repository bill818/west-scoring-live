// WEST Engine — folder/website reconciliation (Phase C).
//
// Compares the local Ryegate .cls folder against the website's R2 inventory
// (GET /v3/listCls?slug=X&ring=N) and reports the diff. Three buckets:
//
//   localOnly  — file present locally, no matching class_id on the website.
//                Each carries a `gate` field with the result of the same
//                shouldUploadCls() check the upload path uses, so the
//                renderer can default-check upload-able files and warn on
//                ones the date gate would refuse.
//
//   serverOnly — class_id exists on the website but no local file. Prime
//                candidates for "restore down" after a PC swap or after the
//                operator emptied the Ryegate folder.
//
//   both       — class_id present in both places. We don't compare content
//                here (would require MD5'ing every local file on every
//                refresh); counted only.
//
// Pure diff — no IPC, no fs writes. main.js wraps the result in IPC handlers
// for the renderer (restore-selected, force-upload-selected, refresh-now).

'use strict';

const fs   = require('fs');
const path = require('path');

function classIdFromFilename(filename) {
  if (!filename.toLowerCase().endsWith('.cls')) return null;
  const base = filename.slice(0, -4);
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(base)) return null;
  return base;
}

// Scan the watch folder. Returns sorted entries by class_id. Skipped files
// (non-.cls, bad characters) are simply omitted — same filter the watcher
// applies, so the diff matches what the upload path sees.
function scanLocalCls(clsDir) {
  let entries;
  try { entries = fs.readdirSync(clsDir); }
  catch (e) { return { ok: false, error: e.message, files: [] }; }
  const out = [];
  for (const filename of entries) {
    const class_id = classIdFromFilename(filename);
    if (!class_id) continue;
    const full = path.join(clsDir, filename);
    let st;
    try { st = fs.statSync(full); }
    catch (e) { continue; }
    out.push({
      class_id,
      filename,
      full,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
  out.sort((a, b) => a.class_id.localeCompare(b.class_id, undefined, { numeric: true }));
  return { ok: true, files: out };
}

// Fetch the website's R2 inventory for this (slug, ring) pair.
async function fetchServerCls(workerUrl, authKey, slug, ringNum) {
  const url = `${workerUrl}/v3/listCls?slug=${encodeURIComponent(slug)}&ring=${ringNum}`;
  const res = await fetch(url, { headers: { 'X-West-Key': authKey } });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
    return { ok: false, error: msg, files: [] };
  }
  const data = await res.json();
  const files = (data.files || []).slice().sort((a, b) =>
    a.class_id.localeCompare(b.class_id, undefined, { numeric: true })
  );
  return { ok: true, files };
}

// Compute the three-way diff. shouldUploadCls is the same gate function
// the upload path uses (passed in so we don't duplicate gate logic). For
// every localOnly file we ALSO read its bytes so the parser can decide
// test-class status — this is the only place we incur disk reads beyond
// stat(), so it's bounded by the local-only count, not the full folder.
function diff(local, server, shouldUploadCls) {
  const localByCid  = new Map(local.map(f => [f.class_id, f]));
  const serverByCid = new Map(server.map(f => [f.class_id, f]));

  const localOnly  = [];
  const serverOnly = [];
  const both       = [];

  for (const f of local) {
    if (serverByCid.has(f.class_id)) {
      both.push({ class_id: f.class_id, local: f, server: serverByCid.get(f.class_id) });
    } else {
      // Read bytes for the gate (needs class_name to detect /test/i). If
      // the read fails the gate sees null bytes — gate will likely allow
      // under "no-meta" or block — either way the operator can review.
      let bytes = null;
      try { bytes = fs.readFileSync(f.full); } catch (e) {}
      const gate = bytes
        ? shouldUploadCls(f.filename, f.mtimeMs, bytes)
        : { allow: false, reason: 'read-failed' };
      localOnly.push({
        class_id: f.class_id,
        filename: f.filename,
        mtimeMs:  f.mtimeMs,
        size:     f.size,
        gate,     // { allow, reason }
      });
    }
  }
  for (const f of server) {
    if (!localByCid.has(f.class_id)) {
      serverOnly.push({
        class_id: f.class_id,
        size:     f.size,
        uploaded: f.uploaded,
      });
    }
  }

  return { localOnly, serverOnly, both: both.length };
}

module.exports = {
  classIdFromFilename,
  scanLocalCls,
  fetchServerCls,
  diff,
};
