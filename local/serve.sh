#!/bin/sh
# Serve the local dev site at http://localhost:8000 (re-runs setup to pick up index.html changes).
# Files are sent with no-cache headers so that edits to src/ always show up on reload.
cd "$(dirname "$0")" && sh setup.sh && cd www && exec python3 -c '
import http.server
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
http.server.ThreadingHTTPServer(("", 8000), H).serve_forever()
'
