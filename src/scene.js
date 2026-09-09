import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { resolveResource } from "./library.js";
import { modelBindings, surfaceMaterial } from "./material-bindings.js";
import { readColorTexture } from "./model-textures.js";
import { mapConcurrent, yieldToUI } from "./scheduling.js";

let sharedRenderer, sharedEnvironment;
const BASIS = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);
const BASIS_INVERSE = BASIS.clone().invert();

export function replayPlacementMatrix(instance) {
  const fixed = instance.translationFixed;
  if (!Array.isArray(fixed) || fixed.length !== 3)
    throw new Error("Scene placement has no Replay fixed-point translation.");
  const position = new THREE.Vector3(
    fixed[0] / 4096,
    fixed[1] / 4096,
    fixed[2] / 4096,
  );
  position.applyQuaternion(BASIS).multiplyScalar(0.0254);
  const source = new THREE.Quaternion(...instance.rotation).normalize();
  const rotation = BASIS.clone().multiply(source).multiply(BASIS_INVERSE);
  const scale = Number(instance.scale);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error("Scene placement has an invalid scale.");
  return new THREE.Matrix4().compose(
    position,
    rotation,
    new THREE.Vector3(scale, scale, scale),
  );
}

export function replayFocusBox(bounds) {
  if (
    !Array.isArray(bounds?.min) ||
    !Array.isArray(bounds?.max) ||
    bounds.min.length !== 3 ||
    bounds.max.length !== 3
  )
    return null;
  const box = new THREE.Box3();
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const point = new THREE.Vector3(Number(x), Number(y), Number(z));
        if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
        box.expandByPoint(point.applyQuaternion(BASIS).multiplyScalar(0.0254));
      }
  return box.isEmpty() ? null : box;
}

function button(toolbar, text, run) {
  const value = document.createElement("button");
  value.className = "button";
  value.textContent = text;
  value.onclick = run;
  toolbar.append(value);
  return value;
}

function checkbox(toolbar, text, checked, run) {
  const label = document.createElement("label"),
    input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.onchange = () => run(input.checked);
  label.append(input, document.createTextNode(text));
  toolbar.append(label);
  return input;
}

export async function showScene(stage, toolbar, asset, assets, onInfo, signal) {
  if (asset.size > 32 * 1024 ** 2)
    throw new Error("Scene manifest exceeds 32 MB.");
  const sceneDoc = JSON.parse(await asset.file.text({ signal }));
  if (sceneDoc.format !== "mw19-replay-scene" || sceneDoc.version !== 1)
    throw new Error("This is not a supported MW2019 Replay scene manifest.");
  if (!Array.isArray(sceneDoc.models) || sceneDoc.models.length > 2048)
    throw new Error("Scene model table is invalid or exceeds 2,048 models.");
  const placements = sceneDoc.models.reduce(
    (n, value) =>
      n + (Array.isArray(value.instances) ? value.instances.length : 0),
    0,
  );
  if (placements > 250000)
    throw new Error("Scene exceeds the 250,000 placement preview limit.");

  let renderer;
  try {
    renderer = sharedRenderer ||= new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
  } catch {
    throw new Error(
      "WebGL 2 is unavailable. Enable hardware acceleration or try another browser.",
    );
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = "model-canvas";
  renderer.domElement.setAttribute(
    "aria-label",
    "Assembled MW2019 scene. Drag to orbit, pinch to zoom, two fingers to pan.",
  );
  stage.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene(),
    root = new THREE.Group(),
    camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100000);
  scene.add(root, new THREE.HemisphereLight(0xe7daff, 0x332c3c, 1.65));
  const sun = new THREE.DirectionalLight(0xffffff, 2.8);
  sun.position.set(3, 7, 4);
  scene.add(sun);
  if (!sharedEnvironment) {
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment();
    sharedEnvironment = pmrem.fromScene(room);
    room.dispose();
    pmrem.dispose();
  }
  scene.environment = sharedEnvironment.texture;
  const grid = new THREE.GridHelper(10, 20, 0x685276, 0x382b43);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.01;
  controls.maxPolarAngle = Math.PI - 0.01;

  let dirty = true,
    disposed = false,
    loadedModels = 0,
    loadedPlacements = 0,
    loadedSurfaces = 0,
    texturedSurfaces = 0,
    missingGeometry = 0,
    skippedPlacements = Number(sceneDoc.counts?.skippedPlacements) || 0,
    worldIssue = sceneDoc.worldError || "",
    modelIssues = [],
    decodedTextureBytes = 0;
  const geometries = new Set(),
    materials = new Set(),
    textures = new Map();
  const status = document.createElement("span");
  status.className = "model-texture-status";
  status.setAttribute("role", "status");
  toolbar.append(status);
  const invalidate = () => {
    dirty = true;
  };
  controls.addEventListener("change", invalidate);

  function report(message) {
    status.textContent = message;
    onInfo({
      Scene: sceneDoc.name,
      Placements: `${loadedPlacements.toLocaleString()} / ${placements.toLocaleString()}`,
      Models: `${loadedModels.toLocaleString()} / ${sceneDoc.models.length.toLocaleString()}`,
      "Mesh surfaces": loadedSurfaces.toLocaleString(),
      Textured: texturedSurfaces.toLocaleString(),
      "World surfaces": Number(
        sceneDoc.counts?.worldSurfaces || 0,
      ).toLocaleString(),
      ...(missingGeometry ? { "Missing geometry": missingGeometry } : {}),
      ...(skippedPlacements
        ? { "Skipped placements": skippedPlacements }
        : {}),
      ...(worldIssue ? { "World unavailable": worldIssue } : {}),
      ...(modelIssues.length
        ? { "Model errors": modelIssues.slice(0, 8).join(", ") }
        : {}),
      ...(sceneDoc.missingModels?.length
        ? { "Unavailable XModels": sceneDoc.missingModels.join(", ") }
        : {}),
      ...(sceneDoc.unsupported?.splinedModels
        ? {
            "Splined placements unavailable":
              sceneDoc.unsupported.splinedModels,
          }
        : {}),
    });
  }

  function frameBox(box) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3()),
      size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(extent) || extent < 1e-7) return;
    const distance =
      (extent * 1.25) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    camera.position
      .copy(center)
      .add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
    camera.near = Math.max(0.01, extent / 100000);
    camera.far = extent * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = extent * 0.002;
    controls.maxDistance = extent * 20;
    grid.position.set(center.x, box.min.y - extent * 0.002, center.z);
    grid.scale.setScalar(Math.max(1, extent / 4));
    controls.update();
    dirty = true;
  }

  const focusBox = replayFocusBox(sceneDoc.focusBounds);
  const frame = () => frameBox(new THREE.Box3().setFromObject(root));
  const frameFocus = () => frameBox(focusBox || new THREE.Box3().setFromObject(root));

  button(toolbar, "Frame all", frame);
  if (focusBox) button(toolbar, "Playable area", frameFocus);
  checkbox(toolbar, "Wireframe", false, (value) => {
    for (const material of materials) {
      material.wireframe = value;
      material.needsUpdate = true;
    }
    dirty = true;
  });
  checkbox(toolbar, "Grid", true, (value) => {
    grid.visible = value;
    dirty = true;
  });
  checkbox(toolbar, "World", true, (value) => {
    root.getObjectByName("__world")?.traverse((node) => {
      node.visible = value;
    });
    dirty = true;
  });

  const textureFor = async (image, opacity) => {
    const key = `${opacity ? "a" : "c"}:${image.path}`;
    if (!textures.has(key)) {
      if (textures.size >= 512) throw new Error("Scene texture limit reached.");
      textures.set(
        key,
        readColorTexture(image, signal, opacity).then((texture) => {
          const bytes = texture.image.width * texture.image.height * 4;
          if (decodedTextureBytes + bytes > 384 * 1024 ** 2) {
            texture.dispose();
            throw new Error("Scene decoded-texture memory limit reached.");
          }
          decodedTextureBytes += bytes;
          return texture;
        }),
      );
    }
    return textures.get(key);
  };

  const loadGltf = async (path) => {
    const source = resolveResource(path, asset.path, assets);
    if (typeof source === "string")
      throw new Error("Scene geometry must be in the imported collection.");
    const gltf = await new GLTFLoader().parseAsync(
      await source.file.arrayBuffer({ signal }),
      "",
    );
    gltf.scene.updateMatrixWorld(true);
    return { source, gltf };
  };

  const materialFor = async (binding, surface, original, variant = 0) => {
    const selected = surfaceMaterial(binding, variant, surface);
    if (!selected.image) return original.clone();
    const [map, alphaMap] = await Promise.all([
      textureFor(selected.image, false),
      selected.opacity ? textureFor(selected.opacity, true) : null,
    ]);
    texturedSurfaces++;
    return new THREE.MeshStandardMaterial({
      name: selected.name,
      map,
      alphaMap,
      alphaTest: alphaMap ? 0.25 : 0,
      roughness: 0.86,
      metalness: 0,
      vertexColors: !!original.vertexColors,
      side: THREE.DoubleSide,
    });
  };

  async function addWorld() {
    if (!sceneDoc.world?.geometry) return;
    const { source, gltf } = await loadGltf(sceneDoc.world.geometry);
    const fake = {
      ...source,
      type: "xmodelsurfs",
      metadata: { name: sceneDoc.world.surfaceSet },
    };
    const binding = await modelBindings(fake, assets);
    const jobs = [];
    gltf.scene.name = "__world";
    gltf.scene.traverse((node) => {
      if (!node.isMesh) return;
      geometries.add(node.geometry);
      loadedSurfaces++;
      const association = gltf.parser.associations.get(node);
      const primitive =
        gltf.parser.json.meshes[association?.meshes]?.primitives[
          association?.primitives
        ];
      jobs.push(
        materialFor(binding, primitive?.extras?.sourceSurface, node.material)
          .then((material) => {
            materials.add(material);
            node.material = material;
          })
          .catch(() => {
            materials.add(node.material);
          }),
      );
    });
    root.add(gltf.scene);
    frame();
    await Promise.all(jobs);
  }

  async function addModel(group) {
    if (signal.aborted || disposed) return;
    try {
      const { source, gltf } = await loadGltf(group.geometry);
      const fake = {
        ...source,
        type: "xmodelsurfs",
        metadata: { name: group.surface },
      };
      const binding = await modelBindings(fake, assets);
      const variant = Math.max(
        0,
        binding.variants.findIndex((value) => value.model === group.name),
      );
      const transforms = [];
      for (const instance of Array.isArray(group.instances)
        ? group.instances
        : []) {
        try {
          transforms.push(replayPlacementMatrix(instance));
        } catch {
          skippedPlacements++;
        }
      }
      if (!transforms.length) return;
      const meshes = [];
      gltf.scene.traverse((node) => {
        if (node.isMesh) meshes.push(node);
      });
      await mapConcurrent(meshes, 3, async (node) => {
        if (signal.aborted || disposed) return;
        const association = gltf.parser.associations.get(node);
        const primitive =
          gltf.parser.json.meshes[association?.meshes]?.primitives[
            association?.primitives
          ];
        let material;
        try {
          material = await materialFor(
            binding,
            primitive?.extras?.sourceSurface,
            node.material,
            variant,
          );
        } catch {
          material = node.material.clone();
        }
        const instances = new THREE.InstancedMesh(
          node.geometry,
          material,
          transforms.length,
        );
        const matrix = new THREE.Matrix4();
        transforms.forEach((placement, index) =>
          instances.setMatrixAt(
            index,
            matrix.multiplyMatrices(placement, node.matrixWorld),
          ),
        );
        instances.instanceMatrix.needsUpdate = true;
        instances.frustumCulled = true;
        instances.computeBoundingSphere();
        geometries.add(node.geometry);
        materials.add(material);
        root.add(instances);
        loadedSurfaces++;
      });
      loadedModels++;
      loadedPlacements += transforms.length;
      report(
        `Assembling scene · ${loadedModels} / ${sceneDoc.models.length} models`,
      );
      await yieldToUI();
    } catch (error) {
      missingGeometry++;
      modelIssues.push(`${group.name || "unnamed"}: ${error.message}`);
    }
  }

  function resize() {
    const { width, height } = stage.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  let active = true;
  const visible = new IntersectionObserver((entries) => {
    active = entries[0].isIntersecting;
    dirty = true;
  });
  visible.observe(stage);
  renderer.setAnimationLoop(() => {
    if (active && !window.document.hidden) {
      const moved = controls.update();
      if (dirty || moved) {
        renderer.render(scene, camera);
        dirty = false;
      }
    }
  });
  report("Loading world geometry…");
  void (async () => {
    try {
      await addWorld();
    } catch (error) {
      worldIssue = error.message;
      report("World unavailable; loading placed models…");
    }
    try {
      await mapConcurrent(sceneDoc.models, 3, addModel);
      if (!signal.aborted && !disposed) {
        frameFocus();
        report(`Scene ready · ${loadedPlacements.toLocaleString()} placements`);
      }
    } catch (error) {
      if (!signal.aborted && !disposed)
        report(`Scene partially loaded · ${error.message}`);
    }
  })();

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    observer.disconnect();
    visible.disconnect();
    controls.dispose();
    for (const task of textures.values())
      task.then((value) => value.dispose()).catch(() => {});
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  return cleanup;
}
