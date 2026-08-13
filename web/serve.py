#!/usr/bin/env python3
"""
Tiny static server for local testing.

    ./web/serve.py [port]

python -m http.server would mostly work, but it gets .wasm and .webmanifest
content types wrong on some systems (browsers refuse to stream-compile a wasm
file served as application/octet-stream), and it caches aggressively enough that
a rebuilt engine can appear not to have changed. This does neither.

It binds all interfaces so a phone on the same wi-fi can reach it. Note that
without HTTPS the browser will not install the page as an app or run the service
worker anywhere except localhost - that is a browser rule, not a bug here.
"""

import http.server
import socket
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".rsdk": "application/octet-stream",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Always revalidate: a stale engine paired with fresh page code fails in
        # ways that look like engine bugs.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def local_ip():
    """Best guess at the address a phone on the same network should use."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"serving {ROOT} on:")
        print(f"  http://localhost:{PORT}/")
        print(f"  http://{local_ip()}:{PORT}/   <- open this on your phone")
        print("ctrl-c to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
