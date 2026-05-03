-- Migration 030: per-show logo, uploaded via admin → R2.
--
-- logo_url stores the R2 key (e.g. 'show-logos/<slug>.png'). NULL means
-- no logo uploaded. The worker's /v3/showLogo?slug=X endpoint reads
-- this column, fetches from R2, and streams the bytes with the right
-- Content-Type. Spectator pages embed the worker URL as <img src>.
--
-- File-convention logos at assets/show-logos/<slug>.png still work as a
-- fallback when logo_url is NULL — set in show.html / index.html.

ALTER TABLE shows ADD COLUMN logo_url TEXT;
