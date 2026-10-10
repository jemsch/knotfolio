#!/bin/sh
# Serve the local dev site at http://localhost:8000 (re-runs setup to pick up index.html changes).
cd "$(dirname "$0")" && sh setup.sh && cd www && exec python3 -m http.server 8000
