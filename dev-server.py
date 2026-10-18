"""Local dev server: serves the app and mocks the GitHub API on top of photos/.

Usage: python dev-server.py [port] [--open]   ->  http://localhost:8000
Uploads and deletes act on the real photos/ folder, just like commits on GitHub.
"""
import base64
import hashlib
import json
import re
import socket
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
STORE = ROOT / 'photos'
IMAGE_RE = re.compile(r'\.(jpe?g|png|gif|webp|avif)$', re.I)
REPO_RE = re.compile(r'^/api/repos/[^/]+/[^/]+(?P<rest>/.*)?$')


def git_sha(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if self.command != 'GET' or self.path.startswith('/api/'):
            super().log_message(fmt, *args)

    def end_headers(self):
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, status, data=None):
        body = json.dumps(data if data is not None else {}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api_route(self):
        m = REPO_RE.match(unquote(urlparse(self.path).path))
        return None if m is None else (m.group('rest') or '')

    def authorized(self):
        return self.headers.get('Authorization', '').startswith('Bearer ')

    def entry(self, path):
        data = path.read_bytes()
        return {'path': path.relative_to(ROOT).as_posix(), 'type': 'blob', 'sha': git_sha(data), 'size': len(data)}

    def target(self, rest):
        if not rest.startswith('/contents/photos/'):
            return None
        parts = rest.removeprefix('/contents/').split('/')
        if len(parts) > 3 or any(p in ('', '.', '..') or '\\' in p for p in parts):
            return None
        return ROOT.joinpath(*parts)

    def do_GET(self):
        rest = self.api_route()
        if rest is None:
            return super().do_GET()
        if rest == '':
            return self.send_json(200, {'permissions': {'push': self.authorized()}})
        if rest.startswith('/git/trees/'):
            files = [p for p in STORE.rglob('*') if p.is_file() and IMAGE_RE.search(p.name)] if STORE.exists() else []
            return self.send_json(200, {'tree': [self.entry(p) for p in files], 'truncated': False})
        path = self.target(rest)
        if path and path.is_file():
            content = base64.b64encode(path.read_bytes()).decode()
            return self.send_json(200, {**self.entry(path), 'type': 'file', 'content': content})
        self.send_json(404, {'message': 'Not Found'})

    def read_body(self):
        return json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')

    def do_PUT(self):
        rest = self.api_route()
        path = rest and self.target(rest)
        if not path:
            return self.send_json(404, {'message': 'Not Found'})
        if not self.authorized():
            return self.send_json(401, {'message': 'Bad credentials'})
        body = self.read_body()
        existed = path.exists()
        if existed and 'sha' not in body:
            return self.send_json(422, {'message': 'sha wasn\'t supplied'})
        if existed and body['sha'] != self.entry(path)['sha']:
            return self.send_json(409, {'message': 'sha mismatch'})
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(body['content']))
        self.send_json(200 if existed else 201, {'content': self.entry(path)})

    def do_DELETE(self):
        rest = self.api_route()
        path = rest and self.target(rest)
        if not path or not path.exists():
            return self.send_json(404, {'message': 'Not Found'})
        if not self.authorized():
            return self.send_json(401, {'message': 'Bad credentials'})
        if self.read_body().get('sha') != self.entry(path)['sha']:
            return self.send_json(409, {'message': 'sha mismatch'})
        path.unlink()
        # Git has no empty folders, so an emptied album disappears.
        if path.parent != STORE and not any(path.parent.iterdir()):
            path.parent.rmdir()
        self.send_json(200, {'commit': {}})


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return None


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    port = int(args[0]) if args else 8000
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    url = f'http://localhost:{port}'
    print(f'Lara Gallery calisiyor:\n  Bilgisayar: {url}')
    if ip := lan_ip():
        print(f'  Telefon (ayni Wi-Fi): http://{ip}:{port}')
    print('Kapatmak icin bu pencereyi kapat ya da Ctrl+C.')
    if '--open' in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
