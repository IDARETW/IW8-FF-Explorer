import test from "node:test";
import assert from "node:assert/strict";
import {
  safePath,
  makeAsset,
  resolveResource,
  attachMetadata,
} from "../src/library.js";
import { parseDDS, decodePixels } from "../src/dds.js";
import { zipDirectory, crcUpdate } from "../src/zip.js";
import { zipSync, strToU8 } from "fflate";

test("file paths reject escaping and preserve nested extraction names", () => {
  assert.equal(
    safePath("zone\\assets/image/test.dds"),
    "zone/assets/image/test.dds",
  );
  for (const path of [
    "../secret",
    "/secret",
    "E:/secret",
    "a/../../secret",
    "a\0b",
  ])
    assert.throws(() => safePath(path));
  const asset = makeAsset(
    new File(["x"], "test.geometry.glb"),
    "zone/assets/xmodelsurfs/test.geometry.glb",
  );
  assert.equal(asset.kind, "model");
  assert.equal(asset.type, "xmodelsurfs");
});

test("model resources resolve by full relative path and never fetch remote files", () => {
  const asset = {},
    assets = new Map([["zone/textures/a.png", asset]]);
  assert.equal(
    resolveResource("../textures/a.png", "zone/models/a.gltf", assets),
    asset,
  );
  for (const uri of [
    "https://example.com/a",
    "//example.com/a",
    "../../private",
    "/private",
    "%2e%2e/%2e%2e/private",
  ])
    assert.throws(() => resolveResource(uri, "zone/a.gltf", assets));
  assert.throws(
    () => resolveResource("missing.bin", "zone/a.gltf", assets),
    /Missing model resource/,
  );
});

test("ACTS journal metadata attaches to GLB sidecars and conventional assets", async () => {
  const rows = [
    {
      name: "native_name",
      type: "xmodelsurfs",
      geometry_file: "assets/xmodelsurfs/m.glb",
      file: "assets/xmodelsurfs/m.shared.bin",
    },
  ];
  const files = [
    ["z/assets.jsonl", JSON.stringify(rows[0])],
    ["z/assets/xmodelsurfs/m.glb", ""],
    ["z/assets/xmodelsurfs/m.shared.bin", ""],
  ];
  const assets = new Map(
    files.map(([path, content]) => [
      path,
      makeAsset(new File([content], path.split("/").at(-1)), path),
    ]),
  );
  assert.deepEqual((await attachMetadata(assets)).warnings, []);
  assert.equal(
    assets.get("z/assets/xmodelsurfs/m.glb").displayName,
    "native_name",
  );
});

function dds(format = 28, bytes = 16) {
  const b = new ArrayBuffer(148 + bytes),
    d = new DataView(b);
  for (const [offset, value] of Object.entries({
    0: 0x20534444,
    4: 124,
    12: 2,
    16: 2,
    28: 1,
    76: 32,
    84: 0x30315844,
    128: format,
    132: 3,
    140: 1,
  }))
    d.setUint32(Number(offset), value, true);
  return b;
}

test("DDS bounds and subresources reject truncated or excessive data", () => {
  assert.equal(parseDDS(dds()).format, "RGBA8");
  assert.throws(() => parseDDS(dds(28, 15)), /truncated/);
  assert.throws(() => parseDDS(dds(), { face: 1 }), /subresource/);
  assert.throws(() => parseDDS(dds(999)), /no visual decoder/);
});

test("DDS mip chains select the correct byte range", () => {
  const b = dds(28, 20),
    d = new DataView(b);
  d.setUint32(28, 2, true);
  const info = parseDDS(b, { mip: 1 });
  assert.equal(info.width, 1);
  assert.equal(info.offset, 164);
  assert.equal(info.length, 4);
  assert.deepEqual(parseDDS(b.slice(0,148), {mip:1}, b.byteLength), info);
  assert.throws(() => parseDDS(b.slice(0,148), {mip:1}, b.byteLength-1), /truncated/);
  assert.throws(() => parseDDS(b.slice(0,148), {}, Infinity), /truncated/);
});

test("RGBA, BGRA and scalar pixels preserve channel meaning", () => {
  assert.deepEqual(
    [
      ...decodePixels(new Uint8Array([1, 2, 3, 4]), {
        width: 1,
        height: 1,
        stride: 4,
        decoder: "bgra",
      }),
    ],
    [3, 2, 1, 4],
  );
  assert.deepEqual(
    [
      ...decodePixels(new Uint8Array([128]), {
        width: 1,
        height: 1,
        stride: 1,
        decoder: "r8",
      }),
    ],
    [128, 128, 128, 255],
  );
});

test("ZIP directory rejects truncation and verifies the standard CRC32 vector", () => {
  const zip = zipSync({ "zone/test.txt": strToU8("123456789") });
  const directory = zipDirectory(
    zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
  );
  assert.equal(directory.get("zone/test.txt").crc, 0xcbf43926);
  assert.equal(
    (crcUpdate(0xffffffff, strToU8("123456789")) ^ 0xffffffff) >>> 0,
    0xcbf43926,
  );
  assert.throws(
    () =>
      zipDirectory(
        zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength - 1),
      ),
    /incomplete/,
  );
});
