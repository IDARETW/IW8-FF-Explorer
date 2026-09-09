import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scenes', Path(__file__).resolve().parents[1] / 'scripts/scenes.py')
scenes = importlib.util.module_from_spec(spec); spec.loader.exec_module(scenes)


class SceneTests(unittest.TestCase):
    def test_legacy_float_views_recover_signed_fixed_point_words(self):
        words = [-123456, 654321, -4096]
        floats = [struct.unpack('<f', struct.pack('<i', value))[0] for value in words[:2]]
        legacy = {'v': [*floats, {'bits': struct.pack('<i', words[2]).hex(), 'status': 'nonfinite'}]}
        self.assertEqual(scenes._translation(legacy), words)

    def test_packed_orientation_is_normalized(self):
        orientation = scenes.unpack_quaternion({'v': [0x80008000, 0xffff8000]})
        self.assertAlmostEqual(sum(value * value for value in orientation), 1.0)

    def test_unsafe_world_name_is_portable_and_bad_geometry_keeps_scene(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)
            folder = output / 'mw19replay' / 'bad' / 'assets' / 'gfx_map'
            folder.mkdir(parents=True)
            document = {'format': 'mw19-asset-json', 'pool': 'gfx_map', 'asset': {'fields': {
                'name': {'string': 'maps/mp/bad:name.d3dbsp'},
                'surfaces': {'surfaces': [{'transientZone': 0, 'surfDataIndex': 0,
                    'tris': {'vertexCount': 1, 'triCount': 1, 'posOffset': 0, 'baseIndex': 0}}],
                    'surfData': [{'tangentFrameOffset': 0, 'texCoordOffset': 0}]}, 'smodels': {}}}}
            (folder / 'bad.asset.json').write_text(__import__('json').dumps(document), encoding='utf-8')
            zone_folder = output / 'mw19replay' / 'bad' / 'assets' / 'gfx_map_trzone'
            zone_folder.mkdir()
            zone = {'format': 'mw19-asset-json', 'pool': 'gfx_map_trzone', 'asset': {'fields': {
                'name': {'string': 'bad:name'}, 'transientZoneIndex': 0, 'drawVerts': {
                    'posData': {'bytes': '0'}, 'auxData': {'bytes': ''}, 'indices': {'bytes': ''}}}}}
            (zone_folder / 'bad.asset.json').write_text(__import__('json').dumps(zone), encoding='utf-8')
            result = scenes.save_scenes(output)
            self.assertEqual(len(result), 1)
            self.assertIn('worldError', result[0])
            self.assertTrue((output / 'viewer_scenes' / 'bad_name.scene.json').is_file())


if __name__ == '__main__': unittest.main()
