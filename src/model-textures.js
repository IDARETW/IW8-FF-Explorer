import * as THREE from "three";
import { modelBindings, surfaceMaterial } from "./material-bindings.js";
import { readDDS } from "./dds-decoder.js";
import { mapConcurrent } from "./scheduling.js";

export function expandOpacityChannel(rgba) {
  for (let i = 0; i < rgba.length; i += 4) rgba[i + 1] = rgba[i + 2] = rgba[i];
  return rgba;
}

async function readColorTexture(asset, signal, opacity = false) {
  if (asset.size > 256 * 1024 ** 2)
    throw new Error(`${asset.name}: texture exceeds 256 MB.`);
  if (signal.aborted) throw new DOMException("Preview cancelled", "AbortError");
  let texture;
  if (asset.ext === "dds") {
    const { info, pixels } = await readDDS(
      asset.file,
      (buffer) => {
        const header = new DataView(buffer);
        if (buffer.byteLength < 128) throw new Error("Truncated DDS texture.");
        const edge = Math.max(
          header.getUint32(12, true),
          header.getUint32(16, true),
        );
        return {
          mip: Math.min(
            Math.max(0, Math.ceil(Math.log2(edge / 1024))),
            Math.max(0, header.getUint32(28, true) - 1),
          ),
        };
      },
      signal,
    );
    if (info.faces !== 1 || info.layers !== 1 || info.depth !== 1)
      throw new Error("A model color texture must be a 2D image.");
    const rgba = new Uint8Array(pixels);
    // BC4 is a single red channel. Three's alphaMap samples green, so
    // explicitly expand scalar opacity before uploading the mask texture.
    if (opacity) expandOpacityChannel(rgba);
    // IW8's color alpha can carry specular data; do not interpret it as opacity.
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    if (Math.max(info.width, info.height) > 1024) {
      const bitmap = await createImageBitmap(
        new ImageData(
          new Uint8ClampedArray(rgba.buffer),
          info.width,
          info.height,
        ),
      );
      const canvas = document.createElement("canvas"),
        scale = 1024 / Math.max(info.width, info.height);
      canvas.width = Math.max(1, Math.round(info.width * scale));
      canvas.height = Math.max(1, Math.round(info.height * scale));
      canvas
        .getContext("2d")
        .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      texture = new THREE.CanvasTexture(canvas);
    } else texture = new THREE.DataTexture(rgba, info.width, info.height);
  } else {
    const blob = asset.file.blob
      ? await asset.file.blob({ signal })
      : asset.file;
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: "none",
      premultiplyAlpha: "none",
    });
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    texture = new THREE.CanvasTexture(canvas);
  }
  texture.flipY = false;
  texture.colorSpace = opacity ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export async function applyModelTextures(
  object,
  gltf,
  asset,
  assets,
  toolbar,
  signal,
  invalidate = () => {},
) {
  const binding = await modelBindings(asset, assets);
  if (signal.aborted || !binding) return { details: {}, cleanup() {} };
  const meshes = [];
  object.traverse((node) => {
    if (!node.isMesh) return;
    const association = gltf.parser.associations.get(node);
    const primitive =
      gltf.parser.json.meshes[association?.meshes]?.primitives[
        association?.primitives
      ];
    if (Number.isInteger(primitive?.extras?.sourceSurface))
      meshes.push({
        node,
        surface: primitive.extras.sourceSurface,
        original: node.material,
      });
  });
  const textures = new Map(),
    createdMaterials = new Set();
  let enabled = true,
    cutouts = true,
    cutoff = 0.25,
    generation = 0,
    details = {},
    disposed = false;
  let decodedBytes = 0,
    onChange = () => {};
  const status = document.createElement("span");
  status.className = "model-texture-status";
  status.setAttribute("role", "status");
  toolbar.append(status);
  const loadTexture = async (image, opacity = false) => {
    const key = `${opacity ? "mask" : "color"}:${image.path}`;
    if (!textures.has(key)) {
      if (textures.size >= 64)
        throw new Error("This model exceeds the 64-texture preview budget.");
      textures.set(
        key,
        readColorTexture(image, signal, opacity).then((texture) => {
          const bytes = texture.image.width * texture.image.height * 4;
          if (decodedBytes + bytes > 64 * 1024 ** 2) {
            texture.dispose();
            throw new Error(
              "Model textures exceed the 64 MB decoded preview budget.",
            );
          }
          decodedBytes += bytes;
          return texture;
        }),
      );
    }
    return textures.get(key);
  };
  const update = async (variant = 0) => {
    const current = ++generation;
    for (const entry of meshes) entry.node.material = entry.original;
    for (const material of createdMaterials) material.dispose();
    createdMaterials.clear();
    let mapped = 0,
      masked = 0;
    const missing = new Set(),
      errors = [];
    status.textContent = "Loading model textures…";
    await mapConcurrent(meshes, 3, async ({ node, surface }) => {
      if (signal.aborted || disposed || current !== generation) return;
      const selected = surfaceMaterial(binding, variant, surface);
      if (!selected.image) {
        if (selected.name) missing.add(selected.imageName || selected.name);
        return;
      }
      try {
        const [map, alphaMap] = await Promise.all([
          loadTexture(selected.image),
          selected.opacity ? loadTexture(selected.opacity, true) : null,
        ]);
        if (selected.opacityName && !selected.opacity)
          missing.add(selected.opacityName);
        if (signal.aborted || disposed || current !== generation) return;
        const material = new THREE.MeshStandardMaterial({
          name: selected.name,
          map: enabled ? map : null,
          alphaMap: enabled && cutouts ? alphaMap : null,
          alphaTest: enabled && cutouts && alphaMap ? cutoff : 0,
          roughness: 0.85,
          metalness: 0,
          vertexColors: !!node.geometry.attributes.color,
          side: THREE.DoubleSide,
          wireframe: node.material.wireframe,
        });
        material.userData.colorMap = map;
        material.userData.opacityMap = alphaMap;
        createdMaterials.add(material);
        node.material = material;
        invalidate();
        mapped++;
        if (alphaMap) masked++;
      } catch (error) {
        if (error.name !== "AbortError") errors.push(error.message);
      }
    });
    if (signal.aborted || disposed || current !== generation) return;
    const label = `${mapped} / ${meshes.length} surfaces textured`;
    status.textContent =
      label +
      (missing.size
        ? ` · ${missing.size} missing texture/material references`
        : "") +
      (errors.length ? ` · ${errors[0]}` : "");
    if (!binding.variants.length)
      status.textContent =
        "No XModel material assignments in this collection. Open its model and techsets extraction together.";
    details = {
      Textures: label,
      ...(masked
        ? { Cutouts: `${masked} surfaces use separate opacity masks` }
        : {}),
      ...(missing.size
        ? { "Missing textures/materials": [...missing].join(", ") }
        : {}),
    };
    status.dataset.cutoutSurfaces = String(masked);
    onChange(details);
  };
  const label = document.createElement("label"),
    toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = true;
  label.append(toggle, document.createTextNode("Textures"));
  toolbar.append(label);
  toggle.onchange = () => {
    enabled = toggle.checked;
    for (const material of createdMaterials) {
      material.map = enabled ? material.userData.colorMap : null;
      material.alphaMap =
        enabled && cutouts ? material.userData.opacityMap : null;
      material.alphaTest = material.alphaMap ? cutoff : 0;
      material.needsUpdate = true;
    }
    invalidate();
  };
  if (
    binding.variants.some((v) =>
      v.materials.some((name) =>
        binding.materials[name]?.textures?.some((t) => t.slot === 27),
      ),
    )
  ) {
    const maskLabel = document.createElement("label"),
      maskToggle = document.createElement("input");
    maskToggle.type = "checkbox";
    maskToggle.checked = true;
    maskLabel.append(maskToggle, document.createTextNode("Cutouts"));
    toolbar.append(maskLabel);
    const threshold = document.createElement("input");
    threshold.type = "range";
    threshold.min = "0.01";
    threshold.max = "1";
    threshold.step = "0.01";
    threshold.value = String(cutoff);
    threshold.setAttribute("aria-label", "Cutout threshold");
    threshold.style.width = "80px";
    toolbar.append(threshold);
    maskToggle.onchange = () => {
      cutouts = maskToggle.checked;
      toggle.onchange();
    };
    threshold.oninput = () => {
      cutoff = Number(threshold.value);
      toggle.onchange();
    };
  }
  if (binding.variants.length > 1) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Material set");
    binding.variants.forEach((v, index) =>
      select.add(new Option(`${v.model} · LOD ${v.lod}`, String(index))),
    );
    select.onchange = () => {
      update(Number(select.value));
    };
    toolbar.append(select);
  }
  void update();
  return {
    set onChange(callback) {
      onChange = callback;
    },
    get details() {
      return details;
    },
    cleanup() {
      disposed = true;
      generation++;
      for (const task of textures.values())
        task.then((t) => t.dispose()).catch(() => {});
      for (const material of createdMaterials) material.dispose();
      for (const entry of meshes)
        for (const material of [entry.original].flat().filter(Boolean))
          material.dispose();
    },
  };
}
