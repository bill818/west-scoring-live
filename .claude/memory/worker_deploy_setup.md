---
name: Worker deploy setup on this Mac
description: How to deploy west-worker from this Mac — wrangler is installed via nvm, auth via API token in ~/.cloudflare-env
type: reference
originSessionId: 804e6cdc-1fc1-4c25-adf8-3bf080a328fc
---
This Mac is set up for `wrangler deploy` (no Homebrew, no system Node).

**Stack:**
- Node installed via nvm at `~/.nvm` (LTS, currently v24.x)
- wrangler installed globally under nvm (`~/.nvm/versions/node/*/bin/wrangler`)
- Cloudflare API token + account ID stored in `~/.cloudflare-env` (mode 600), sourced from `~/.zshrc`

**Account:** `Bill@west-solutions.com's Account`, ID `acb801ad4373d9f48ac4ce6814d330c0`

**Required token scopes** (learned the hard way — first token was missing two):
- Workers Scripts · Edit
- D1 · Edit
- Workers KV Storage · Edit  (for env.WEST_LIVE binding)
- Workers R2 Storage · Edit  (for env.WEST_R2_CLS binding)
- Cloudflare Pages · Edit  (NOT YET ADDED to the current token —
                             needed for v3-preview deploy. When the
                             next session wants to deploy v3 to a
                             Pages preview branch, ask Bill to add
                             this scope first.)

**Two configs split (since 2026-04-25):**
- `wrangler.worker.toml` — Worker config (bindings, vars, name=`west-worker`)
- `wrangler.toml` — Pages config (`pages_build_output_dir`, name=`westscoring`)
  Pages doesn't accept `--config <path>`, so it must own the canonical name.

**To deploy in a fresh shell session:**
```
source ~/.cloudflare-env
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"

# Worker (must pass --config because the toml is renamed):
wrangler deploy --config wrangler.worker.toml

# Pages preview (stage files into _pages_dist first; toml supplies the rest):
wrangler pages deploy --branch=preview --commit-dirty=true
```

**To apply D1 migrations:** Cloudflare MCP `d1_database_query` works — D1 ID is in `wrangler.toml` (`93f7a6dd-4b4a-4e45-9730-d27aff7dfb19` for WEST_DB_V3).

**Engine still cannot run on this Mac** — wrangler covers Workers + D1 + KV + R2 only; the .cls watcher is Windows-side.
