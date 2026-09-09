import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('materials', Path(__file__).resolve().parents[1] / 'scripts/materials.py')
materials = importlib.util.module_from_spec(spec); spec.loader.exec_module(materials)


class MaterialTests(unittest.TestCase):
    def test_exact_surface_offsets_and_unresolved_color_references(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); zone = root / 'mw19replay/synthetic'
            def write(pool, fields):
                directory = zone / 'assets' / pool; directory.mkdir(parents=True, exist_ok=True)
                (directory / 'fixture.asset.json').write_text(json.dumps({'format': 'mw19-asset-json', 'pool': pool, 'asset': {'fields': fields}}))
            write('xmodel', {'name': {'string': 'fixture'}, 'numLods': 1, 'materialHandles': {'values': [{'name': 'unused'}, {'name': ',paint'}, {'name': ',missing'}]},
                'lodInfo': [{'modelSurfsStaging': {'name': 'mesh'}, 'surfIndex': 1, 'numsurfs': 2}]})
            write('material', {'name': {'string': 'paint'}, 'textureTable': {'values': [{'index': 0, 'image': {'name': ',color'}}, {'index': 9, 'image': {'name': ',normal'}}]}})
            result = materials.save_catalogue(root)
            self.assertEqual(result['surfaces']['mesh'][0]['materials'], ['paint', 'missing'])
            self.assertEqual(result['missing_materials'], ['missing'])
            self.assertEqual(result['missing_images'], ['color'])
            image = zone / 'assets/image/color.dds'; image.parent.mkdir(); image.write_bytes(b'synthetic')
            (zone / 'assets.jsonl').write_text(json.dumps({'type': 'image', 'status': 'ok', 'name': 'color', 'file': 'assets/image/color.dds'}))
            self.assertEqual(materials.catalogue(root)['missing_images'], [])
            write('material', {'name': {'string': 'paint'}, 'textureTable': {'values': [{'index': 0, 'image': {'name': ',color'}}, {'index': 27, 'image': {'name': ',cutout'}}, {'index': 9, 'image': {'name': ',normal'}}]}})
            self.assertEqual(materials.catalogue(root)['missing_images'], ['cutout'])


if __name__ == '__main__': unittest.main()
