// Synthetic native-export shape: two surfaces with a skipped empty surface,
// two material variants, and BC1 red/green color textures.
export function materialFixture(withIndex = false) {
  const files = {},
    encode = (value) =>
      new TextEncoder().encode(
        typeof value === "string" ? value : JSON.stringify(value),
      );
  const positions = new Float32Array([
    -1, 0, 0, 0, 0, 0, -1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1]);
  const bin = new Uint8Array(
    positions.byteLength + normals.byteLength + uvs.byteLength,
  );
  bin.set(new Uint8Array(positions.buffer));
  bin.set(new Uint8Array(normals.buffer), positions.byteLength);
  bin.set(
    new Uint8Array(uvs.buffer),
    positions.byteLength + normals.byteLength,
  );
  const views = [
    { buffer: 0, byteOffset: 0, byteLength: 72 },
    { buffer: 0, byteOffset: 72, byteLength: 72 },
    { buffer: 0, byteOffset: 144, byteLength: 48 },
  ];
  const accessors = [],
    primitives = [];
  for (let i = 0; i < 2; i++) {
    const start = accessors.length;
    accessors.push(
      {
        bufferView: 0,
        byteOffset: i * 36,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [i - 1, 0, 0],
        max: [i, 1, 0],
      },
      {
        bufferView: 1,
        byteOffset: i * 36,
        componentType: 5126,
        count: 3,
        type: "VEC3",
      },
      {
        bufferView: 2,
        byteOffset: i * 24,
        componentType: 5126,
        count: 3,
        type: "VEC2",
      },
    );
    primitives.push({
      attributes: { POSITION: start, NORMAL: start + 1, TEXCOORD_0: start + 2 },
      extras: { sourceSurface: i * 2 },
    });
  }
  const doc = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
    meshes: [{ primitives }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = encode(doc),
    length = (json.length + 3) & ~3,
    glb = new Uint8Array(28 + length + bin.length),
    view = new DataView(glb.buffer);
  [0x46546c67, 2, glb.length, length, 0x4e4f534a].forEach((v, i) =>
    view.setUint32(i * 4, v, true),
  );
  glb.fill(32, 20, 20 + length);
  glb.set(json, 20);
  view.setUint32(20 + length, bin.length, true);
  view.setUint32(24 + length, 0x004e4942, true);
  glb.set(bin, 28 + length);
  files["assets/xmodelsurfs/fixture.glb"] = glb;
  const journal = [
    {
      type: "xmodelsurfs",
      name: "fixture/mesh",
      file: "assets/xmodelsurfs/fixture.glb",
    },
  ];
  for (const [name, color] of [
    ["red", 0xf800],
    ["green", 0x07e0],
  ]) {
    const dds = new Uint8Array(136),
      d = new DataView(dds.buffer);
    for (const [offset, value] of [
      [0, 0x20534444],
      [4, 124],
      [8, 0x81007],
      [12, 4],
      [16, 4],
      [20, 8],
      [28, 1],
      [76, 32],
      [80, 4],
      [84, 0x31545844],
      [108, 0x1000],
    ])
      d.setUint32(offset, value, true);
    d.setUint16(128, color, true);
    d.setUint16(130, color, true);
    files[`assets/image/${name}.dds`] = dds;
    journal.push({
      type: "image",
      name: `fixture/${name}&packed~1`,
      file: `assets/image/${name}.dds`,
    });
    files[`assets/material/${name}.asset.json`] = encode({
      format: "mw19-asset-json",
      pool: "material",
      asset: {
        fields: {
          name: { string: name },
          textureTable: {
            values: [
              { index: 0, image: { name: `,fixture/${name}&packed~1` } },
            ],
          },
        },
      },
    });
  }
  const variants = ["fixture_model", "fixture_alternate"].map((model, i) => ({
    model,
    lod: 1,
    materials: [i ? "green" : "red", "unused", i ? "red" : "green"],
  }));
  variants.forEach((v) => {
    files[`assets/xmodel/${v.model}.asset.json`] = encode({
      format: "mw19-asset-json",
      pool: "xmodel",
      asset: {
        fields: {
          name: { string: v.model },
          numLods: 2,
          materialHandles: {
            values: ["other", ...v.materials].map((name) => ({
              name: "," + name,
            })),
          },
          lodInfo: [
            { modelSurfsStaging: null, numsurfs: 0, surfIndex: 0 },
            {
              modelSurfsStaging: { name: "fixture/mesh" },
              numsurfs: 3,
              surfIndex: 1,
            },
          ],
        },
      },
    });
  });
  files["assets.jsonl"] = encode(
    journal.map((r) => JSON.stringify(r)).join("\n"),
  );
  if (withIndex)
    files["viewer_materials.json"] = encode({
      format: "zone-materials",
      version: 1,
      surfaces: { "fixture/mesh": variants },
      materials: {
        red: { textures: [{ slot: 0, image: "fixture/red&packed~1" }] },
        green: { textures: [{ slot: 0, image: "fixture/green&packed~1" }] },
      },
    });
  return files;
}
