import { yieldToUI, mapConcurrent } from "./scheduling.js";
export const normalizeAssetName = (value) =>
  typeof value === "string" ? value.replace(/^,+/, "") : "";
const cached = new WeakMap();
const fieldsOf = (doc) =>
  doc?.format === "mw19-asset-json" ? doc.asset?.fields : null;

export function addStructuredMaterial(catalog, doc) {
  const fields = fieldsOf(doc);
  if (!fields) return;
  if (doc.pool === "xmodel") {
    const handles = fields.materialHandles?.values || [];
    for (const [lod, value] of (fields.lodInfo || [])
      .slice(0, fields.numLods || 0)
      .entries()) {
      const surfs = normalizeAssetName(value.modelSurfsStaging?.name),
        start = value.surfIndex,
        count = value.numsurfs;
      if (
        !surfs ||
        !Number.isInteger(start) ||
        !Number.isInteger(count) ||
        count <= 0 ||
        start < 0 ||
        start + count > handles.length
      )
        continue;
      (catalog.surfaces[surfs] ||= []).push({
        model: normalizeAssetName(fields.name?.string),
        lod,
        materials: handles
          .slice(start, start + count)
          .map((h) => normalizeAssetName(h?.name)),
      });
    }
  } else if (doc.pool === "material") {
    const name = normalizeAssetName(fields.name?.string);
    if (name)
      catalog.materials[name] = {
        technique: normalizeAssetName(fields.techniqueSet?.name),
        textures: (fields.textureTable?.values || []).map((t) => ({
          slot: t.index,
          image: normalizeAssetName(t.image?.name),
        })),
      };
  }
}

function emptyCatalog() {
  return { surfaces: Object.create(null), materials: Object.create(null) };
}

async function buildCatalogs(assets) {
  const catalogs = [],
    indexedScopes = [];
  const indices = [...assets.values()].filter(
    (a) => a.name === "viewer_materials.json" && a.size <= 16 * 1024 ** 2,
  );
  const docs = await mapConcurrent(indices, 3, async (asset) =>
    JSON.parse(await asset.file.text()),
  );
  for (const [i, asset] of indices.entries()) {
    const doc = docs[i];
    if (
      doc?.format !== "zone-materials" ||
      doc.version !== 1 ||
      !doc.surfaces ||
      !doc.materials
    )
      continue;
    const scope = asset.path.slice(0, -asset.name.length);
    catalogs.push({ ...doc, scope });
    indexedScopes.push(scope);
  }
  // Portable folders/ZIPs can use ACTS JSON directly; native server jobs provide
  // a small index so opening a model does not fetch hundreds of XModel files.
  const fallback = emptyCatalog();
  let total = 0;
  for (const asset of assets.values()) {
    if (
      !["xmodel", "material"].includes(asset.type) ||
      asset.ext !== "json" ||
      indexedScopes.some((s) => asset.path.startsWith(s))
    )
      continue;
    total += asset.size;
    if (asset.size > 32 * 1024 ** 2 || total > 128 * 1024 ** 2)
      throw new Error(
        "Material records exceed the browser import limit. Use the server extraction index.",
      );
    addStructuredMaterial(fallback, JSON.parse(await asset.file.text()));
    await yieldToUI();
  }
  catalogs.push({ ...fallback, scope: "" });
  return catalogs;
}

export async function modelBindings(asset, assets) {
  const name = normalizeAssetName(asset.metadata?.name);
  if (asset.type !== "xmodelsurfs" || !name) return null;
  if (!cached.has(assets) || cached.get(assets).revision !== assets.revision)
    cached.set(assets, {
      revision: assets.revision,
      promise: buildCatalogs(assets),
    });
  const catalogs = await cached.get(assets).promise;
  const owner =
    catalogs.find(
      (c) => c.scope && asset.path.startsWith(c.scope) && c.surfaces[name],
    ) || catalogs.find((c) => c.surfaces[name]);
  if (!owner) return { variants: [], materials: {}, images: new Map() };
  if (owner.resolved)
    return { variants: owner.surfaces[name], ...owner.resolved };
  const materials = Object.assign(
    Object.create(null),
    ...catalogs.filter((c) => c !== owner).map((c) => c.materials),
    owner.materials,
  );
  const images = new Map();
  for (const candidate of assets.values()) {
    if (candidate.kind !== "image") continue;
    const imageName = normalizeAssetName(candidate.metadata?.name);
    if (!imageName) continue;
    const current = images.get(imageName);
    if (
      !current ||
      (owner.scope &&
        candidate.path.startsWith(owner.scope) &&
        !current.path.startsWith(owner.scope))
    )
      images.set(imageName, candidate);
  }
  owner.resolved = { materials, images };
  return { variants: owner.surfaces[name], materials, images };
}

export function surfaceMaterial(binding, variant, surface) {
  const name = binding?.variants[variant]?.materials[surface];
  const material =
    name && Object.hasOwn(binding.materials, name)
      ? binding.materials[name]
      : null;
  const color = material?.textures?.find((t) => t.slot === 0);
  const opacity = material?.textures?.find((t) => t.slot === 27);
  return {
    name,
    material,
    imageName: color?.image,
    image: binding?.images.get(color?.image),
    opacityName: opacity?.image,
    opacity: binding?.images.get(opacity?.image),
  };
}
