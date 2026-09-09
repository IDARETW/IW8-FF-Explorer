#!/usr/bin/env python3
"""Serve the built MW2019 Replay viewer with a local Digest access verifier."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.server
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request
import importlib.util

_spec = importlib.util.spec_from_file_location('zone_extractions', Path(__file__).with_name('extractions.py'))
_extractions = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_extractions)
_script_spec = importlib.util.spec_from_file_location('zone_script_previews', Path(__file__).with_name('script_previews.py'))
_scripts = importlib.util.module_from_spec(_script_spec)
_script_spec.loader.exec_module(_scripts)

REALM = 'MW2019 Replay Fastfile Viewer'
NONCE_TTL = 600
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
       "media-src 'self' blob: data:; connect-src 'self' blob: data:; "
       "worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; "
       "base-uri 'self'; form-action 'none'")


class ViewerServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root: Path, access_file: Path, library_roots=None, extraction_config=None):
        root = root.resolve(strict=True)
        if not (root / 'index.html').is_file():
            raise ValueError('Build the viewer first: npm run build')
        auth = json.loads(access_file.read_text(encoding='utf-8-sig'))
        self.username = auth['username']
        self.ha1 = auth['digest_ha1']
        if not isinstance(self.username, str) or not self.username or not re.fullmatch(r'[a-fA-F0-9]{32}', self.ha1):
            raise ValueError('The viewer access file has no valid Digest verifier. Run scripts/configure-replay.ps1 first.')
        self.ha1 = self.ha1.lower()
        self.root = root
        self.access_file = access_file.resolve()
        self.library_roots = {}
        for item in library_roots or []:
            if not re.fullmatch(r'[a-z0-9_-]{1,40}', item['id']):
                raise ValueError('Invalid library root id.')
            folder = Path(item['path']).resolve(strict=True)
            if not folder.is_dir() or item['id'] in self.library_roots:
                raise ValueError('Library root is missing or duplicated.')
            self.library_roots[item['id']] = {'path': folder, 'label': str(item['label'])}
        self.key = secrets.token_bytes(32)
        self.seen = {}
        self.lock = threading.Lock()
        self.csrf = secrets.token_hex(32)
        self.extractor = _extractions.ExtractionManager(extraction_config) if extraction_config else None
        self.scripts = _scripts.ScriptPreviews(self.extractor.acts, self.extractor.cache, _extractions.ChildLifetime) if self.extractor else None
        if self.extractor:
            self.library_roots['extraction_cache'] = {'path': self.extractor.output, 'label': 'ACTS extraction cache'}
        super().__init__(address, ViewerHandler)

    def server_close(self):
        if self.extractor:
            self.extractor.close()
        super().server_close()


def normalized_library_roots(value):
    """Accept both PowerShell's one-object and JSON's array representations."""
    if isinstance(value, dict):
        return [value]
    if not isinstance(value, list):
        raise ValueError('Library roots must be a JSON object or array of objects.')
    return value


class ViewerHandler(http.server.BaseHTTPRequestHandler):
    server_version = 'ZonePreview'
    sys_version = ''

    def log_message(self, fmt, *args):
        # Do not log Authorization headers or URL query strings.
        print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {self.command} {args[1] if len(args) > 1 else "request"}', flush=True)

    def reply(self, status, body=b'', content_type='text/plain; charset=utf-8', extra=None, decoder_worker=False):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        # Emscripten's embind glue generates call bindings in the isolated DDS
        # worker. Keep string evaluation disabled in the document and other workers.
        self.send_header('Content-Security-Policy', CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'") if decoder_worker else CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def nonce(self):
        value = f'{int(time.time()):x}.{secrets.token_hex(16)}'
        return value + '.' + hmac.new(self.server.key, value.encode(), hashlib.sha256).hexdigest()

    def valid_nonce(self, value):
        try:
            stamp, random, signature = value.split('.')
            timestamp = int(stamp, 16)
            expected = hmac.new(self.server.key, f'{stamp}.{random}'.encode('ascii'), hashlib.sha256).hexdigest()
            return -5 <= time.time() - timestamp <= NONCE_TTL and hmac.compare_digest(signature, expected)
        except (ValueError, UnicodeEncodeError):
            return False

    def authorized(self):
        header = self.headers.get('Authorization', '')
        if not header.startswith('Digest '):
            return False
        try:
            fields = urllib.request.parse_keqv_list(urllib.request.parse_http_list(header[7:]))
            user, realm, nonce, uri, response, nc, cnonce = (fields[k] for k in ('username', 'realm', 'nonce', 'uri', 'response', 'nc', 'cnonce'))
            if not (hmac.compare_digest(user.encode(), self.server.username.encode())
                    and realm == REALM and uri == self.path and fields.get('qop') == 'auth'
                    and fields.get('algorithm', 'MD5').upper() == 'MD5'
                    and re.fullmatch(r'[0-9a-fA-F]{8}', nc) and int(nc, 16) > 0
                    and 0 < len(cnonce) <= 256 and self.valid_nonce(nonce)):
                return False
            ha2 = hashlib.md5(f'{self.command}:{uri}'.encode()).hexdigest()
            expected = hashlib.md5(f'{self.server.ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}'.encode()).hexdigest()
            if not hmac.compare_digest(response.lower(), expected):
                return False
            key = (nonce, cnonce, nc, self.command, uri)
            now = time.time()
            with self.server.lock:
                self.server.seen = {k: v for k, v in self.server.seen.items() if now - v < NONCE_TTL}
                if key in self.server.seen or len(self.server.seen) >= 16384:
                    return False
                self.server.seen[key] = now
            return True
        except (KeyError, ValueError, TypeError, UnicodeError):
            return False

    def do_GET(self):
        if not self.authorized():
            return self.challenge()
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith('/api/'):
            return self.api(parsed)
        try:
            path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path, errors='strict')
            if '\\' in path or '\x00' in path or any(p in ('.', '..') or ':' in p for p in path.split('/')):
                raise ValueError('Invalid path')
            target = (self.server.root / (path.lstrip('/') or 'index.html')).resolve()
            if not target.is_relative_to(self.server.root) or not target.is_file():
                return self.reply(404, b'Not found.\n')
            if target.stat().st_size > 16 * 1024 * 1024:
                return self.reply(413, b'Static file exceeds preview server limit.\n')
            mime = {'.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css'}.get(target.suffix) or mimetypes.guess_type(target)[0] or 'application/octet-stream'
            return self.reply(200, target.read_bytes(), mime, decoder_worker=target.name.startswith('dds.worker-') and target.suffix == '.js')
        except (OSError, ValueError, UnicodeError):
            return self.reply(400, b'Invalid request path.\n')

    do_HEAD = do_GET

    def json_reply(self, status, value):
        return self.reply(status, json.dumps(value).encode(), 'application/json; charset=utf-8')

    def challenge(self):
        stale = ''
        try:
            fields = urllib.request.parse_keqv_list(urllib.request.parse_http_list(self.headers.get('Authorization', '')[7:]))
            if fields.get('username') == self.server.username and fields.get('nonce') and not self.valid_nonce(fields['nonce']):
                stale = ', stale=true'
        except (ValueError, KeyError):
            pass
        return self.reply(401, b'Sign in with the viewer username and password created during setup.\n', extra={
            'WWW-Authenticate': f'Digest realm="{REALM}", qop="auth", nonce="{self.nonce()}", algorithm=MD5{stale}'
        })

    def library_path(self, query):
        root = self.server.library_roots.get(query.get('root', [''])[0])
        if not root:
            raise ValueError('Choose a configured server location.')
        relative = query.get('path', [''])[0]
        if '\\' in relative or '\x00' in relative or relative.startswith('/'):
            raise ValueError('Invalid library path.')
        parts = relative.split('/')
        if any(p in ('.', '..', '.git', '.local', 'node_modules', '__pycache__') or ':' in p for p in parts):
            raise ValueError('This path is outside the asset library.')
        path = (root['path'] / relative).resolve(strict=True)
        if not path.is_relative_to(root['path']) or path == self.server.access_file:
            raise ValueError('This path is outside the asset library.')
        return root['path'], path

    def api(self, parsed):
        try:
            if parsed.path == '/api/roots':
                return self.json_reply(200, {'roots': [{'id': key, 'label': value['label']} for key, value in self.server.library_roots.items()],
                                            'extraction': bool(self.server.extractor), 'csrf': self.server.csrf if self.server.extractor else None})
            if parsed.path == '/api/extractions' and self.server.extractor:
                return self.json_reply(200, {'jobs': self.server.extractor.recent()})
            match = re.fullmatch(r'/api/extractions/([a-f0-9]{32})(/entries)?', parsed.path)
            if match and self.server.extractor:
                if match[2]:
                    offset = int(urllib.parse.parse_qs(parsed.query).get('offset', ['0'])[0])
                    if not 0 <= offset <= 1000000:
                        raise ValueError('Invalid result page.')
                    return self.json_reply(200, self.server.extractor.entries(match[1], offset))
                return self.json_reply(200, self.server.extractor.snapshot(match[1]))
            query = urllib.parse.parse_qs(parsed.query)
            root, path = self.library_path(query)
            if parsed.path == '/api/file':
                return self.library_file(path, query)
            if parsed.path not in ('/api/list', '/api/tree'):
                return self.json_reply(404, {'error': 'Unknown library endpoint.'})
            if not path.is_dir():
                raise ValueError('Select a folder.')
            recursive = parsed.path == '/api/tree'
            entries, pending = [], [path]
            scanned, started = 0, time.monotonic()
            while pending:
                folder = pending.pop()
                for entry in folder.iterdir():
                    scanned += 1
                    if scanned > 30000 or len(entries) >= 20000 or time.monotonic() - started > 15:
                        raise ValueError('Folder is too large to index. Open a smaller extraction folder.')
                    if entry.name.startswith('.') or entry.name in ('node_modules', '__pycache__') or entry.is_symlink() or entry.is_junction():
                        continue
                    resolved = entry.resolve()
                    if not resolved.is_relative_to(root) or resolved == self.server.access_file:
                        continue
                    directory = entry.is_dir()
                    if directory and recursive:
                        pending.append(entry)
                        continue
                    if not directory and not entry.is_file():
                        continue
                    stat = entry.stat()
                    entries.append({'name': entry.name, 'path': entry.relative_to(root).as_posix(), 'directory': directory, 'size': 0 if directory else stat.st_size, 'mtime': str(stat.st_mtime_ns)})
            entries.sort(key=lambda item: (not item['directory'], item['path'].lower()))
            return self.json_reply(200, {'entries': entries})
        except (FileNotFoundError, KeyError):
            return self.json_reply(404, {'error': 'This file or folder no longer exists.'})
        except (ValueError, OSError, UnicodeError):
            return self.json_reply(400, {'error': 'Cannot read this path. Choose a configured folder with at most 20,000 files.'})

    def library_file(self, path, query):
        if not path.is_file():
            raise ValueError('Select a file.')
        with path.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            if query.get('size', [''])[0] != str(stat.st_size) or query.get('mtime', [''])[0] != str(stat.st_mtime_ns):
                return self.json_reply(409, {'error': 'Server file changed. Open the folder again.'})
            start, end, status = 0, stat.st_size - 1, 200
            range_header = self.headers.get('Range')
            if range_header:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
                if not match or not any(match.groups()) or not stat.st_size:
                    return self.reply(416, extra={'Content-Range': f'bytes */{stat.st_size}'})
                left, right = match.groups()
                if left:
                    start = int(left); end = min(int(right), end) if right else end
                else:
                    start = max(0, stat.st_size - int(right))
                if start > end or start >= stat.st_size:
                    return self.reply(416, extra={'Content-Range': f'bytes */{stat.st_size}'})
                status = 206
            length = max(0, end - start + 1)
            mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
            if not (mime.startswith('audio/') or mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif')):
                mime = 'application/octet-stream'
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(length))
            self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + urllib.parse.quote(path.name))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'private, no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'none'; sandbox")
            self.send_header('Referrer-Policy', 'no-referrer')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{stat.st_size}')
            self.end_headers()
            if self.command == 'HEAD':
                return
            stream.seek(start)
            try:
                while length:
                    chunk = stream.read(min(length, 1024 * 1024))
                    if not chunk:
                        self.close_connection = True
                        break
                    self.wfile.write(chunk); length -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        if not self.authorized():
            return self.challenge()
        if not self.server.extractor:
            return self.json_reply(405, {'error': 'Automatic extraction is not configured on this server.'})
        if not hmac.compare_digest(self.headers.get('X-Zone-Token', ''), self.server.csrf):
            return self.json_reply(403, {'error': 'Refresh the viewer before starting extraction.'})
        origin = self.headers.get('Origin')
        if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get('Host'):
            return self.json_reply(403, {'error': 'Cross-origin extraction requests are not allowed.'})
        try:
            parsed = urllib.parse.urlsplit(self.path)
            match = re.fullmatch(r'/api/uploads/([a-f0-9]{32})/chunk', parsed.path)
            size = int(self.headers.get('Content-Length', '-1'))
            limit = _scripts.MAX_INPUT if parsed.path == '/api/decompile' else _extractions.CHUNK_BYTES if match else 16384
            if not 0 <= size <= limit or self.headers.get('Transfer-Encoding'):
                return self.json_reply(413, {'error': 'Request exceeds the allowed chunk size.'})
            self.connection.settimeout(45)
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError('Request body was interrupted.')
            if parsed.path == '/api/decompile':
                return self.json_reply(200, self.server.scripts.decompile(body))
            if match:
                offset = int(urllib.parse.parse_qs(parsed.query).get('offset', ['-1'])[0])
                return self.json_reply(200, self.server.extractor.upload_chunk(match[1], offset, body))
            data = json.loads(body) if body else {}
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object.')
            if parsed.path == '/api/extractions':
                query = {key: [str(data.get(key, ''))] for key in ('root', 'path')}
                _, path = self.library_path(query)
                stat = path.stat()
                if str(data.get('size')) != str(stat.st_size) or str(data.get('mtime')) != str(stat.st_mtime_ns):
                    return self.json_reply(409, {'error': 'The fastfile changed. Reopen the server folder.'})
                return self.json_reply(202, self.server.extractor.start(path))
            if parsed.path == '/api/uploads':
                return self.json_reply(201, self.server.extractor.create_upload(data.get('name'), data.get('size')))
            match = re.fullmatch(r'/api/uploads/([a-f0-9]{32})/(finish|cancel)', parsed.path)
            if match:
                result = self.server.extractor.finish_upload(match[1]) if match[2] == 'finish' else self.server.extractor.cancel_upload(match[1])
                return self.json_reply(202 if match[2] == 'finish' else 200, result)
            match = re.fullmatch(r'/api/extractions/([a-f0-9]{32})/cancel', parsed.path)
            if match:
                return self.json_reply(200, self.server.extractor.cancel(match[1]))
            return self.json_reply(404, {'error': 'Unknown extraction endpoint.'})
        except KeyError:
            return self.json_reply(404, {'error': 'The upload or extraction is no longer available.'})
        except (ValueError, OSError) as error:
            return self.json_reply(400, {'error': str(error)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent / 'dist')
    parser.add_argument('--access-file', type=Path, required=True, help='Viewer Digest access JSON created by configure-replay.ps1.')
    parser.add_argument('--port', type=int, default=48120)
    parser.add_argument('--library-roots', type=Path, help='Local JSON array of id, label and path for browsable directories.')
    parser.add_argument('--extraction-config', type=Path, help='Local ACTS, Replay and cache configuration JSON.')
    args = parser.parse_args()
    # Cloudflared connects locally. Only the authenticated HTTPS tunnel is public.
    roots = json.loads(args.library_roots.read_text(encoding='utf-8-sig')) if args.library_roots else []
    # Windows PowerShell serializes a single configured root as an object,
    # whereas PowerShell 7 can preserve the one-item array. Both represent
    # the same setup output and must remain supported for downloaders.
    roots = normalized_library_roots(roots)
    config = json.loads(args.extraction_config.read_text(encoding='utf-8-sig')) if args.extraction_config else None
    with ViewerServer(('127.0.0.1', args.port), args.root, args.access_file, roots, config) as server:
        print(f'VIEWER_READY http://127.0.0.1:{args.port}', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
