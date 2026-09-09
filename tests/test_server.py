import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import threading
import unittest
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('serve', Path(__file__).resolve().parents[1] / 'scripts/serve.py')
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'dist').mkdir()
        (self.root / 'dist/index.html').write_text('viewer fixture')
        (self.root / 'dist/dds.worker-fixture.js').write_text('// decoder')
        self.access = self.root / 'auth.json'
        self.access.write_text(json.dumps({'username': 'fixture', 'digest_ha1': hashlib.md5(f'fixture:{serve.REALM}:synthetic-test-password'.encode()).hexdigest()}))
        self.before = self.access.read_bytes()
        (self.root / 'library').mkdir()
        (self.root / 'library/test.txt').write_bytes(b'0123456789')
        self.server = serve.ViewerServer(('127.0.0.1', 0), self.root / 'dist', self.access, [{'id': 'test', 'label': 'Test library', 'path': str(self.root / 'library')}])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/'
        auth = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        auth.add_password(serve.REALM, self.url, 'fixture', 'synthetic-test-password')
        self.client = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(auth))

    def tearDown(self):
        self.assertEqual(self.access.read_bytes(), self.before)
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def test_library_root_config_accepts_powershell_single_object(self):
        row = {'id': 'replay_zone', 'label': 'Replay fastfiles', 'path': 'D:/Replay/zone'}
        self.assertEqual(serve.normalized_library_roots(row), [row])
        self.assertEqual(serve.normalized_library_roots([row]), [row])
        with self.assertRaisesRegex(ValueError, 'object or array'):
            serve.normalized_library_roots('not a root')

    def test_unauthenticated_is_challenged(self):
        with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(self.url)
        self.assertEqual(caught.exception.code, 401)
        self.assertIn(serve.REALM, caught.exception.headers['WWW-Authenticate'])

    def test_same_password_and_restricted_static_root(self):
        with self.client.open(self.url) as response:
            self.assertEqual(response.read(), b'viewer fixture')
            self.assertNotIn("'unsafe-eval'", response.headers['Content-Security-Policy'])
        for path in ['auth.json', '%2e%2e/auth.json', '..%5cauth.json', 'C:/auth.json']:
            with self.assertRaises(urllib.error.HTTPError) as caught: self.client.open(self.url + path)
            self.assertIn(caught.exception.code, [400, 404])
        with self.client.open(self.url + 'dds.worker-fixture.js') as response:
            self.assertIn("'unsafe-eval'", response.headers['Content-Security-Policy'])

    def test_no_upload_endpoint(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.client.open(urllib.request.Request(self.url, data=b'asset', method='POST'))
        self.assertEqual(caught.exception.code, 405)

    def test_server_library_metadata_ranges_and_stale_files(self):
        with self.client.open(self.url + 'api/roots') as response:
            self.assertEqual(json.load(response)['roots'], [{'id': 'test', 'label': 'Test library'}])
        with self.client.open(self.url + 'api/list?root=test') as response:
            entry = json.load(response)['entries'][0]
        query = urllib.parse.urlencode({'root': 'test', 'path': entry['path'], 'size': entry['size'], 'mtime': entry['mtime']})
        url = self.url + 'api/file?' + query
        with self.client.open(urllib.request.Request(url, headers={'Range': 'bytes=2-5'})) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Range'], 'bytes 2-5/10')
            self.assertEqual(response.read(), b'2345')
        (self.root / 'library/test.txt').write_bytes(b'new version')
        with self.assertRaises(urllib.error.HTTPError) as caught: self.client.open(url)
        self.assertEqual(caught.exception.code, 409)
        for endpoint in ['api/list?root=missing', 'api/tree?root=test&path=../dist', 'api/file?root=test&path=../../auth.json']:
            with self.assertRaises(urllib.error.HTTPError) as caught: self.client.open(self.url + endpoint)
            self.assertIn(caught.exception.code, [400, 404])

    def test_extraction_api_requires_auth_csrf_origin_and_contained_paths(self):
        self.server.extractor = serve._extractions.ExtractionManager({'acts': sys.executable, 'game_exe': sys.executable, 'cache': str(self.root / 'cache'), 'reserve_bytes': 0})
        with self.client.open(self.url + 'api/roots') as response:
            config = json.load(response)
        self.assertTrue(config['extraction'])
        def post(path, data, headers=None):
            # Each negative test is a new request; urllib otherwise carries
            # its five-challenge retry counter across these expected failures.
            for handler in self.client.handlers:
                if isinstance(handler, urllib.request.HTTPDigestAuthHandler): handler.reset_retry_count()
            body = data if isinstance(data, bytes) else json.dumps(data).encode()
            return self.client.open(urllib.request.Request(self.url + path, data=body, headers=headers or {}, method='POST'))
        def rejected(code, callback):
            with self.assertRaises(urllib.error.HTTPError) as caught: callback()
            self.assertEqual(caught.exception.code, code)
            caught.exception.close()
        headers = {'X-Zone-Token': config['csrf']}
        self.server.scripts = serve._scripts.ScriptPreviews(Path(sys.executable), self.root / 'cache', serve._extractions.ChildLifetime)
        rejected(403, lambda: post('api/decompile', b'GSC\0'))
        rejected(403, lambda: post('api/decompile', b'GSC\0', dict(headers, Origin='https://unrelated.invalid')))
        rejected(413, lambda: post('api/decompile', b'', dict(headers, **{'Content-Length': str(serve._scripts.MAX_INPUT + 1)})))
        rejected(400, lambda: post('api/decompile', b'invalid script', headers))
        rejected(401, lambda: urllib.request.urlopen(urllib.request.Request(self.url + 'api/uploads', data=b'{}', headers=headers)))
        rejected(403, lambda: post('api/uploads', {}))
        rejected(403, lambda: post('api/uploads', {}, dict(headers, Origin='https://unrelated.invalid')))
        rejected(413, lambda: post('api/uploads', b' ' * 16385, headers))
        rejected(400, lambda: post('api/extractions', {'root': 'test', 'path': '../../auth.json'}, headers))
        rejected(409, lambda: post('api/extractions', {'root': 'test', 'path': 'test.txt', 'size': 999, 'mtime': '0'}, headers))
        self.assertEqual(self.server.extractor.jobs, {})
        with post('api/uploads', {'name': 'invalid.ff', 'size': 16}, headers) as response:
            upload = json.load(response)
        with post(f"api/uploads/{upload['id']}/chunk?offset=0", b'not an IW8 file!', headers) as response:
            self.assertEqual(json.load(response)['offset'], 16)
        rejected(400, lambda: post(f"api/uploads/{upload['id']}/finish", {}, headers))
        with post(f"api/uploads/{upload['id']}/cancel", {}, headers) as response:
            self.assertTrue(json.load(response)['cancelled'])


if __name__ == '__main__': unittest.main()
