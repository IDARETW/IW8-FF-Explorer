import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/library.js";
import { replayFocusBox, replayPlacementMatrix } from "../src/scene.js";
import * as THREE from "three";

test("scene manifests have their own preview kind", () => {
  assert.equal(classify("viewer_scenes/mp_frontend.scene.json"), "scene");
  assert.equal(classify("assets/xmodel/model.asset.json"), "text");
});

test("Replay fixed-point Z-up placements enter the GLB Y-up meter basis", () => {
  const matrix = replayPlacementMatrix({
    translationFixed: [4096, 8192, 12288],
    rotation: [0, 0, 0, 1],
    scale: 2,
  });
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  assert.ok(position.distanceTo(new THREE.Vector3(.0254, .0762, -.0508)) < 1e-7);
  assert.ok(rotation.angleTo(new THREE.Quaternion()) < 1e-7);
  assert.ok(scale.distanceTo(new THREE.Vector3(2, 2, 2)) < 1e-7);
});

test("Replay playable bounds enter the same Z-up to Y-up basis", () => {
  const box = replayFocusBox({ min: [-100, 200, -10], max: [300, 600, 90] });
  assert.ok(box.min.distanceTo(new THREE.Vector3(-2.54, -0.254, -15.24)) < 1e-7);
  assert.ok(box.max.distanceTo(new THREE.Vector3(7.62, 2.286, -5.08)) < 1e-7);
});
