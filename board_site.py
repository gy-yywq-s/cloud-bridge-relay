#!/usr/bin/env python3
"""crew board site — enter a 6-char team view key, watch that team's board.

Public-facing but not public-content: every page except the key form requires
a valid per-team view key, resolved against the relay. The key grants VIEW of
one team's board/roster and nothing else; all relay calls happen server-side
with RELAY_TOKEN, which never reaches the browser.

Env: PORT (hostd), RELAY_TOKEN (secret), RELAY_URL (default crew.gaelis.cc).
Stdlib only.
"""
import html
import json
import os
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT") or "8791")
HOST = "127.0.0.1" if os.environ.get("PORT") else "0.0.0.0"
RELAY = os.environ.get("RELAY_URL", "https://crew.gaelis.cc").rstrip("/")
TOKEN = os.environ.get("RELAY_TOKEN", "")

STYLE = """<style>
body{background:#14181b;color:#e7e9ea;font:15px/1.7 ui-monospace,Menlo,monospace;
max-width:840px;margin:40px auto;padding:0 20px}
input{background:#1c2126;border:1px solid #2c333a;color:#e7e9ea;border-radius:8px;
padding:10px 14px;font:inherit;letter-spacing:.2em;width:11ch;text-align:center}
button{background:#5ea8dc;border:0;color:#14181b;border-radius:8px;padding:10px 18px;
font:inherit;font-weight:700;cursor:pointer;margin-left:8px}
pre{white-space:pre-wrap} .err{color:#f0855a} .dim{color:#5e646e;font-size:13px}
h1{font-size:22px} a{color:#5ea8dc}</style>"""


def relay_get(path):
    req = urllib.request.Request(
        RELAY + path, headers={"Authorization": f"Bearer {TOKEN}",
                               "User-Agent": "crew-board-site/1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def form_page(err=""):
    e = f"<p class=err>{html.escape(err)}</p>" if err else ""
    return f"""<!doctype html><meta charset=utf-8><title>crew board</title>{STYLE}
<h1>crew board</h1>
<p>Enter your team's view key (shown at setup, or ask any session for
<code>board_key</code>).</p>{e}
<form method=get action=/>
  <input name=key maxlength=12 autofocus placeholder="a1b2c3">
  <button>view</button>
</form>
<p class=dim>Read-only. One key shows one team.</p>"""


def board_page(key, team):
    try:
        data = relay_get(f"/tasks?team={urllib.parse.quote(team)}")
    except Exception:
        return form_page("relay unreachable, try again")
    body = html.escape(data.get("board", "")) + "\n\n" + html.escape(
        data.get("roster", ""))
    return f"""<!doctype html><meta charset=utf-8>
<meta http-equiv=refresh content="10;url=/?key={urllib.parse.quote(key)}">
<title>crew · {html.escape(team)}</title>{STYLE}
<pre>{body}</pre>
<p class=dim>auto-refreshes every 10s · <a href="/">switch team</a></p>"""


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, text, ctype="text/html; charset=utf-8"):
        data = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # never index, never cache the key in shared caches
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/health":
            return self._send(200, '{"ok": true}', "application/json")
        if u.path != "/":
            return self._send(404, form_page())
        key = urllib.parse.parse_qs(u.query).get("key", [""])[0].strip().lower()
        if not key:
            return self._send(200, form_page())
        try:
            r = relay_get(f"/viewkey?key={urllib.parse.quote(key)}")
        except urllib.error.HTTPError:
            return self._send(200, form_page("unknown key"))
        except Exception:
            return self._send(200, form_page("relay unreachable, try again"))
        if not r.get("team"):
            return self._send(200, form_page("unknown key"))
        return self._send(200, board_page(key, r["team"]))

    def log_message(self, fmt, *args):
        pass  # keys appear in query strings; keep them out of logs


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("RELAY_TOKEN env var required")
    print(f"board site on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
