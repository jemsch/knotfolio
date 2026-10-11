#!/bin/sh
# Assemble a Node-free KnotFolio site that loads src/*.mjs directly as ES modules,
# with the KnotInfo/LinkInfo data files taken from kmill/knotfolio's gh-pages branch.
#
#   sh local/setup.sh                 # local dev site in local/www (symlinks, so edits show on reload)
#   sh local/setup.sh _site copy      # standalone copy, used by the GitHub Pages workflow
set -e
cd "$(dirname "$0")/.."
WWW=${1:-local/www}
MODE=${2:-link}
mkdir -p "$WWW"

DATA_REF=upstream/gh-pages
if ! git rev-parse -q --verify "$DATA_REF" >/dev/null; then
  git fetch -q --depth=1 https://github.com/kmill/knotfolio.git gh-pages
  DATA_REF=FETCH_HEAD
fi
for f in $(git ls-tree --name-only "$DATA_REF" | grep -E '^(knotinfo|linkinfo|green).*\.js$'); do
  [ -f "$WWW/$f" ] || git show "$DATA_REF:$f" > "$WWW/$f"
done

if [ "$MODE" = copy ]; then
  rm -rf "$WWW/src"
  cp -R src "$WWW/src"
  cp static/style.css static/icons.svg "$WWW/"
else
  ln -sfn ../../src "$WWW/src"
  ln -sf ../test_draw.js "$WWW/test_draw.js"
  ln -sf ../../static/style.css "$WWW/style.css"
  ln -sf ../../static/icons.svg "$WWW/icons.svg"
fi
sed -e 's|<script src="main.js"></script>|<script type="module" src="src/main.mjs"></script>|' -e 's|<script src="\([a-z_0-9-]*\.js[^"]*\)"\( defer\)\{0,1\}>|<script type="module" src="\1">|' static/index.html > "$WWW/index.html"
echo "Set up $WWW"
