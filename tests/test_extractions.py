"""Job lifecycle checks use a tiny fake CLI; browser integration uses real ACTS."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('extractions', Path(__file__).resolve().parents[1] / 'scripts/extractions.py')
extractions = importlib.util.module_from_spec(spec); spec.loader.exec_module(extractions)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.source = self.root / 'synthetic.ff'
        self.source.write_bytes(b'IWffc100' + struct.pack('<II', 11, 0xff7) + b'synthetic data')
        self.manager = extractions.ExtractionManager({'acts': sys.executable, 'game_exe': sys.executable, 'cache': str(self.root / 'cache'), 'reserve_bytes': 0})
        self.fake = self.root / 'fake_cli.py'
        self.fake.write_text('''import json,sys,time
from pathlib import Path
out=Path(sys.argv[1])/'mw19replay/synthetic';out.mkdir(parents=True)
time.sleep(float(sys.argv[2]))
(out/'manifest.json').write_text(json.dumps(dict(complete=True,success=True,loaded_assets=1,tested=1,failed=0,unavailable=0)))
(out/'synthetic.txt').write_text('exported payload')
''')
        self.manager.command = lambda job: [sys.executable, str(self.fake), str(self.manager.output / job['id']), '.1']

    def tearDown(self):
        self.manager.close(); self.temp.cleanup()

    def wait(self, identity):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            row = self.manager.snapshot(identity)
            if row['status'] in extractions.TERMINAL and identity not in self.manager.processes:
                return row
            time.sleep(.05)
        self.fail('job did not terminate')

    def test_export_cache_and_changed_source(self):
        job = self.manager.start(self.source)
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        result = self.manager.start(self.source)
        self.assertEqual(result['id'], job['id']); self.assertTrue(result['cached'])
        page = self.manager.entries(job['id'])
        self.assertEqual(len(page['entries']), 2); self.assertIsNone(page['next'])
        self.assertEqual(page['total'], 2)
        index = self.manager.jobs_dir / job['id'] / 'index.json'
        records = json.loads(index.read_text())
        records.append(dict(records[0], path='added.txt'))
        extractions.write_json(index, records)
        updated = self.manager.entries(job['id'], 2)
        self.assertEqual(updated['total'], 3)
        self.assertTrue(updated['entries'][0]['path'].endswith('/added.txt'))
        self.source.write_bytes(self.source.read_bytes() + b'changed')
        self.assertNotEqual(self.manager.start(self.source)['id'], job['id'])

    def test_invalid_fastfile_never_starts_a_process(self):
        self.source.write_bytes(b'not a fastfile')
        with self.assertRaisesRegex(ValueError, 'not an IW8'): self.manager.start(self.source)
        self.assertEqual(self.manager.jobs, {})

    def remove_empty_cache(self):
        # Remove only empty directories belonging to this test's temp root.
        for path in (self.manager.jobs_dir, self.manager.output, self.manager.uploads_dir, self.manager.cache):
            self.assertTrue(path.resolve().is_relative_to(self.root.resolve()))
            path.rmdir()

    def test_host_extraction_recovers_cache_removed_after_startup(self):
        self.remove_empty_cache()
        result = self.wait(self.manager.start(self.source)['id'])
        self.assertEqual(result['status'], 'complete')
        self.assertGreater(result['files'], 0)

    def test_upload_recovers_cache_removed_after_startup(self):
        self.remove_empty_cache()
        data = self.source.read_bytes()
        upload = self.manager.create_upload('synthetic.ff', len(data))
        self.manager.upload_chunk(upload['id'], 0, data)
        result = self.wait(self.manager.finish_upload(upload['id'])['id'])
        self.assertEqual(result['status'], 'complete')

    def test_worker_save_failure_reaches_terminal_state(self):
        original = self.manager.save
        def save(job):
            if job['status'] == 'running':
                raise OSError('fixture metadata drive unavailable')
            original(job)
        with patch.object(self.manager, 'save', side_effect=save):
            result = self.wait(self.manager.start(self.source)['id'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('fixture metadata drive unavailable', result['error'])

    def test_initial_save_failure_does_not_leave_queued_job(self):
        with patch.object(self.manager, 'save', side_effect=OSError('fixture write denied')):
            with self.assertRaisesRegex(OSError, 'fixture write denied'):
                self.manager.start(self.source)
        self.assertEqual(self.manager.jobs, {})

    def test_stock_authenticated_header_and_wrong_revision(self):
        self.source.write_bytes(b'IWffa100' + struct.pack('<II', 11, 0xff7))
        extractions.verify_fastfile(self.source)
        self.source.write_bytes(b'IWffa100' + struct.pack('<II', 11, 0xff6))
        with self.assertRaisesRegex(ValueError, 'unsupported XFile'): self.manager.start(self.source)

    def patch(self, source, previous, version, suffix='.fp'):
        target = bytearray(previous); struct.pack_into('<I', target, 12, version)
        header = b'IWffd100' + struct.pack('<I', 6) + bytes(0x38 - 12)
        source.with_suffix(suffix).write_bytes(header + previous + target)
        return bytes(target)

    def test_legacy_revision_without_patch(self):
        header = bytearray(0x88); header[:8] = b'IWffa100'; struct.pack_into('<II', header, 8, 11, 0xfcd)
        self.source.write_bytes(header)
        job = self.manager.start(self.source)
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        self.assertEqual(self.manager.jobs[job['id']]['input_plan']['patches'], [])

    def test_patch_chain_flags_and_cache_invalidation(self):
        header = bytearray(0x88); header[:8] = b'IWffa100'; struct.pack_into('<II', header, 8, 11, 0xfcf)
        self.source.write_bytes(header)
        target = self.patch(self.source, header, 0xff5)
        self.patch(self.source, target, 0xff7, '.fc')
        job = self.manager.start(self.source)
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        command = extractions.ExtractionManager.command(self.manager, self.manager.jobs[job['id']])
        self.assertIn('-p', command); self.assertIn('--fc', command)
        self.assertTrue(self.manager.start(self.source)['cached'])
        with self.source.with_suffix('.fc').open('ab') as stream: stream.write(b'changed delta')
        self.assertNotEqual(self.manager.start(self.source)['id'], job['id'])

    def test_mismatched_patch_never_starts(self):
        header = bytearray(0x88); header[:8] = b'IWffa100'; struct.pack_into('<II', header, 8, 11, 0xfcf)
        self.source.write_bytes(header)
        header[24] = 1
        self.patch(self.source, header, 0xff7)
        with self.assertRaisesRegex(ValueError, 'does not match'): self.manager.start(self.source)
        self.assertEqual(self.manager.jobs, {})

    def test_upload_resolves_only_identical_installed_base(self):
        zone = self.root / 'zone'; zone.mkdir(); self.manager.xpak_dir = zone
        base = zone / 'original.ff'
        header = bytearray(0x88); header[:8] = b'IWffa100'; struct.pack_into('<II', header, 8, 11, 0xfcf)
        base.write_bytes(header); self.patch(base, header, 0xff7)
        upload = self.manager.create_upload('original.ff', len(header))
        self.manager.upload_chunk(upload['id'], 0, header)
        job = self.manager.finish_upload(upload['id'])
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        plan = self.manager.jobs[job['id']]['input_plan']
        self.assertEqual(plan['input']['path'], str(base.resolve())); self.assertEqual(len(plan['patches']), 1)
        # A same-name, same-size file with different bytes must use its own input.
        header[24] = 1; self.source.write_bytes(header)
        plan = self.manager.resolve_input(self.source, 'original.ff', hashlib.sha256(header).hexdigest())
        self.assertEqual(plan['input']['path'], str(self.source.resolve())); self.assertEqual(plan['patches'], [])

    def test_upload_chunks_are_bounded_ordered_and_idempotent(self):
        data = self.source.read_bytes()
        upload = self.manager.create_upload('../../synthetic.ff', len(data))
        identity = upload['id']
        with self.assertRaises(ValueError): self.manager.upload_chunk(identity, 5, data[:3])
        self.manager.upload_chunk(identity, 0, data[:8])
        self.assertEqual(self.manager.upload_chunk(identity, 0, data[:8])['offset'], 8)
        with self.assertRaisesRegex(ValueError, 'incomplete'): self.manager.finish_upload(identity)
        self.manager.upload_chunk(identity, 8, data[8:])
        job = self.manager.finish_upload(identity)
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        self.assertTrue(Path(self.manager.jobs[job['id']]['source']['path']).is_relative_to(self.manager.uploads_dir))
        long_upload = self.manager.create_upload('x' * 150 + '.ff', 16)
        self.assertEqual(self.manager.uploads[long_upload['id']]['path'].suffix, '.ff')
        self.manager.cancel_upload(long_upload['id'])

    def test_cancel_stops_the_child_and_is_not_reused(self):
        self.manager.command = lambda job: [sys.executable, str(self.fake), str(self.manager.output / job['id']), '20']
        job = self.manager.start(self.source)
        deadline = time.monotonic() + 5
        while job['id'] not in self.manager.processes and time.monotonic() < deadline: time.sleep(.02)
        self.manager.cancel(job['id'])
        self.assertEqual(self.wait(job['id'])['status'], 'cancelled')
        self.manager.command = lambda job: [sys.executable, str(self.fake), str(self.manager.output / job['id']), '.1']
        self.assertNotEqual(self.manager.start(self.source)['id'], job['id'])

    def test_nonzero_exit_preserves_partial_output_and_log(self):
        with self.fake.open('a') as stream: stream.write("print('fixture error');sys.exit(2)\n")
        result = self.wait(self.manager.start(self.source)['id'])
        self.assertEqual(result['status'], 'partial'); self.assertEqual(result['returncode'], 2)
        self.assertIn('fixture error', result['log']); self.assertGreater(result['files'], 0)

    def test_partial_models_still_prepare_material_dependencies(self):
        with self.fake.open('a') as stream:
            stream.write("(out/'assets/xmodel').mkdir(parents=True);sys.exit(2)\n")
        prepared = []
        self.manager.prepare_materials = lambda job: prepared.append(job['id'])
        result = self.wait(self.manager.start(self.source)['id'])
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(prepared, [result['id']])

    def test_cancellation_after_successful_child_does_not_prepare_materials(self):
        prepared = []
        self.manager.prepare_materials = lambda job: prepared.append(job['id'])
        def completed_child(job, *args, **kwargs):
            self.manager.cancel(job['id'])
            return 0
        self.manager.run_child = completed_child
        result = self.wait(self.manager.start(self.source)['id'])
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(prepared, [])

    def test_index_write_failure_reaches_visible_terminal_state(self):
        def broken_index(job): raise OSError('fixture disk write failure')
        self.manager.index_output = broken_index
        result = self.wait(self.manager.start(self.source)['id'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('output indexing failed', result['error'])

    def test_restarted_manager_retains_complete_jobs(self):
        job = self.manager.start(self.source); self.wait(job['id']); self.manager.close()
        self.manager = extractions.ExtractionManager({'acts': sys.executable, 'game_exe': sys.executable, 'cache': str(self.root / 'cache'), 'reserve_bytes': 0})
        self.assertTrue(self.manager.start(self.source)['cached'])


if __name__ == '__main__': unittest.main()
