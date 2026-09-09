import test from "node:test";
import assert from "node:assert/strict";
import {
  addStructuredMaterial,
  modelBindings,
  surfaceMaterial,
} from "../src/material-bindings.js";
import { makeAsset, attachMetadata } from "../src/library.js";

test("material assignments use LOD surface offsets and preserve named variants", () => {
  const catalog = {
    surfaces: Object.create(null),
    materials: Object.create(null),
  };
  const fields = {
    name: { string: "model_a" },
    numLods: 2,
    materialHandles: {
      values: ["unused", ",red", ",green"].map((name) => ({ name })),
    },
    lodInfo: [
      { modelSurfsStaging: { name: "other" }, surfIndex: 0, numsurfs: 1 },
      { modelSurfsStaging: { name: "mesh" }, surfIndex: 1, numsurfs: 2 },
    ],
  };
  addStructuredMaterial(catalog, {
    format: "mw19-asset-json",
    pool: "xmodel",
    asset: { fields },
  });
  assert.deepEqual(catalog.surfaces.mesh[0].materials, ["red", "green"]);
  assert.equal(catalog.surfaces.mesh[0].lod, 1);
  fields.name.string = "model_b";
  addStructuredMaterial(catalog, {
    format: "mw19-asset-json",
    pool: "xmodel",
    asset: { fields },
  });
  assert.equal(catalog.surfaces.mesh.length, 2);
  fields.lodInfo[1].surfIndex = -1;
  addStructuredMaterial(catalog, {
    format: "mw19-asset-json",
    pool: "xmodel",
    asset: { fields },
  });
  assert.equal(catalog.surfaces.mesh.length, 2);
});

test("material index resolves exact image names within its extraction and reports missing slots", async () => {
  const index = {
    format: "zone-materials",
    version: 1,
    surfaces: { mesh: [{ model: "model", lod: 0, materials: ["material"] }] },
    materials: {
      material: {
        textures: [
          { slot: 9, image: "normal" },
          { slot: 0, image: "color&packed~123" },
        ],
      },
    },
  };
  const assets = new Map();
  const add = (path, content = "", name) => {
    const value = makeAsset(new File([content], path.split("/").at(-1)), path);
    if (name) value.metadata = { name };
    assets.set(path, value);
    return value;
  };
  add("other/assets/image/color.dds", "", "color&packed~123");
  const color = add("zone/assets/image/color.dds", "", "color&packed~123");
  add("zone/viewer_materials.json", JSON.stringify(index));
  const mesh = add("zone/assets/xmodelsurfs/mesh.glb", "", "mesh");
  assets.revision = 1;
  const binding = await modelBindings(mesh, assets);
  assert.equal(surfaceMaterial(binding, 0, 0).image, color);
  assert.equal(surfaceMaterial(binding, 0, 1).image, undefined);
  assets.delete(color.path);
  assets.revision++;
  assert.equal(
    surfaceMaterial(await modelBindings(mesh, assets), 0, 0).image.path,
    "other/assets/image/color.dds",
  );
});
