#!/usr/bin/env node
/**
 * WEST Scoring Live — Show Linter
 *
 * Crawls a show's worker API (and optionally its rendered pages) and flags
 * data-shape anomalies that tend to surface later as UI bugs or missing
 * entries. Designed to be run after a show day (or during a quiet moment)
 * so Bill can see the red flags in one report instead of eyeballing every
 * class on the live site.
 *
 * Usage:
 *   node scripts/lint-show.js --slug=hits-culpeper-april
 *   node scripts/lint-show.js --slug=X --class-num=291
 *   node scripts/lint-show.js --slug=X --worker=https://alt-worker.workers.dev
 *
 * Exits 0 if nothing above WARN; 1 if any FAIL. Colorized when stdout is a TTY.
 *
 * Rules are inline here for now — split into scripts/lint-rules/ if the set
 * grows past ~15. Each rule takes (ctx) and pushes { level, rule, message }
 * into ctx.findings.
 */

const https = require('https');
const http  = require('http');

// ── ARGS ───────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k, v === undefined ? true : v])
);

if (!args.slug) {
  console.error('Usage: node scripts/lint-show.js --slug=<showSlug> [--class-num=N] [--worker=URL]');
  process.exit(2);
}

const WORKER     = (args.worker || 'https://west-worker.bill-acb.workers.dev').replace(/\/$/, '');
const SLUG       = args.slug;
const CLASS_NUM  = args['class-num'] || null;

// ── COLOR ──────────────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY;
const c = (code, s) => TTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const red    = s => c(31, s);
const yellow = s => c(33, s);
const green  = s => c(32, s);
const dim    = s => c(2,  s);
const bold   = s => c(1,  s);

// ── FETCH HELPERS ──────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── PARSERS ────────────────────────────────────────────────────────────────
// Count entry rows in a Ryegate cls_raw string. Line 1 is the class header;
// every subsequent non-empty line that starts with a number is an entry.
function countClsRawEntries(clsRaw) {
  if (!clsRaw || typeof clsRaw !== 'string') return null;
  const lines = clsRaw.split(/\r?\n/).slice(1); // drop header
  let n = 0;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const first = ln.split(',')[0];
    if (/^\d+$/.test((first || '').trim())) n++;
  }
  return n;
}

// ── RULES ──────────────────────────────────────────────────────────────────
// Each rule: (ctx) => void, pushes { level: 'FAIL'|'WARN'|'INFO', rule, message, context? }
const RULES = [
  // ── Data-shape rules (apply to every class in the show) ──────────────

  {
    name: 'partial-ingest',
    desc: 'cls_raw has entries but D1 entries table is empty (class 291 fingerprint)',
    run(ctx) {
      for (const cls of ctx.classes) {
        const clsRawEntries = countClsRawEntries(cls.cls_raw);
        if (clsRawEntries == null) continue;
        if (clsRawEntries > 0 && (cls.entry_count || 0) === 0) {
          ctx.push('FAIL', this.name, cls,
            `cls_raw lists ${clsRawEntries} entries but entry_count=0. Partial ingest — re-upload the cls file.`);
        }
      }
    },
  },

  {
    name: 'missing-class-type',
    desc: 'class_type empty/null — breaks stats.html type filter',
    run(ctx) {
      for (const cls of ctx.classes) {
        const ct = (cls.class_type || '').toUpperCase();
        if (!ct) {
          ctx.push('FAIL', this.name, cls, 'class_type is empty/null — stats.html will not render this class.');
        } else if (!['J', 'H', 'T', 'E', 'U'].includes(ct)) {
          ctx.push('WARN', this.name, cls, `class_type='${ct}' is not one of J/H/T/E/U — may confuse downstream rendering.`);
        }
      }
    },
  },

  {
    name: 'stale-active-class',
    desc: 'class status=active but untouched > 2 hours (will trip auto-complete sweep)',
    run(ctx) {
      const now = Date.now();
      for (const cls of ctx.classes) {
        if (cls.status !== 'active') continue;
        const t = Date.parse((cls.updated_at || '').replace(' ', 'T') + 'Z');
        if (isNaN(t)) continue;
        const ageMin = (now - t) / 60000;
        if (ageMin > 120) {
          ctx.push('WARN', this.name, cls,
            `active but not updated in ${Math.round(ageMin)} min — either operator never closed it or primary close signals all missed.`);
        }
      }
    },
  },

  {
    name: 'completed-but-no-entries',
    desc: 'status=complete but entry_count=0 (and no cls_raw to explain it)',
    run(ctx) {
      for (const cls of ctx.classes) {
        if (cls.status !== 'complete') continue;
        if ((cls.entry_count || 0) > 0) continue;
        const clsRawEntries = countClsRawEntries(cls.cls_raw);
        if (clsRawEntries && clsRawEntries > 0) continue; // partial-ingest rule already flagged
        ctx.push('WARN', this.name, cls,
          'marked complete with 0 entries and no cls_raw entries. Either genuinely empty, or class was created but never ran.');
      }
    },
  },

  {
    name: 'missing-scoring-method',
    desc: 'scoring_method null/empty on a jumper class',
    run(ctx) {
      for (const cls of ctx.classes) {
        const ct = (cls.class_type || '').toUpperCase();
        if (ct !== 'J' && ct !== 'T') continue;
        if (!cls.scoring_method && cls.scoring_method !== 0 && cls.scoring_method !== '0') {
          ctx.push('FAIL', this.name, cls,
            'jumper/timed class with no scoring_method — stats.html will use fallback labels and may mis-render phase.');
        }
      }
    },
  },

  {
    name: 'future-dated-class',
    desc: 'scheduled_date is more than 2 years in the future (data entry slip)',
    run(ctx) {
      const now = Date.now();
      for (const cls of ctx.classes) {
        if (!cls.scheduled_date) continue;
        const t = Date.parse(cls.scheduled_date);
        if (isNaN(t)) {
          ctx.push('WARN', this.name, cls, `scheduled_date '${cls.scheduled_date}' does not parse as a date.`);
          continue;
        }
        if (t > now + 2 * 365 * 86400000) {
          ctx.push('WARN', this.name, cls, `scheduled_date '${cls.scheduled_date}' is > 2 years out — likely a typo.`);
        }
      }
    },
  },

  // ── Entry-level rules (require /getResults per class) ────────────────

  {
    name: 'entry-no-place-no-status',
    desc: 'entries with no place and no status_code (ghost entry, silent fail)',
    requiresEntries: true,
    run(ctx) {
      for (const c of ctx.classResults) {
        const cls = c.meta;
        const entries = c.entries || [];
        for (const e of entries) {
          const hasPlace   = !!(e.place || e.overallPlace);
          const hasStatus  = !!(e.statusCode || e.r1StatusCode || e.r2StatusCode);
          const hasAnyRun  = !!(e.r1Time || e.r1TotalTime || e.r2Time);
          if (!hasPlace && !hasStatus && !hasAnyRun) {
            ctx.push('WARN', this.name, cls,
              `entry ${e.entryNum || '?'} ${e.horse || ''} / ${e.rider || ''}: no place, no status, no run time — likely a scratch without a status code.`);
          }
        }
      }
    },
  },

  {
    name: 'zero-scores-no-status',
    desc: 'entries with all-zero fault/time fields and no status_code (looks like a clear in 0s, probably a scratch)',
    requiresEntries: true,
    run(ctx) {
      for (const c of ctx.classResults) {
        const cls = c.meta;
        const entries = c.entries || [];
        for (const e of entries) {
          const r1faults = parseFloat(e.r1TotalFaults || e.r1JumpFaults || 0);
          const r1time   = parseFloat(e.r1Time || e.r1TotalTime || 0);
          const hasStatus = !!(e.statusCode || e.r1StatusCode);
          const hasPlace  = !!(e.place || e.overallPlace);
          if (!hasStatus && r1faults === 0 && r1time === 0 && !hasPlace) {
            ctx.push('WARN', this.name, cls,
              `entry ${e.entryNum || '?'} ${e.horse || ''}: all-zero scoring fields with no status and no place. If this rider didn't actually go clear in 0s, needs a status code.`);
          }
        }
      }
    },
  },
];

// ── RUNNER ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(bold(`Linting show: ${SLUG}`) + (CLASS_NUM ? `  (class ${CLASS_NUM} only)` : ''));
  console.log(dim(`Worker: ${WORKER}`));
  console.log('');

  const pub = await fetchJson(`${WORKER}/getClasses?slug=${encodeURIComponent(SLUG)}`);
  let classes = pub.classes || [];

  if (CLASS_NUM) classes = classes.filter(c => String(c.class_num) === String(CLASS_NUM));
  if (classes.length === 0) {
    console.log(yellow('No matching classes found.'));
    process.exit(0);
  }

  // Fetch per-class /getResults for entry-level rules
  const entryRuleNeeded = RULES.some(r => r.requiresEntries);
  const classResults = [];
  if (entryRuleNeeded) {
    for (const cls of classes) {
      try {
        const r = await fetchJson(
          `${WORKER}/getResults?slug=${encodeURIComponent(SLUG)}&classNum=${encodeURIComponent(cls.class_num)}&ring=${encodeURIComponent(cls.ring || '1')}`
        );
        const entries = r.computed?.entries || r.entries || [];
        classResults.push({ meta: cls, entries });
      } catch (e) {
        classResults.push({ meta: cls, entries: [], fetchError: e.message });
      }
    }
  }

  const findings = [];
  const ctx = {
    classes,
    classResults,
    push(level, rule, cls, message) {
      findings.push({ level, rule, classNum: cls.class_num, className: cls.class_name || '', message });
    },
  };

  for (const rule of RULES) rule.run(ctx);

  // ── Report ─────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log(green(`✓ ${classes.length} class(es) checked — no findings.`));
    process.exit(0);
  }

  const byLevel = { FAIL: 0, WARN: 0, INFO: 0 };
  for (const f of findings) byLevel[f.level]++;

  // Group by class for readability
  const byClass = new Map();
  for (const f of findings) {
    const k = `${f.classNum}|${f.className}`;
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k).push(f);
  }

  for (const [k, items] of byClass) {
    const [num, name] = k.split('|');
    console.log(bold(`Class ${num}`) + dim(`  ${name}`));
    for (const f of items) {
      const tag = f.level === 'FAIL' ? red('FAIL') : f.level === 'WARN' ? yellow('WARN') : dim('INFO');
      console.log(`  [${tag}] ${dim(f.rule)}  ${f.message}`);
    }
    console.log('');
  }

  const summary = `${classes.length} class(es), ` +
    (byLevel.FAIL ? red(`${byLevel.FAIL} FAIL`) : green('0 FAIL')) + ', ' +
    (byLevel.WARN ? yellow(`${byLevel.WARN} WARN`) : `${byLevel.WARN} WARN`) +
    (byLevel.INFO ? `, ${byLevel.INFO} INFO` : '');
  console.log(bold('Summary: ') + summary);

  process.exit(byLevel.FAIL > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(red('Linter crashed: ' + e.message));
  console.error(e.stack);
  process.exit(2);
});
