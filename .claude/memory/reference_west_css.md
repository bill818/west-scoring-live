---
name: west.css central stylesheet
description: Single shared stylesheet every v3 page links to — the place to make global design/token changes
type: reference
originSessionId: c85fc7d4-2e35-4918-83be-0b377611108d
---
`v3/pages/west.css` is the single shared stylesheet for every v3 HTML page. Tokens at the top, component rules below. Edit there → applies everywhere.

Page-specific class names don't collide because the pages use different namespaces (admin: `.app/.sidebar/.ring-row`; index: `.page/.toolbar/.show-card`).

When making site-wide design changes (color tokens, font-family swap, spacing), do it here, not page-by-page. Then run through each page once to verify nothing regressed (the rules are tightly scoped, so regression is rare).

Currently ~734 lines. If it grows past ~1500 or starts having clear sub-domains (e.g. admin-only chunks), consider splitting — but the single-file model is the working norm.
