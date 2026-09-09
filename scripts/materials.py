"""Compact XModel surface and Material image assignments from ACTS structured exports."""
import json
from pathlib import Path

VERSION = 4


def asset_name(value):
    return value.lstrip(',') if isinstance(value, str) else ''


def documents(output, pool):
    for directory in output.glob(f'mw19replay/*/assets/{pool}'):
        for path in directory.rglob('*.asset.json'):
            if path.is_symlink() or not path.resolve().is_relative_to(output) or path.stat().st_size > 32 * 1024 ** 2:
                continue
            document = json.loads(path.read_text(encoding='utf-8'))
            if document.get('format') == 'mw19-asset-json' and document.get('pool') == pool:
                yield document['asset']['fields']


def catalogue(output):
    surfaces, materials = {}, {}
    for fields in documents(output, 'xmodel'):
        model = asset_name((fields.get('name') or {}).get('string'))
        handles = (fields.get('materialHandles') or {}).get('values', [])
        lods = fields.get('lodInfo', [])[:fields.get('numLods', 0)]
        for level, lod in enumerate(lods):
            surfs = asset_name((lod.get('modelSurfsStaging') or {}).get('name'))
            start, count = lod.get('surfIndex', 0), lod.get('numsurfs', 0)
            if not surfs or not count or not 0 <= start <= start + count <= len(handles):
                continue
            surfaces.setdefault(surfs, []).append({'model': model, 'lod': level,
                'materials': [asset_name((item or {}).get('name')) for item in handles[start:start + count]]})
    for fields in documents(output, 'material'):
        name = asset_name((fields.get('name') or {}).get('string'))
        textures = [{'slot': item.get('index'), 'image': asset_name((item.get('image') or {}).get('name'))}
                    for item in (fields.get('textureTable') or {}).get('values', [])]
        if name:
            materials[name] = {'textures': textures, 'technique': asset_name((fields.get('techniqueSet') or {}).get('name'))}
    for path in output.glob('viewer_scenes/*.scene.json'):
        scene = json.loads(path.read_text(encoding='utf-8'))
        world = scene.get('world') or {}
        if world.get('surfaceSet') and world.get('materials'):
            surfaces[world['surfaceSet']] = [{'model': scene.get('name', 'world'), 'lod': 0,
                                               'materials': world['materials']}]
    needed = {name for variants in surfaces.values() for variant in variants for name in variant['materials'] if name}
    colors = {texture['image'] for name in needed if name in materials for texture in materials[name]['textures'] if texture['slot'] in (0, 27) and texture['image']}
    images = set()
    for path in output.glob('mw19replay/*/assets.jsonl'):
        for line in path.read_text(encoding='utf-8').splitlines():
            record = json.loads(line)
            if record.get('type') == 'image' and record.get('status') == 'ok' and record.get('file'):
                image_path = path.parent / record['file']
                if image_path.is_file() and image_path.resolve().is_relative_to(output): images.add(asset_name(record.get('name')))
    return {'format': 'zone-materials', 'version': 1, 'surfaces': surfaces, 'materials': materials,
            'missing_materials': sorted(needed - materials.keys()), 'missing_images': sorted(colors - images)}


def save_catalogue(output):
    result = catalogue(output)
    if result['surfaces']:
        path = output / 'viewer_materials.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, separators=(',', ':')), encoding='utf-8')
        temporary.replace(path)
    return result
