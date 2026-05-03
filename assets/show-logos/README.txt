Per-show logo files (file-convention as of 2026-05-02).

Drop a PNG named after the show's slug:
  hits-culpeper-april.png
  v3-smoke-test-2026-04.png

The image is referenced as ../../assets/show-logos/<slug>.png from
the v3 pages. If the file doesn't exist, the <img> hides on 404 --
shows without logos render cleanly.

Recommended:
  - Square or landscape, transparent background preferred
  - At least 160px tall (rendered up to 80px on hero, 40px on cards)
  - PNG with alpha; SVG would also work but the file extension is
    fixed at .png in show.html / index.html -- change there if you
    want to allow other formats per show.

To deploy: run deploy-preview.bat at the repo root. The script copies
the whole assets/ tree into _pages_dist before pushing to Pages.
