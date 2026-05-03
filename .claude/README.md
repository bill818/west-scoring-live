# `.claude/` — Cross-machine project context

Most of this folder is gitignored (per-machine state: `settings.local.json`,
`worktrees/`, etc.). Two subfolders are intentionally tracked so they sync
across computers via git:

## `memory/` — Project context for Claude

These are markdown notes Claude reads on cold-start sessions to pick up the
project's conventions, decisions, gotchas, and lookups. The Claude harness
expects them at a per-user path:

    ~/.claude/projects/-Users-<username>-Projects-west-scoring-live/memory/

After cloning this repo on a new machine, mirror the files there:

```bash
mkdir -p ~/.claude/projects/-Users-$USER-Projects-west-scoring-live/memory
cp .claude/memory/*.md ~/.claude/projects/-Users-$USER-Projects-west-scoring-live/memory/
```

(Adjust the path if your home directory or the project location differs.)

The index is `MEMORY.md` — every other file is referenced from there.

## `skills/` — User-scoped skills built for this project

The Claude Code harness loads user skills from `~/.claude/skills/`. Mirror
this folder there:

```bash
mkdir -p ~/.claude/skills
cp -R .claude/skills/* ~/.claude/skills/
```

Currently:

- **`west-design-critic`** — critique web layout / design changes for the
  WEST Scoring v3 project. Knows the design system (Big Shoulders + Inter
  + JetBrains Mono, navy/black palette), the established patterns
  (section-banner / show-hero / row), and the rules (centralized
  templates, recent-round-first for jumpers, mobile sleek ≠ scaled-down
  desktop). Triggers on website-specific design changes.

## What's NOT in here (stays per-machine)

- `~/.cloudflare-env` — Cloudflare API token + account ID for `wrangler
  deploy`. Mode 600. Set up per machine; never commit.
- `.claude/settings.local.json` — per-machine permission allowlist for
  the harness. Yours; doesn't sync.
- `.claude/worktrees/` — local git worktree state.

## After-clone setup checklist

1. `git checkout claude/silly-gagarin-e0c7ff` (or whichever branch is
   current — main once this is merged).
2. Mirror memory + skills to `~/.claude/...` per the bash blocks above.
3. Set up `~/.cloudflare-env` if you'll deploy from this machine
   (see `memory/worker_deploy_setup.md`).
4. `nvm use` (project relies on nvm-installed wrangler).
