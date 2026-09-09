"""Serialized ACTS extraction jobs and chunked fastfile uploads for the viewer."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
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
import uuid
import importlib.util

_material_spec = importlib.util.spec_from_file_location('zone_materials', Path(__file__).with_name('materials.py'))
_materials = importlib.util.module_from_spec(_material_spec); _material_spec.loader.exec_module(_materials)

ACTIVE = {'queued', 'running'}
TERMINAL = {'complete', 'partial', 'failed', 'cancelled'}
CHUNK_BYTES = 4 * 1024 * 1024
MAX_UPLOAD = 4 * 1024 ** 3
REPLAY_VERSIONS = {0xfcd, 0xfcf, 0xfd0, 0xfd1, 0xfd5, 0xfda, 0xfe1, 0xfe3, 0xfee, 0xff3, 0xff5, 0xff7}


class ChildLifetime:
    """Make Windows terminate the ACTS child if the server exits unexpectedly."""
    def __init__(self, process):
        self.handle = None
        if os.name != 'nt':
            return
        import ctypes as c
        from ctypes import wintypes as w
        class Basic(c.Structure):
            _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64), ('flags', w.DWORD),
                        ('min_working', c.c_size_t), ('max_working', c.c_size_t), ('processes', w.DWORD),
                        ('affinity', c.c_size_t), ('priority', w.DWORD), ('scheduling', w.DWORD)]
        class Extended(c.Structure):
            _fields_ = [('basic', Basic), ('io', c.c_uint64 * 6), ('process_memory', c.c_size_t),
                        ('job_memory', c.c_size_t), ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]
        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]; self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        info = Extended(); info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, c.byref(info), c.sizeof(info)):
            error = c.WinError(c.get_last_error()); self.close(); raise error
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            error = c.WinError(c.get_last_error()); self.close(); raise error

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle); self.handle = None


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def file_identity(path):
    stat = path.stat()
    return {'path': str(path.resolve()), 'size': stat.st_size, 'mtime': str(stat.st_mtime_ns)}


def verify_fastfile(path):
    if path.suffix.lower() != '.ff' or not path.is_file():
        raise ValueError('Select a .ff fastfile.')
    with path.open('rb') as stream:
        header = stream.read(16)
    if len(header) != 16 or header[:8] not in (b'IWffc100', b'IWffa100'):
        raise ValueError('This is not an IW8 fastfile. The configured exporter supports MW2019 1.20 Replay.')
    if struct.unpack_from('<I', header, 8)[0] != 11:
        raise ValueError('This fastfile container needs a different game exporter; select an MW2019 Replay fastfile.')
    return struct.unpack_from('<I', header, 12)[0]


def patch_chain(source):
    """Validate Replay's complete embedded base/target headers before invoking ACTS.

    ACTS also validates the headers and decodes/applies the actual delta payload.
    Checking only the target version would allow a patch for another base file.
    """
    version = verify_fastfile(source)
    with source.open('rb') as stream:
        current = stream.read(0x88)
    patches = []
    for suffix, flag in (('.fp', '-p'), ('.fc', '--fc')):
        path = source.with_suffix(suffix)
        if not path.is_file(): continue
        with path.open('rb') as stream:
            header = stream.read(0x38 + 2 * 0x88)
        if len(header) != 0x148 or header[:8] != b'IWffd100' or struct.unpack_from('<I', header, 8)[0] != 6:
            raise ValueError(f'{path.name} is not a supported Replay patch.')
        previous, target = header[0x38:0xc0], header[0xc0:0x148]
        if previous != current:
            raise ValueError(f'{path.name} does not match the preceding fastfile header. Restore the matching base and patch from the same build.')
        if target[:8] not in (b'IWffa100', b'IWffc100') or struct.unpack_from('<I', target, 8)[0] != 11:
            raise ValueError(f'{path.name} targets a different game exporter.')
        current = target; version = struct.unpack_from('<I', target, 12)[0]
        patches.append(dict(file_identity(path), flag=flag))
    if version not in REPLAY_VERSIONS:
        raise ValueError(f'{source.name} has unsupported XFile version {version:#x}. Keep its matching .fp/.fc patches beside the .ff or install the matching base and patches in the configured game zone folder. This exporter targets the revisions shipped with 1.20 Replay.')
    return {'input': file_identity(source), 'patches': patches}


class ExtractionManager:
    def __init__(self, config):
        self.acts = Path(config['acts']).resolve(strict=True)
        self.game = Path(config['game_exe']).resolve(strict=True)
        self.oodle = Path(config['oodle']).resolve(strict=True) if config.get('oodle') else None
        self.xpak_dir = Path(config['xpak_dir']).resolve(strict=True) if config.get('xpak_dir') else None
        self.cache = Path(config['cache']).resolve()
        self.cache.mkdir(parents=True, exist_ok=True)
        self.output = self.cache / 'output'; self.output.mkdir(exist_ok=True)
        self.jobs_dir = self.cache / 'jobs'; self.jobs_dir.mkdir(exist_ok=True)
        self.uploads_dir = self.cache / 'uploads'; self.uploads_dir.mkdir(exist_ok=True)
        self.timeout = int(config.get('timeout_seconds', 3600))
        self.reserve = int(config.get('reserve_bytes', 1024 ** 3))
        self.max_output = int(config.get('max_output_bytes', 64 * 1024 ** 3))
        if not 10 <= self.timeout <= 21600 or self.reserve < 0 or self.max_output <= 0:
            raise ValueError('Invalid extraction limits.')
        self.lock = threading.RLock()
        self.jobs = {}
        self.processes = {}
        self.uploads = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='acts-extract')
        for path in self.jobs_dir.glob('*/job.json'):
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
                if not re.fullmatch('[a-f0-9]{32}', job['id']) or path.parent.name != job['id']:
                    continue
                if job['status'] in ACTIVE:
                    job.update(status='failed', error='The viewer server restarted during extraction. Select the fastfile again to retry.')
                    write_json(path, job)
                self.jobs[job['id']] = job
            except (OSError, ValueError, KeyError):
                continue

    def packages(self):
        result = []
        for path in sorted(self.xpak_dir.glob('*.xpak')) if self.xpak_dir else []:
            with path.open('rb') as stream:
                header = stream.read(800)
            if len(header) < 800 or struct.unpack_from('<I', header)[0] != 0x4950414b or struct.unpack_from('<H', header, 6)[0] != 13:
                raise ValueError(f'XPak is not Replay version 13: {path.name}')
            # Empty per-zone placeholders are common; include every nonempty
            # native index, independent of the physical archive's byte size.
            if struct.unpack_from('<Q', header, 0x150)[0]:
                result.append(path)
        if len(result) > 64:
            raise ValueError('More than 64 populated XPaks are configured.')
        return result

    def resolve_input(self, source, label=None, upload_hash=None):
        verify_fastfile(source)
        # Sidecars beside a selected host file are authoritative. For device
        # uploads/copies, reuse an installed base only after a full byte hash match.
        if any(source.with_suffix(s).is_file() for s in ('.fp', '.fc')):
            return patch_chain(source)
        zone = self.xpak_dir or self.game.parent / 'zone'
        name = Path((label or source.name).replace('\\', '/')).name
        candidates = [zone / name, *zone.glob(f'*/{name}')] if re.fullmatch(r'[\w .-]+\.ff', name, re.I) else []
        digest = upload_hash
        for candidate in candidates:
            if not candidate.is_file() or candidate.resolve() == source: continue
            if not any(candidate.with_suffix(s).is_file() for s in ('.fp', '.fc')): continue
            if candidate.stat().st_size != source.stat().st_size: continue
            if digest is None:
                with source.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            with candidate.open('rb') as stream: installed_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest == installed_digest: return patch_chain(candidate.resolve())
        return patch_chain(source)

    def fingerprint(self, source, packages, upload_hash=None, plan=None):
        inputs = [self.acts, self.game]
        if self.oodle:
            inputs.append(self.oodle)
        for name in ['acts-common.dll', 'data/mw19/schema.json']:
            path = self.acts.parent / name
            if path.exists():
                inputs.append(path)
        source_key = {'sha256': upload_hash, 'size': source.stat().st_size} if upload_hash else file_identity(source)
        value = {'source': source_key, 'inputs': [file_identity(p) for p in inputs + packages], 'mode': 'mw19replay-all-geometry-v1'}
        if plan and plan['patches']: value['patch_chain'] = plan
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

    def save(self, job):
        write_json(self.jobs_dir / job['id'] / 'job.json', job)

    def start(self, source, label=None, upload_hash=None):
        source = source.resolve(strict=True)
        plan = self.resolve_input(source, label, upload_hash)
        packages = self.packages()
        fingerprint = self.fingerprint(source, packages, upload_hash, plan)
        with self.lock:
            for old in reversed(list(self.jobs.values())):
                if old['fingerprint'] != fingerprint:
                    continue
                if old['status'] in ACTIVE:
                    return self.snapshot(old['id'])
                if old['status'] == 'complete' and self.valid_cached_output(old):
                    dependencies = old.get('material_sources', []) + old.get('image_sources', [])
                    if old.get('material_version') != _materials.VERSION or any(not Path(d['path']).is_file() or file_identity(Path(d['path'])) != d for d in dependencies):
                        old.update(status='queued', material_only=True, message='Adding model textures to the saved extraction')
                        self.save(old); self.executor.submit(self.run, old['id'])
                        return self.snapshot(old['id'])
                    result = self.snapshot(old['id']); result['cached'] = True
                    return result
            if sum(job['status'] in ACTIVE for job in self.jobs.values()) >= 16:
                raise ValueError('The extraction queue is full. Wait for a job to finish.')
            self.cache.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self.cache).free < self.reserve:
                raise ValueError('The extraction cache drive has insufficient free space.')
            identity = uuid.uuid4().hex
            (self.jobs_dir / identity).mkdir(parents=True)
            job = {'id': identity, 'name': label or source.name, 'source': file_identity(source), 'fingerprint': fingerprint,
                   'status': 'queued', 'created': time.time(), 'updated': time.time(), 'files': 0, 'output_bytes': 0,
                   'packages': [str(p) for p in packages], 'input_plan': plan, 'message': 'Waiting for ACTS'}
            self.save(job); self.jobs[identity] = job
            self.executor.submit(self.run, identity)
            return self.snapshot(identity)

    def valid_cached_output(self, job):
        try:
            directory = self.output / job['id']
            entries = json.loads((self.jobs_dir / job['id'] / 'index.json').read_text(encoding='utf-8'))
            for entry in entries:
                path = directory / entry['path']
                stat = path.stat()
                if not path.resolve().is_relative_to(directory) or stat.st_size != entry['size'] or str(stat.st_mtime_ns) != entry['mtime']:
                    return False
            return bool(entries)
        except (OSError, ValueError, KeyError):
            return False

    def command(self, job):
        command = [str(self.acts), '--noUpdater', 'fastfile', '-r', 'mw19replay', '-g', str(self.game), '--geometry']
        if self.oodle:
            command += ['--oodle', str(self.oodle)]
        for package in job['packages']:
            command += ['--xpak', package]
        # There is no --test, type filter or per-pool sample cap here.
        plan = job.get('input_plan', {'input': job['source'], 'patches': []})
        return command + [p['flag'] for p in plan['patches']] + ['-o', str(self.output / job['id']), plan['input']['path']]

    def progress(self, job):
        directory = self.output / job['id']
        primary = job.get('input_plan', {}).get('input', job['source'])
        manifests = [directory / 'mw19replay' / Path(primary['path']).stem / 'manifest.json']
        if not manifests[0].is_file():
            manifests = list(directory.glob('mw19replay/*/manifest.json'))
        if manifests:
            try:
                manifest = json.loads(manifests[0].read_text(encoding='utf-8'))
                job['progress'] = {key: manifest[key] for key in ('complete', 'success', 'loaded_assets', 'tested', 'failed', 'unavailable', 'top_level_index', 'serialized_bytes_read') if key in manifest}
                job['message'] = f"{manifest.get('loaded_assets', 0):,} assets loaded; {manifest.get('tested', 0):,} exported"
                return manifest
            except (OSError, ValueError):
                pass
        return {}

    def run_child(self, job, command, label, primary=False):
        """Run a fixed ACTS command with the same cancellation, lifetime and disk limits."""
        process = None; lifetime = None
        try:
            with (self.jobs_dir / job['id'] / 'acts.log').open('ab') as log:
                log.write(f'\n--- {label} ---\n'.encode()); log.flush()
                process = subprocess.Popen(command, cwd=self.acts.parent, stdout=log, stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                lifetime = ChildLifetime(process)
                with self.lock: self.processes[job['id']] = process
                last_scan = 0
                while process.poll() is None:
                    with self.lock:
                        if job['status'] == 'cancelled':
                            process.terminate(); break
                        if primary: self.progress(job)
                        else: job['message'] = label
                        job['updated'] = time.time(); self.save(job)
                    if time.monotonic() - last_scan > 2:
                        last_scan = time.monotonic()
                        total = sum(p.stat().st_size for p in (self.output / job['id']).rglob('*') if p.is_file())
                        job['output_bytes'] = total
                        if total > self.max_output or shutil.disk_usage(self.cache).free < self.reserve:
                            raise ValueError('Extraction stopped at the configured output or free-space limit. Partial files remain in the cache.')
                    if time.time() - job['started'] > self.timeout:
                        raise ValueError('ACTS exceeded the extraction time limit. Partial files remain in the cache.')
                    time.sleep(.35)
                return process.wait(timeout=10)
        finally:
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=10)
            if lifetime: lifetime.close()
            with self.lock: self.processes.pop(job['id'], None)

    def prepare_materials(self, job):
        output = self.output / job['id']
        catalog = _materials.catalogue(output)
        # Map fastfiles contain model/image data, while their techsets companion
        # owns the named Material records. Never guess texture names from a mesh.
        stem = Path(job['name'].replace('\\', '/')).stem
        source_dir = Path(job['source']['path']).parent
        zone = self.xpak_dir or self.game.parent / 'zone'
        candidates = []
        if not stem.startswith('techsets_'):
            candidates.extend([source_dir / f'techsets_{stem}.ff', zone / f'techsets_{stem}.ff'])
        candidates.extend(zone / f'techsets_{name}.ff' for name in ('common_mp', 'common', 'common_base_mp', 'common_core_mp', 'common_stream_mp', 'global_stream_mp', 'global_mp', 'global', 'common_br_mp'))
        seen = set(); job['material_sources'] = []; job['image_sources'] = []; job['material_warnings'] = []
        for source in candidates:
            if not catalog['missing_materials'] or job['status'] == 'cancelled': break
            if not source.is_file() or source.resolve() in seen: continue
            source = source.resolve(); seen.add(source)
            try: plan = self.resolve_input(source)
            except ValueError as error:
                job['material_warnings'].append(str(error)); continue
            command = [str(self.acts), '--noUpdater', 'fastfile', '-r', 'mw19replay', '-g', str(self.game)]
            if self.oodle: command += ['--oodle', str(self.oodle)]
            command += [p['flag'] for p in plan['patches']]
            names = ','.join(catalog['missing_materials'])
            if len(names) < 24000: command += ['-n', names]
            command += ['-a', 'material', '-o', str(output), plan['input']['path']]
            code = self.run_child(job, command, f'Loading model materials from {source.name}')
            if job['status'] == 'cancelled': return
            if code:
                job.setdefault('material_warnings', []).append(f'ACTS could not load every material from {source.name}; see its report.')
            job['material_sources'].extend({k: p[k] for k in ('path', 'size', 'mtime')} for p in [plan['input'], *plan['patches']])
            catalog = _materials.catalogue(output)
        # Shared character/weapon color images can live in global/common zones.
        # Export only the exact unresolved color-image names, never whole image pools.
        for name in ('global_stream_mp', 'global_mp', 'global', 'common_base_mp', 'common_core_mp', 'common_mp', 'common_br_mp'):
            if not catalog['missing_images'] or job['status'] == 'cancelled': break
            source = zone / f'{name}.ff'
            if name == stem or not source.is_file(): continue
            command = [str(self.acts), '--noUpdater', 'fastfile', '-r', 'mw19replay', '-g', str(self.game)]
            if self.oodle: command += ['--oodle', str(self.oodle)]
            # The native decoder validates the patch chain and final 0xff7 layout.
            try: plan = self.resolve_input(source)
            except ValueError as error:
                job['material_warnings'].append(str(error)); continue
            command += [p['flag'] for p in plan['patches']]
            for package in job['packages']: command += ['--xpak', package]
            names = ','.join(catalog['missing_images'])
            if len(names) > 24000:
                job['material_warnings'].append('Too many unresolved color images for one dependency request.'); break
            command += ['-a', 'image', '-n', names, '-o', str(output), plan['input']['path']]
            code = self.run_child(job, command, f'Loading referenced color textures from {source.name}')
            if job['status'] == 'cancelled': return
            if code: job['material_warnings'].append(f'Some referenced textures could not be loaded from {source.name}; see its report.')
            job['image_sources'].extend({k: p[k] for k in ('path', 'size', 'mtime')} for p in [plan['input'], *plan['patches']])
            catalog = _materials.catalogue(output)
        catalog = _materials.save_catalogue(output)
        job['material_version'] = _materials.VERSION
        job['material_only'] = False
        job['material_summary'] = {'surface_sets': len(catalog['surfaces']), 'materials': len(catalog['materials']), 'missing': len(catalog['missing_materials']), 'missing_images': len(catalog['missing_images'])}

    def run(self, identity):
        job = self.jobs[identity]
        try:
            with self.lock:
                if job['status'] == 'cancelled':
                    return
                job.update(status='running', message='Loading the fastfile with ACTS', started=time.time()); self.save(job)
            if file_identity(Path(job['source']['path'])) != job['source']:
                raise ValueError('The source fastfile changed before extraction started. Select it again.')
            plan = job.get('input_plan')
            if plan:
                for item in [plan['input'], *plan['patches']]:
                    if file_identity(Path(item['path'])) != {k: item[k] for k in ('path', 'size', 'mtime')}:
                        raise ValueError('A fastfile or patch changed before extraction started. Select it again.')
            output = self.output / identity; output.mkdir(parents=True, exist_ok=bool(job.get('material_only')))
            code = 0 if job.get('material_only') else self.run_child(job, self.command(job), 'Extracting fastfile', primary=True)
            # A partial main zone can contain usable models; prepare their
            # material and image dependencies just like a complete extraction.
            if job['status'] != 'cancelled' and (code == 0 or any(output.glob('mw19replay/*/assets/xmodel'))):
                self.prepare_materials(job)
            with self.lock:
                if job['status'] == 'cancelled':
                    return
                manifest = self.progress(job)
                entries = self.index_output(job)
                good = code == 0 and manifest.get('complete') and manifest.get('success')
                job.update(status='complete' if good else 'partial' if entries else 'failed', returncode=code,
                           files=len(entries), output_bytes=sum(e['size'] for e in entries), updated=time.time())
                if good:
                    job['message'] = 'Extraction complete'
                else:
                    job['error'] = manifest.get('error') or f"ACTS returned {code}; {manifest.get('failed', 0)} failed and {manifest.get('unavailable', 0)} unavailable assets."
                    job['message'] = 'Some assets could not be extracted. Available output can still be opened.' if entries else 'Extraction failed'
                if file_identity(Path(job['source']['path'])) != job['source']:
                    job.update(status='partial', error='The source changed during extraction. Select it again for a consistent result.')
                if plan and any(file_identity(Path(i['path'])) != {k: i[k] for k in ('path', 'size', 'mtime')} for i in [plan['input'], *plan['patches']]):
                    job.update(status='partial', error='A fastfile or patch changed during extraction. Select it again for a consistent result.')
                self.save(job)
        except Exception as error:
            with self.lock:
                try:
                    entries = self.index_output(job)
                except Exception as index_error:
                    entries = []
                    error = RuntimeError(f'{error}; output indexing failed: {index_error}')
                job.update(status='cancelled' if job['status'] == 'cancelled' else 'partial' if entries else 'failed',
                           error=str(error), message=str(error), files=len(entries), output_bytes=sum(e['size'] for e in entries), updated=time.time())
                try: self.save(job)
                except OSError: pass  # Keep a visible terminal state even when the cache disk cannot be written.
        finally:
            with self.lock:
                self.processes.pop(identity, None)
                if job['status'] == 'cancelled':
                    try:
                        entries = self.index_output(job)
                        job.update(files=len(entries), output_bytes=sum(e['size'] for e in entries))
                        self.save(job)
                    except OSError as error:
                        job['error'] = f'Extraction cancelled; output indexing failed: {error}'

    def index_output(self, job):
        directory = self.output / job['id']
        entries = []
        for path in directory.rglob('*'):
            if not path.is_file() or path.suffix == '.tmp' or path.is_symlink() or not path.resolve().is_relative_to(directory):
                continue
            stat = path.stat()
            entries.append({'path': path.relative_to(directory).as_posix(), 'name': path.name, 'size': stat.st_size, 'mtime': str(stat.st_mtime_ns), 'directory': False})
        entries.sort(key=lambda row: row['path'])
        write_json(self.jobs_dir / job['id'] / 'index.json', entries)
        return entries

    def snapshot(self, identity):
        with self.lock:
            job = self.jobs[identity]
            result = {key: job[key] for key in ('id', 'name', 'status', 'created', 'updated', 'message', 'progress', 'error', 'files', 'output_bytes', 'returncode', 'material_summary', 'material_warnings') if key in job}
            log = self.jobs_dir / identity / 'acts.log'
            if log.is_file():
                with log.open('rb') as stream:
                    stream.seek(max(0, log.stat().st_size - 12000))
                    result['log'] = stream.read(12000).decode('utf-8', errors='replace')
            return result

    def recent(self):
        with self.lock:
            return [self.snapshot(j['id']) for j in sorted(self.jobs.values(), key=lambda j: j['created'], reverse=True)[:50]]

    def entries(self, identity, offset=0):
        with self.lock:
            job = self.jobs[identity]
            if job['status'] not in TERMINAL:
                raise ValueError('Extraction is still running.')
            path = self.jobs_dir / identity / 'index.json'
            stat = path.stat() if path.exists() else None
            key = (identity, stat.st_mtime_ns, stat.st_size) if stat else (identity, None)
            cached = getattr(self, '_entry_index', None)
            if cached is None or cached[0] != key:
                entries = json.loads(path.read_text(encoding='utf-8')) if stat else []
                self._entry_index = (key, entries)
            else:
                entries = cached[1]
            page = [dict(e, path=f"{identity}/{e['path']}") for e in entries[offset:offset + 2000]]
            return {'entries': page, 'total': len(entries), 'next': offset + len(page) if offset + len(page) < len(entries) else None,
                    'root': {'id': 'extraction_cache', 'label': 'ACTS extraction cache'}}

    def cancel(self, identity):
        with self.lock:
            job = self.jobs[identity]
            if job['status'] in ACTIVE:
                job.update(status='cancelled', message='Extraction cancelled. Partial output remains in the cache.', updated=time.time()); self.save(job)
                process = self.processes.get(identity)
                if process and process.poll() is None:
                    process.terminate()
            return self.snapshot(identity)

    def create_upload(self, name, size):
        if not isinstance(name, str) or not name.lower().endswith('.ff') or not isinstance(size, int) or not 16 <= size <= MAX_UPLOAD:
            raise ValueError('Upload a .ff fastfile between 16 bytes and 4 GB.')
        with self.lock:
            if len(self.uploads) >= 16:
                raise ValueError('Too many pending uploads. Finish or cancel an upload first.')
            self.cache.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self.cache).free < size + self.reserve:
                raise ValueError('Insufficient cache drive space for this upload.')
            identity = uuid.uuid4().hex
            folder = self.uploads_dir / identity; folder.mkdir(parents=True)
            filename = re.sub(r'[^a-zA-Z0-9_.-]', '_', Path(name.replace('\\', '/')).stem)[:96] + '.ff'
            path = folder / ('upload_' + filename)
            path.touch()
            self.uploads[identity] = {'id': identity, 'path': path, 'name': name[:256], 'size': size, 'offset': 0, 'hash': hashlib.sha256()}
            return {'id': identity, 'offset': 0, 'chunk_bytes': CHUNK_BYTES}

    def upload_chunk(self, identity, offset, data):
        with self.lock:
            upload = self.uploads[identity]
            if not data or len(data) > CHUNK_BYTES or offset < 0 or offset + len(data) > upload['size']:
                raise ValueError('Upload chunk offset or size does not match.')
            if offset < upload['offset'] and offset + len(data) <= upload['offset']:
                with upload['path'].open('rb') as stream:
                    stream.seek(offset)
                    if stream.read(len(data)) == data:
                        return {'id': identity, 'offset': upload['offset']}
            if offset != upload['offset']:
                raise ValueError('Upload chunk offset does not match.')
            with upload['path'].open('ab') as stream:
                stream.write(data)
            upload['hash'].update(data); upload['offset'] += len(data)
            return {'id': identity, 'offset': upload['offset']}

    def finish_upload(self, identity):
        with self.lock:
            upload = self.uploads[identity]
            if upload['offset'] != upload['size']:
                raise ValueError('Fastfile upload is incomplete.')
            result = self.start(upload['path'], upload['name'], upload['hash'].hexdigest())
            del self.uploads[identity]
            return result

    def cancel_upload(self, identity):
        with self.lock:
            upload = self.uploads.pop(identity)
            # Only remove the exact temporary file created for this upload.
            if upload['path'].resolve().is_relative_to(self.uploads_dir):
                upload['path'].unlink(missing_ok=True)
            return {'cancelled': True}

    def close(self):
        for identity in list(self.jobs):
            self.cancel(identity)
        self.executor.shutdown(wait=True, cancel_futures=True)
