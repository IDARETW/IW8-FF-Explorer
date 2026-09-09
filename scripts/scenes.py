"""Build portable browser scenes from MW2019 Replay world exports."""
import json
import math
import re
import struct
from pathlib import Path

FORMAT = 'mw19-replay-scene'
VERSION = 1
MAX_WORLD_BUFFER_BYTES = 512 * 1024 ** 2
MAX_WORLD_SURFACES = 100_000


def _name(value):
    if isinstance(value, dict): return _name(value.get('string') or value.get('name'))
    return value.lstrip(',') if isinstance(value, str) else ''


def _docs(output, pool):
    for directory in output.glob(f'mw19replay/*/assets/{pool}'):
        for path in directory.rglob('*.asset.json'):
            if path.is_symlink() or not path.resolve().is_relative_to(output) or path.stat().st_size > 32 * 1024 ** 2:
                continue
            try:
                document = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            if document.get('format') == 'mw19-asset-json' and document.get('pool') == pool:
                yield path, document['asset']['fields']


def _values(value):
    if isinstance(value, list): return value
    if isinstance(value, dict):
        if isinstance(value.get('values'), list): return value['values']
        if isinstance(value.get('v'), list): return value['v']
        if isinstance(value.get('__s1'), dict): return list(value['__s1'].values())
    return []


def _geometry_files(output):
    result = {}
    for journal in output.glob('mw19replay/*/assets.jsonl'):
        try: lines = journal.read_text(encoding='utf-8').splitlines()
        except (OSError, UnicodeError): continue
        for line in lines:
            if not line.strip(): continue
            try: record = json.loads(line)
            except json.JSONDecodeError: continue
            if record.get('type') != 'xmodelsurfs' or not record.get('geometry_file'): continue
            path = (journal.parent / record['geometry_file']).resolve()
            if path.is_file() and path.is_relative_to(output):
                result[_name(record.get('name'))] = path.relative_to(output).as_posix()
    return result


def _models(output, geometry):
    result = {}
    for _, fields in _docs(output, 'xmodel'):
        model = _name((fields.get('name') or {}).get('string'))
        for lod, record in enumerate(fields.get('lodInfo', [])[:fields.get('numLods', 0)]):
            surface = _name((record.get('modelSurfsStaging') or {}).get('name'))
            if surface in geometry:
                result[model] = {'surface': surface, 'geometry': geometry[surface], 'lod': lod}
                break
    return result


def _translation(value):
    values = _values(value)
    if len(values) != 3: raise ValueError('invalid translation')
    converted = []
    for item in values:
        if isinstance(item, int): converted.append(item)
        elif isinstance(item, float): converted.append(struct.unpack('<i', struct.pack('<f', item))[0])
        elif isinstance(item, dict) and isinstance(item.get('bits'), str) and len(item['bits']) == 8:
            converted.append(struct.unpack('<i', bytes.fromhex(item['bits']))[0])
        else: raise ValueError('translation component is unavailable')
    values = converted
    if not all(isinstance(v, int) and -(1 << 31) <= v < (1 << 31) for v in values):
        raise ValueError('translation is not Replay fixed-point data')
    return values


def unpack_quaternion(words):
    values = _values(words)
    if len(values) != 2: raise ValueError('invalid packed orientation')
    a, b = (int(v) & 0xffffffff for v in values)
    q = [((v / 65535.0) * 2.0) - 1.0 for v in (a & 0xffff, a >> 16, b & 0xffff, b >> 16)]
    length = math.sqrt(sum(v*v for v in q))
    if not math.isfinite(length) or length < .5: raise ValueError('invalid packed orientation')
    return [v / length for v in q]


def _normal(packed):
    stored = [(packed & 1023) * .001382418 - .70710677,
              ((packed >> 10) & 1023) * .001382418 - .70710677,
              ((packed >> 20) & 511) * .0027675412 - .70710677]
    total = sum(v*v for v in stored)
    if total > 1.0001: return (0., 0., 1.)
    q, at, omitted = [], 0, packed >> 30
    for i in range(4):
        if i == omitted: q.append(math.sqrt(max(0., 1. - total)))
        else: q.append(stored[at]); at += 1
    x, y, z, w = q
    n = [2*(y*w+x*z), 2*(y*z-x*w), 1-2*(x*x+y*y)]
    length = math.sqrt(sum(v*v for v in n))
    return tuple(v/length for v in n) if length > .5 else (0., 0., 1.)


def _world_glb(world, zones):
    surfaces = _values((world.get('surfaces') or {}).get('surfaces'))
    surf_data = _values((world.get('surfaces') or {}).get('surfData'))
    if len(surfaces) > MAX_WORLD_SURFACES:
        raise ValueError(f'world exceeds the {MAX_WORLD_SURFACES:,}-surface preview limit')
    data, views, accessors, primitives, materials = bytearray(), [], [], [], []
    buffers, decoded_bytes = {}, 0

    def zone_buffers(index, zone):
        nonlocal decoded_bytes
        if index in buffers: return buffers[index]
        verts = zone.get('drawVerts') or {}
        values = []
        for name in ('posData', 'auxData', 'indices'):
            encoded = (verts.get(name) or {}).get('bytes', '')
            if not isinstance(encoded, str) or len(encoded) & 1:
                raise ValueError(f'transient zone {index} has invalid {name}')
            decoded_bytes += len(encoded) // 2
            if decoded_bytes > MAX_WORLD_BUFFER_BYTES:
                raise ValueError('world geometry exceeds the 512 MiB preview buffer limit')
            try: values.append(bytes.fromhex(encoded))
            except ValueError as error: raise ValueError(f'transient zone {index} has invalid {name}') from error
        buffers[index] = tuple(values)
        return buffers[index]

    def append(payload, target):
        while len(data) & 3: data.append(0)
        offset = len(data); data.extend(payload)
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(payload), 'target': target})
        return len(views)-1
    def accessor(payload, component, count, kind, target, low=None, high=None):
        record = {'bufferView': append(payload, target), 'componentType': component, 'count': count, 'type': kind}
        if low is not None: record.update(min=low, max=high)
        accessors.append(record); return len(accessors)-1
    needed_zones = set()
    for surface in surfaces:
        try: zone_index = int(surface.get('transientZone', 0))
        except (AttributeError, TypeError, ValueError): continue
        if zone_index in zones: needed_zones.add(zone_index)
    for zone_index in needed_zones:
        zone_buffers(zone_index, zones[zone_index])
    for source_index, surface in enumerate(surfaces):
        try:
            tris = surface.get('tris') or {}; count = int(tris.get('vertexCount', 0)); triangles = int(tris.get('triCount', 0))
            zone_index = int(surface.get('transientZone', 0)); zone = zones.get(zone_index)
            if not zone or count <= 0 or triangles <= 0: continue
            pos, aux, indices = zone_buffers(zone_index, zone)
            record = surf_data[int(surface.get('surfDataIndex', source_index))]
            po, no, uo, io = int(tris['posOffset']), int(record['tangentFrameOffset']), int(record['texCoordOffset']), int(tris['baseIndex'])*2
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if po+count*12 > len(pos) or no+count*4 > len(aux) or uo+count*8 > len(aux) or io+triangles*6 > len(indices): continue
        positions = pos[po:po+count*12]; unpacked = struct.unpack('<'+'f'*count*3, positions)
        if not all(math.isfinite(v) for v in unpacked): continue
        index_data = indices[io:io+triangles*6]
        if any(v >= count for v in struct.unpack('<'+'H'*triangles*3, index_data)): continue
        low = [min(unpacked[a::3]) for a in range(3)]; high = [max(unpacked[a::3]) for a in range(3)]
        normals = b''.join(struct.pack('<3f', *_normal(struct.unpack_from('<I', aux, no+i*4)[0])) for i in range(count))
        primitives.append({'attributes': {
            'POSITION': accessor(positions, 5126, count, 'VEC3', 34962, low, high),
            'NORMAL': accessor(normals, 5126, count, 'VEC3', 34962),
            'TEXCOORD_0': accessor(aux[uo:uo+count*8], 5126, count, 'VEC2', 34962)},
            'indices': accessor(index_data, 5123, triangles*3, 'SCALAR', 34963), 'mode': 4,
            'extras': {'sourceSurface': len(primitives)}})
        materials.append(_name((surface.get('material') or {}).get('name')))
    if not primitives: return None, []
    document = {'asset': {'version': '2.0', 'generator': 'MW2019 Replay scene exporter'}, 'scene': 0,
        'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'rotation': [-.7071067811865476,0,0,.7071067811865476], 'scale': [.0254]*3}],
        'meshes': [{'primitives': primitives}], 'bufferViews': views, 'accessors': accessors,
        'buffers': [{'byteLength': len(data)}], 'extras': {'scope': 'Replay GfxWorld BSP surfaces'}}
    encoded = json.dumps(document, separators=(',', ':')).encode(); encoded += b' '*(-len(encoded)&3)
    data.extend(b'\0'*(-len(data)&3))
    glb = struct.pack('<III', 0x46546c67, 2, 28+len(encoded)+len(data))
    glb += struct.pack('<II', len(encoded), 0x4e4f534a)+encoded+struct.pack('<II', len(data), 0x004e4942)+data
    return glb, materials


def save_scenes(output):
    output = Path(output).resolve(); geometry = _geometry_files(output); models = _models(output, geometry)
    zones = {}
    for _, fields in _docs(output, 'gfx_map_trzone'):
        zones.setdefault(_name(fields.get('name')), {})[int(fields.get('transientZoneIndex', 0))] = fields
    results, directory = [], output/'viewer_scenes'; directory.mkdir(exist_ok=True)
    for _, world in _docs(output, 'gfx_map'):
        world_name = _name(world.get('name')) or _name(world.get('baseName'))
        raw_key = Path(world_name).stem.replace('.d3dbsp','') or 'world'
        key = re.sub(r'[^A-Za-z0-9_.-]', '_', raw_key)[:128] or 'world'
        static = world.get('smodels') or {}; refs = _values(static.get('models')); collections = _values(static.get('collections')); instances = _values(static.get('smodelInstanceData'))
        grouped, missing, skipped = {}, set(), 0
        for collection in collections:
            model_index = int(collection.get('smodelIndex', -1)); ref = refs[model_index] if 0 <= model_index < len(refs) else {}
            model_name = _name((ref.get('model') or {}).get('name')); model = models.get(model_name)
            if not model: missing.add(model_name or f'model-index-{model_index}'); continue
            group = grouped.setdefault(model_name, {**model, 'name': model_name, 'instances': []})
            first, count = int(collection.get('firstInstance', -1)), int(collection.get('instanceCount', 0))
            for index in range(first, first+count):
                try:
                    value = instances[index]; scale = float(value.get('scale', 1))
                    if not math.isfinite(scale) or scale <= 0: raise ValueError('invalid scale')
                    group['instances'].append({'translationFixed': _translation(value.get('translation')),
                                               'rotation': unpack_quaternion(value.get('orientation')), 'scale': scale})
                except (IndexError, TypeError, ValueError): skipped += 1
        zone_set = zones.get(Path(world_name).stem.replace('.d3dbsp',''), {}) or zones.get(_name(world.get('baseName')), {})
        world_error = None
        try: glb, world_materials = _world_glb(world, zone_set)
        except (KeyError, TypeError, ValueError, struct.error) as error:
            glb, world_materials, world_error = None, [], str(error)
        world_record = None
        if glb:
            glb_path = directory/f'{key}.world.glb'; glb_path.write_bytes(glb)
            world_record = {'geometry': glb_path.name, 'surfaceSet': f'viewer/world/{key}', 'materials': world_materials}
        scene_models = []
        for group in grouped.values():
            scene_models.append({**group, 'geometry': '../' + group['geometry']})
        scene = {'format': FORMAT, 'version': VERSION, 'name': world_name, 'coordinateSystem': 'iw8-z-up-inches',
                 'world': world_record, 'models': scene_models,
                 'counts': {'placements': sum(len(v['instances']) for v in grouped.values()), 'models': len(grouped),
                            'worldSurfaces': len(world_materials), 'missingModels': len(missing), 'skippedPlacements': skipped},
                 'missingModels': sorted(missing),
                 **({'worldError': world_error} if world_error else {}),
                 'unsupported': {'splinedModels': int(static.get('splinedModelInstanceCount', 0)),
                                 'clutterCollections': int(static.get('clutterCollectionCount', 0))}}
        path = directory/f'{key}.scene.json'; temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(scene, separators=(',', ':')), encoding='utf-8'); temporary.replace(path)
        results.append(scene)
    return results
