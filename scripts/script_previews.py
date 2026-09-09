"""Bounded, content-addressed ACTS IW8 decompilation for one selected script."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import threading
import time
import zlib

MAX_INPUT = 8 * 1024 ** 2
MAX_SOURCE = 8 * 1024 ** 2


def validate(data):
    if not 16 <= len(data) <= MAX_INPUT or data[:4] != b'GSC\0':
        raise ValueError('Select an ACTS IW8 GSCBIN script (maximum 8 MB).')
    packed, size, bytecode = struct.unpack_from('<III', data, 4)
    if packed + bytecode + 16 != len(data) or not bytecode or size > 16 * 1024 ** 2:
        raise ValueError('Invalid GSCBIN lengths or script exceeds the preview limit.')
    try:
        decoder = zlib.decompressobj()
        stack = decoder.decompress(data[16:16 + packed], size + 1)
        if len(stack) != size or not decoder.eof or decoder.unused_data:
            raise ValueError('Invalid compressed GSCBIN stack.')
    except zlib.error as error:
        raise ValueError('Invalid compressed GSCBIN stack.') from error


class ScriptPreviews:
    def __init__(self, acts, cache, lifetime):
        self.acts, self.cache, self.lifetime = Path(acts), Path(cache) / 'script-previews', lifetime
        self.lock = threading.Lock()

    def decompile(self, data):
        validate(data)
        if not self.lock.acquire(timeout=2):
            raise ValueError('Another script is being decompiled. Try again shortly.')
        try:
            identities = [(str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in
                          [self.acts, self.acts.with_name('acts-common.dll')] if p.is_file()]
            key = hashlib.sha256(data + json.dumps(['iw8-preview-v1', identities]).encode()).hexdigest()
            folder = self.cache / key
            result_file = folder / 'preview.json'
            if result_file.is_file():
                return json.loads(result_file.read_text(encoding='utf-8'))
            self.cache.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self.cache).free < 256 * 1024 ** 2:
                raise ValueError('Insufficient disk space for a script preview.')
            folder.mkdir(exist_ok=True)
            source = folder / 'script.gscbin'
            source.write_bytes(data)
            output = folder / 'source'
            command = [str(self.acts), '--noUpdater', 'gscd', '-g', '-v', 'iw8', '-f', 'iw',
                       '--path-output', '-o', str(output), str(source)]
            with (folder / 'acts.log').open('wb') as log:
                child = subprocess.Popen(command, cwd=self.acts.parent, stdout=log, stderr=subprocess.STDOUT,
                                         creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                try:
                    guard = self.lifetime(child)
                except Exception:
                    child.kill(); child.wait()
                    raise
                try:
                    deadline = time.monotonic() + 45
                    while child.poll() is None:
                        if time.monotonic() > deadline or log.tell() > 2 * 1024 ** 2 or any(p.stat().st_size > MAX_SOURCE for p in output.glob('*.gsc')):
                            child.kill(); child.wait()
                            raise ValueError('Script decompilation exceeded its time or output limit.')
                        time.sleep(.05)
                finally:
                    guard.close()
            candidates = list(output.glob('*.gsc'))
            if not candidates:
                raise ValueError('ACTS could not decompile this script. The original remains available.')
            if len(candidates) != 1 or candidates[0].stat().st_size > MAX_SOURCE:
                raise ValueError('Decompiled source exceeds the preview limit.')
            text = candidates[0].read_text(encoding='utf-8', errors='replace')
            log = (folder / 'acts.log').read_text(encoding='utf-8', errors='replace')[:32768]
            partial = child.returncode != 0 or bool(re.search(r'<err\w*:|Can.t decompile|BAD_OPCODE|Invalid opcode', text + log, re.I))
            unresolved = bool(re.search(r'\b(?:ref|function|method)_[0-9a-f]+\b', text))
            warnings = []
            if partial: warnings.append('ACTS could not reconstruct every expression. Error markers are retained in the source.')
            if unresolved: warnings.append('Some symbol names are unavailable; ACTS numeric identifiers are retained.')
            result = {'source': text, 'status': 'partial' if partial else 'complete', 'warnings': warnings,
                      'language': 'gsc', 'engine': 'iw8', 'sha256': hashlib.sha256(data).hexdigest()}
            temporary = result_file.with_suffix('.tmp')
            temporary.write_text(json.dumps(result), encoding='utf-8'); temporary.replace(result_file)
            return result
        finally:
            self.lock.release()
