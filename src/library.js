import { yieldToUI, mapConcurrent } from "./scheduling.js";
export const MAX_FILES = 20000;
export const MAX_COLLECTION_FILES = 200000;
export const MAX_ZIP_BYTES = 512 * 1024 * 1024;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

export function safePath(value) {
  const path = String(value).replaceAll("\\", "/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    /[\x00-\x1f]/.test(path)
  )
    throw new Error("Invalid file path.");
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..") || !parts.length)
    throw new Error("File path leaves the collection.");
  return parts.join("/");
}

export function classify(path) {
  const ext = path.toLowerCase().split(".").pop();
  if (["dds", "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].includes(ext))
    return "image";
  if (["glb", "gltf", "obj"].includes(ext)) return "model";
  if (["wav", "flac", "ogg", "mp3", "m4a"].includes(ext)) return "audio";
  if (
    [
      "json",
      "jsonl",
      "csv",
      "txt",
      "cfg",
      "lua",
      "gsc",
      "gsh",
      "csc",
      "hlsl",
      "xml",
      "mtl",
      "md",
      "ddl",
    ].includes(ext)
  )
    return "text";
  return "binary";
}

export function makeAsset(file, path = file.webkitRelativePath || file.name) {
  path = safePath(path);
  const pieces = path.split("/");
  const assetFolder = pieces.lastIndexOf("assets");
  return {
    path,
    file,
    name: pieces.at(-1),
    ext: pieces.at(-1).split(".").pop().toLowerCase(),
    kind: classify(path),
    type:
      assetFolder >= 0 && pieces.length > assetFolder + 2
        ? pieces[assetFolder + 1]
        : classify(path),
    size: file.size,
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const e = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** e).toFixed(e === 1 ? 0 : 1)} ${["B", "KB", "MB", "GB"][e]}`;
}

// A model can reference only files that the user imported, or embedded data.
export function resolveResource(url, modelPath, assets) {
  if (url.startsWith("data:")) return url;
  if (/^(?:[a-z]+:|\/\/|\/)/i.test(url))
    throw new Error(
      "External model resources are disabled. Import the texture or buffer with the model.",
    );
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    throw new Error("Invalid model resource URL.");
  }
  const parts = modelPath.split("/").slice(0, -1);
  for (const piece of decoded.replaceAll("\\", "/").split("/")) {
    if (piece === "..") {
      if (!parts.length)
        throw new Error("Model resource leaves the collection.");
      parts.pop();
    } else if (piece && piece !== ".") parts.push(piece);
  }
  const path = safePath(parts.join("/"));
  const exact = assets.get(path);
  if (exact) return exact;
  throw new Error(
    `Missing model resource: ${path}. Import the whole model folder or ZIP.`,
  );
}

export async function attachMetadata(assets) {
  assets.revision = (assets.revision || 0) + 1;
  const warnings = [];
  const reports = [];
  const sources = [...assets.values()].filter(
    (entry) =>
      ["assets.jsonl", "manifest.json"].includes(entry.name.toLowerCase()) &&
      entry.size <= 16 * 1024 * 1024,
  );
  const texts = await mapConcurrent(sources, 3, async (entry) => {
    try {
      return await entry.file.text();
    } catch (error) {
      return error;
    }
  });
  for (const [i, entry] of sources.entries()) {
    try {
      if (texts[i] instanceof Error) throw texts[i];
      const text = texts[i];
      texts[i] = null;
      if (entry.name.toLowerCase() === "manifest.json") {
        reports.push({ path: entry.path, value: JSON.parse(text) });
        continue;
      }
      const base = entry.path.split("/").slice(0, -1).join("/");
      let batch = 0;
      for (const line of text.split(/\r?\n/)) {
        if (++batch % 200 === 0) await yieldToUI();
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        for (const field of ["file", "payload_file", "geometry_file"]) {
          if (typeof record[field] !== "string") continue;
          const target = assets.get(
            safePath(`${base ? base + "/" : ""}${record[field]}`),
          );
          if (target) {
            target.metadata = record;
            target.type = record.type || target.type;
            target.displayName = record.name || target.name;
          }
        }
      }
    } catch (error) {
      warnings.push(`${entry.name}: ${error.message}`);
    }
  }
  return { warnings, reports };
}
