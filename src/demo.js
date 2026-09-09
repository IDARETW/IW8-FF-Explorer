import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { zipSync } from "fflate";

export async function demoFiles() {
  const scene = new THREE.Scene(),
    group = new THREE.Group();
  scene.add(group);
  const box = (size, position, color, metalness = 0.2) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.48 }),
    );
    mesh.position.set(...position);
    group.add(mesh);
  };
  box([2.3, 1.3, 1.55], [0, 0.8, 0], 0x8c76aa);
  box([2.38, 0.15, 1.63], [0, 1.49, 0], 0x322b3e);
  box([2.4, 0.16, 1.65], [0, 0.13, 0], 0x322b3e);
  for (const x of [-0.87, 0.87]) {
    box([0.15, 1.43, 1.7], [x, 0.83, 0], 0x303844, 0.65);
    box([0.24, 0.3, 0.12], [x, 1.22, 0.85], 0xc8bb93, 0.7);
  }
  box([0.64, 0.25, 0.08], [0, 0.78, 0.8], 0xb7a4d1);
  box([0.35, 0.09, 0.1], [0, 0.78, 0.85], 0x292632);
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  scene.traverse((node) => {
    node.geometry?.dispose();
    node.material?.dispose();
  });
  // A tiny DX10 RGBA texture with a mip chain exercises the real DDS path.
  const width = 64,
    height = 64,
    mipCount = 4;
  let bytes = 148;
  for (let i = 0; i < mipCount; i++) bytes += (width >> i) * (height >> i) * 4;
  const dds = new ArrayBuffer(bytes),
    view = new DataView(dds);
  const header = {
    0: 0x20534444,
    4: 124,
    8: 0x2100f,
    12: height,
    16: width,
    20: width * 4,
    28: mipCount,
    76: 32,
    80: 4,
    84: 0x30315844,
    108: 0x401008,
    128: 28,
    132: 3,
    140: 1,
  };
  for (const [offset, value] of Object.entries(header))
    view.setUint32(Number(offset), value, true);
  const pixels = new Uint8Array(dds);
  let offset = 148;
  for (let mip = 0; mip < mipCount; mip++) {
    const w = width >> mip,
      h = height >> mip;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const grid = (Math.floor((x * 8) / w) + Math.floor((y * 8) / h)) % 2;
        pixels.set(grid ? [179, 148, 224, 255] : [69, 52, 93, 255], offset);
        offset += 4;
      }
  }
  const manifest = {
    handler: "mw19replay",
    fastfile: "demo_collection",
    complete: true,
    success: true,
    loaded_assets: 4,
    note: "Synthetic viewer fixtures. No game assets.",
  };
  const journal = [
    {
      type: "xmodelsurfs",
      name: "zone_demo_case",
      status: "ok",
      geometry_file: "assets/xmodelsurfs/demo_case.geometry.glb",
      geometry_scope: "Synthetic base surface geometry",
      geometry_triangles: 156,
    },
    {
      type: "image",
      name: "zone_demo_checker",
      status: "ok",
      file: "assets/image/demo_checker.dds",
      format: "DDS DX10",
    },
  ]
    .map((v) => JSON.stringify(v))
    .join("\n");
  const entries = [
    ["assets/xmodelsurfs/demo_case.geometry.glb", glb],
    ["assets/image/demo_checker.dds", dds],
    [
      "assets/material/demo_material.asset.json",
      JSON.stringify(
        {
          format: "mw19-asset-json-v1",
          type: "material",
          name: "demo_case_finish",
          values: {
            baseColor: [0.55, 0.46, 0.67],
            roughness: 0.48,
            metalness: 0.2,
          },
          note: "Synthetic example for the viewer.",
        },
        null,
        2,
      ),
    ],
    [
      "assets/rawfile/demo_readme.txt",
      "ZONE / Demo collection\n\nThis collection was created for the web viewer.\nIt contains no extracted game assets.\n\nSelect the model and drag to rotate.\nSelect the DDS texture to explore its mip levels.\n",
    ],
    ["manifest.json", JSON.stringify(manifest, null, 2)],
    ["assets.jsonl", journal],
  ];
  return entries.map(([path, data]) => ({
    path: `demo_collection/${path}`,
    file: new File([data], path.split("/").at(-1)),
  }));
}

export async function demoZip(files) {
  const entries = Object.fromEntries(
    await Promise.all(
      files.map(async (a) => [
        a.path,
        new Uint8Array(await a.file.arrayBuffer()),
      ]),
    ),
  );
  return new Blob([zipSync(entries)], { type: "application/zip" });
}
