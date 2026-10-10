# Running KnotFolio locally (no Node needed)

    sh local/serve.sh

then open http://localhost:8000. This builds `local/www/` (git-ignored via `.git/info/exclude`),
which loads `src/*.mjs` directly as ES modules, so edits to `src/` show up on reload.
The KnotInfo/LinkInfo data files are copied from the `origin/gh-pages` branch.

`local/test_draw.js` is a browser test helper that draws synthetic hand-drawn curves.
