#!/bin/sh
# Build a local, Node-free dev site in local/www that loads src/*.mjs directly
# as ES modules, with the KnotInfo/LinkInfo data files taken from the gh-pages branch.
set -e
cd "$(dirname "$0")/.."
WWW=local/www
mkdir -p "$WWW"
for f in $(git ls-tree --name-only origin/gh-pages | grep -E '^(knotinfo|linkinfo|green).*\.js$'); do
  [ -f "$WWW/$f" ] || git show "origin/gh-pages:$f" > "$WWW/$f"
done
ln -sfn ../../src "$WWW/src"
ln -sf ../test_draw.js "$WWW/test_draw.js"
ln -sf ../../static/style.css "$WWW/style.css"
ln -sf ../../static/icons.svg "$WWW/icons.svg"
sed -e 's|<script src="main.js"></script>|<script type="module" src="src/main.mjs"></script>|' -e 's|<script src="\([a-z_0-9-]*\.js[^"]*\)"\( defer\)\{0,1\}>|<script type="module" src="\1">|' static/index.html > "$WWW/index.html"
echo "Set up $WWW"
