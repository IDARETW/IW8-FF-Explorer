import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { resolveResource } from "./library.js";
import { applyModelTextures } from "./model-textures.js";

let sharedRenderer, sharedEnvironment;

export async function showModel(stage, toolbar, asset, assets, onInfo, signal) {
  if (asset.size > 128 * 1024 * 1024)
    throw new Error("Model exceeds the 128 MB preview limit.");
  const urls = new Set();
  const loads = [],
    resourceErrors = [];
  const managerFor = (path) => {
    const manager = new THREE.LoadingManager();
    let busy = false,
      done;
    manager.onStart = () => {
      busy = true;
    };
    manager.onLoad = () => {
      busy = false;
      done?.();
    };
    manager.onError = () =>
      resourceErrors.push(
        "A model texture or buffer could not be decoded. Check that all dependencies are imported.",
      );
    loads.push(() =>
      busy
        ? new Promise((resolve) => {
            done = resolve;
          })
        : Promise.resolve(),
    );
    manager.setURLModifier((url) => {
      if (url.startsWith("blob:")) return url; // GLTFLoader creates these for embedded images.
      const resource = resolveResource(url, path, assets);
      if (typeof resource === "string") return resource;
      if (resource.file.url) return resource.file.url;
      const blob = URL.createObjectURL(resource.file);
      urls.add(blob);
      return blob;
    });
    return manager;
  };
  let object,
    gltf,
    animations = [];
  try {
    if (asset.ext === "obj") {
      const text = await asset.file.text({ signal });
      const loader = new OBJLoader(managerFor(asset.path));
      const material = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
      if (material) {
        const source = resolveResource(material, asset.path, assets);
        if (typeof source === "string")
          throw new Error("OBJ material must be an imported file.");
        const materials = new MTLLoader(managerFor(source.path)).parse(
          await source.file.text(),
          "",
        );
        materials.preload();
        loader.setMaterials(materials);
      }
      object = loader.parse(text);
      await Promise.all(loads.map((wait) => wait()));
      if (resourceErrors.length) throw new Error(resourceErrors[0]);
    } else {
      const loader = new GLTFLoader(managerFor(asset.path));
      const data =
        asset.ext === "gltf"
          ? await asset.file.text({ signal })
          : await asset.file.arrayBuffer({ signal });
      gltf = await loader.parseAsync(data, "");
      object = gltf.scene;
      animations = gltf.animations;
    }
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }
  const disposeObject = () =>
    object?.traverse((node) => {
      node.geometry?.dispose();
      for (const material of [node.material].flat().filter(Boolean)) {
        for (const value of Object.values(material))
          if (value?.isTexture) {
            value.image?.close?.();
            value.dispose();
          }
        material.dispose();
      }
    });
  if (signal.aborted) {
    disposeObject();
    return () => {};
  }
  let modelTextures = { details: {}, cleanup() {} };
  let renderer;
  try {
    renderer = sharedRenderer ||= new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
  } catch {
    modelTextures.cleanup();
    disposeObject();
    throw new Error(
      "WebGL 2 is unavailable. Enable hardware acceleration or try another browser.",
    );
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.className = "model-canvas";
  renderer.domElement.setAttribute(
    "aria-label",
    "Interactive 3D model. Drag to rotate, pinch to zoom, two fingers to pan.",
  );
  stage.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
  if (!sharedEnvironment) {
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment();
    sharedEnvironment = pmrem.fromScene(room);
    room.dispose();
    pmrem.dispose();
  }
  scene.environment = sharedEnvironment.texture;
  scene.add(new THREE.HemisphereLight(0xe7daff, 0x51465c, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 5, 4);
  scene.add(light);
  const pivot = new THREE.Group();
  pivot.add(object);
  scene.add(pivot);
  let vertices = 0,
    triangles = 0,
    meshes = 0;
  object.traverse((node) => {
    if (node.isMesh) {
      meshes++;
      const g = node.geometry;
      vertices += g.attributes.position?.count || 0;
      triangles += (g.index?.count || g.attributes.position?.count || 0) / 3;
    }
  });
  if (!meshes) {
    modelTextures.cleanup();
    disposeObject();
    throw new Error("Model contains no mesh surfaces.");
  }
  const grid = new THREE.GridHelper(10, 20, 0x685276, 0x382b43);
  grid.material.transparent = true;
  grid.material.opacity = 0.65;
  scene.add(grid);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 0.7;
  controls.minPolarAngle = 0.01;
  controls.maxPolarAngle = Math.PI - 0.01;
  let box,
    center,
    extent,
    dirty = true,
    playing = false;
  controls.addEventListener("change", () => {
    dirty = true;
  });
  function frame() {
    box = new THREE.Box3().setFromObject(pivot);
    center = box.getCenter(new THREE.Vector3());
    const dimensions = box.getSize(new THREE.Vector3());
    extent = Math.max(dimensions.x, dimensions.y, dimensions.z);
    if (!Number.isFinite(extent) || extent < 1e-8 || extent > 1e10)
      throw new Error("Model bounds cannot be framed.");
    const distance = (extent * 1.8) / Math.min(1, camera.aspect);
    camera.near = extent / 10000;
    camera.far = extent * 1000;
    camera.updateProjectionMatrix();
    camera.position
      .copy(center)
      .add(
        new THREE.Vector3(1, 0.65, 1.2).normalize().multiplyScalar(distance),
      );
    controls.target.copy(center);
    controls.minDistance = extent * 0.01;
    controls.maxDistance = extent * 100;
    grid.position.set(center.x, box.min.y - extent * 0.003, center.z);
    grid.scale.setScalar(extent / 4);
    controls.update();
  }
  function resize() {
    dirty = true;
    const { width, height } = stage.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }
  resize();
  const button = (text, run) => {
    const b = document.createElement("button");
    b.className = "button";
    b.textContent = text;
    b.onclick = () => {
      run();
      dirty = true;
    };
    toolbar.append(b);
    return b;
  };
  button("Frame", frame);
  const check = (text, run, checked = false) => {
    const label = document.createElement("label"),
      input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.onchange = () => {
      run(input.checked);
      dirty = true;
    };
    label.append(input, document.createTextNode(text));
    toolbar.append(label);
    return input;
  };
  check("Wireframe", (value) =>
    object.traverse((node) => {
      for (const m of [node.material].flat().filter(Boolean))
        m.wireframe = value;
    }),
  );
  check("Rotate", (value) => {
    controls.autoRotate = value;
  });
  check(
    "Grid",
    (value) => {
      grid.visible = value;
    },
    true,
  );
  check("Z-up", (value) => {
    pivot.rotation.x = value ? -Math.PI / 2 : 0;
    frame();
  });
  const mixer = animations.length ? new THREE.AnimationMixer(object) : null;
  if (mixer) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Animation");
    select.add(new Option("Animation: paused", ""));
    animations.forEach((clip, i) =>
      select.add(new Option(clip.name || `Animation ${i + 1}`, String(i))),
    );
    select.onchange = () => {
      mixer.stopAllAction();
      playing = select.value !== "";
      dirty = true;
      if (select.value !== "")
        mixer.clipAction(animations[Number(select.value)]).play();
    };
    toolbar.append(select);
  }
  const hint = document.createElement("div");
  hint.className = "preview-hint";
  hint.append(
    Object.assign(document.createElement("span"), {
      textContent: "DRAG TO ORBIT · PINCH TO ZOOM",
    }),
    Object.assign(document.createElement("span"), {
      textContent: `${meshes} SURFACES`,
    }),
  );
  stage.append(hint);
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  let active = true,
    last = performance.now();
  const visible = new IntersectionObserver((entries) => {
    active = entries[0].isIntersecting;
    dirty = true;
  });
  visible.observe(stage);
  renderer.setAnimationLoop((time) => {
    const dt = Math.min((time - last) / 1000, 0.05);
    last = time;
    if (active && !document.hidden) {
      if (playing) mixer?.update(dt);
      const moved = controls.update();
      if (dirty || moved || playing) {
        renderer.render(scene, camera);
        dirty = false;
      }
    }
  });
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", cleanup);
    modelTextures.cleanup();
    renderer.setAnimationLoop(null);
    observer.disconnect();
    visible.disconnect();
    controls.dispose();
    mixer?.stopAllAction();
    disposeObject();
    grid.geometry.dispose();
    grid.material.dispose();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    frame();
  } catch (error) {
    cleanup();
    throw error;
  }
  const modelInfo = {
    Surfaces: meshes.toLocaleString(),
    Vertices: vertices.toLocaleString(),
    Triangles: Math.round(triangles).toLocaleString(),
    Animations: animations.length,
    Preview: asset.metadata?.geometry_scope || "Model geometry",
  };
  onInfo(modelInfo);
  // Geometry is interactive immediately; catalogs and textures load in the background.
  void applyModelTextures(object, gltf, asset, assets, toolbar, signal, () => {
    dirty = true;
  })
    .then((result) => {
      if (signal.aborted || disposed) {
        result.cleanup();
        return;
      }
      modelTextures = result;
      modelTextures.onChange = (details) =>
        onInfo({ ...modelInfo, ...details });
      onInfo({ ...modelInfo, ...modelTextures.details });
    })
    .catch((error) => {
      if (!signal.aborted) onInfo({ Textures: error.message });
    });
  return cleanup;
}
