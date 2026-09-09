import "./style.css";
import { readDDS } from "./dds-decoder.js";
import { yieldToUI } from "./scheduling.js";
import {
  makeAsset,
  formatBytes,
  attachMetadata,
  MAX_FILES,
  MAX_FILE_BYTES,
} from "./library.js";
import { setupServerBrowser } from "./server-files.js";
import { extractFastfile, setupExtractionHistory } from "./extractions.js";
import { MAX_COLLECTION_FILES } from "./library.js";
import { decompileScript, highlightedGSC } from "./script-preview.js";

const $ = (id) => document.getElementById(id);
let assets = new Map(),
  importGeneration = 0;
const icons = { image: "◈", model: "⬡", text: "≡", audio: "♫", binary: "▧" };
const categories = {
  all: "All files",
  model: "Models",
  image: "Images",
  text: "Data",
  audio: "Audio",
  binary: "Binary",
};
let kind = "all",
  page = 0,
  selected,
  noticeTimer,
  importWorker,
  cancelled = false,
  importing = false;
let previewCleanup = () => {},
  previewController = new AbortController(),
  filtered = [],
  reports = [];
const PAGE_SIZE = 80;
let summaryRevision = -1,
  indexRevision = -1,
  renderGeneration = 0,
  resultCount = 0;
const collectionWorker = new Worker(
  new URL("./collection.worker.js", import.meta.url),
  { type: "module" },
);
const pendingRenders = new Map();
collectionWorker.onmessage = ({ data }) => {
  pendingRenders.get(data.id)?.(data);
  pendingRenders.delete(data.id);
};
function updateSelection() {
  for (const row of $("asset-list").children) {
    const active = row.dataset.path === selected;
    row.classList.toggle("selected", active);
    row.setAttribute("aria-pressed", String(active));
  }
}
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $("notice").textContent = message;
  $("notice").className = `notice${error ? " error" : ""}`;
  noticeTimer = setTimeout(
    () => $("notice").classList.add("hidden"),
    error ? 14000 : 6500,
  );
}
function download(blob, name) {
  const url = blob.url || URL.createObjectURL(blob),
    a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  if (!blob.url) setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function button(parent, text, action) {
  const b = el("button", "button", text);
  b.onclick = action;
  parent.append(b);
  return b;
}

async function render() {
  const generation = ++renderGeneration;
  const populated = assets.size > 0;
  $("welcome").classList.toggle("hidden", populated);
  $("collection").classList.toggle("hidden", !populated);
  if (!populated) {
    collectionWorker.postMessage({ reset: true });
    indexRevision = -1;
    $("asset-list").replaceChildren();
    return;
  }
  if (summaryRevision !== assets.revision) {
    summaryRevision = assets.revision;
    const values = [...assets.values()],
      counts = values.reduce((a, v) => {
        a[v.kind] = (a[v.kind] || 0) + 1;
        return a;
      }, {});
    const roots = new Set(values.map((a) => a.path.split("/")[0]));
    const extractedZones = new Set(
      reports
        .map((r) => r.value?.fastfile)
        .filter((p) => typeof p === "string")
        .map((p) =>
          p
            .split(/[\\/]/)
            .pop()
            .replace(/^upload_/, "")
            .replace(/\.ff$/i, ""),
        ),
    );
    $("collection-title").textContent =
      roots.size === 1 && roots.has("extraction_cache")
        ? extractedZones.size === 1
          ? [...extractedZones][0]
          : "Fastfile extractions"
        : roots.size === 1 && values[0].path.includes("/")
          ? [...roots][0]
          : "Asset library";
    $("stats").replaceChildren(
      ...[
        [assets.size.toLocaleString(), "FILES IN COLLECTION"],
        [String(counts.model || 0), "3D MODELS"],
        [String(counts.image || 0), "TEXTURES & IMAGES"],
        [formatBytes(values.reduce((n, a) => n + a.size, 0)), "TOTAL SIZE"],
      ].map(([value, label]) => {
        const d = el("div", "stat");
        d.append(el("strong", "", value), el("span", "", label));
        return d;
      }),
    );
    $("kind-tabs").replaceChildren(
      ...Object.entries(categories).map(([key, label]) => {
        const b = el(
          "button",
          `kind-tab${kind === key ? " active" : ""}`,
          label,
        );
        b.setAttribute("aria-pressed", String(kind === key));
        b.onclick = () => {
          kind = key;
          page = 0;
          render();
        };
        return b;
      }),
    );
    const pool = $("pool").value;
    $("pool").replaceChildren(
      new Option("All asset types", ""),
      ...[...new Set(values.map((a) => a.type))]
        .sort()
        .map((type) => new Option(type, type)),
    );
    $("pool").value = pool;
  }
  for (const [i, key] of Object.keys(categories).entries()) {
    const tab = $("kind-tabs").children[i];
    tab.classList.toggle("active", key === kind);
    tab.setAttribute("aria-pressed", String(key === kind));
  }
  // Only plain index records cross the worker boundary, never files or payloads.
  let records;
  if (indexRevision !== assets.revision) {
    records = [];
    for (const a of assets.values()) {
      records.push({
        path: a.path,
        name: a.name,
        displayName: a.displayName,
        kind: a.kind,
        type: a.type,
        size: a.size,
      });
      if (records.length % 1000 === 0) await yieldToUI();
    }
    if (generation !== renderGeneration) return;
    indexRevision = assets.revision;
  }
  // Superseded searches cannot replace the latest query or page.
  for (const resolve of pendingRenders.values()) resolve(null);
  pendingRenders.clear();
  const result = await new Promise((resolve) => {
    pendingRenders.set(generation, resolve);
    collectionWorker.postMessage({
      id: generation,
      records,
      kind,
      pool: $("pool").value,
      query: $("search").value.toLowerCase(),
      sort: $("sort").value,
      page,
      pageSize: PAGE_SIZE,
    });
  });
  if (!result || generation !== renderGeneration) return;
  page = result.page;
  resultCount = result.count;
  filtered = result.paths.map((path) => assets.get(path)).filter(Boolean);
  $("result-count").textContent = `${resultCount.toLocaleString()} files`;
  const rows = filtered.map((a) => {
    const row = el(
      "button",
      `asset-row${a.path === selected ? " selected" : ""}`,
    );
    row.dataset.path = a.path;
    row.setAttribute("aria-label", `Open ${a.displayName || a.name}`);
    row.setAttribute("aria-pressed", String(a.path === selected));
    const label = el("span", "asset-label");
    label.append(
      el("strong", "", a.displayName || a.name),
      el("small", "", `${a.type.toUpperCase()}  /  ${a.ext.toUpperCase()}`),
    );
    const icon = el("span", `asset-icon ${a.kind}`, icons[a.kind]);
    icon.setAttribute("aria-hidden", "true");
    row.append(icon, label, el("span", "asset-size", formatBytes(a.size)));
    row.onclick = () => selectAsset(a, true);
    return row;
  });
  $("asset-list").replaceChildren(
    ...(rows.length
      ? rows
      : [el("p", "no-results", "No files match these filters.")]),
  );
  $("page-label").textContent = resultCount
    ? `${page + 1} / ${Math.ceil(resultCount / PAGE_SIZE)}`
    : "0 files";
  $("previous").disabled = page === 0;
  $("next").disabled = (page + 1) * PAGE_SIZE >= resultCount;
}

async function importEntries(entries, label) {
  const generation = ++importGeneration;
  notice("Opening collection�");
  const incoming = new Map();
  for (const entry of entries) {
    const asset = makeAsset(
      entry.file || entry,
      entry.path || entry.webkitRelativePath || entry.name,
    );
    if (incoming.has(asset.path))
      throw new Error(
        `Duplicate path: ${asset.path}. Import a folder or ZIP to preserve directory paths.`,
      );
    incoming.set(asset.path, asset);
    if (incoming.size % 500 === 0) {
      await yieldToUI();
      if (cancelled || generation !== importGeneration) return;
    }
  }
  if (cancelled || generation !== importGeneration) return;
  const merged = new Map();
  for (const [path, value] of assets) {
    merged.set(path, { ...value });
    if (merged.size % 500 === 0) {
      await yieldToUI();
      if (cancelled || generation !== importGeneration) return;
    }
  }
  let replaced = 0,
    count = 0;
  for (const [path, value] of incoming) {
    if (merged.has(path)) replaced++;
    merged.set(path, value);
    if (++count % 500 === 0) {
      await yieldToUI();
      if (cancelled || generation !== importGeneration) return;
    }
  }
  if (merged.size > MAX_COLLECTION_FILES)
    throw new Error(
      "Collection exceeds 200,000 files. Clear it or open a smaller extraction.",
    );
  merged.revision = assets.revision || 0;
  const meta = await attachMetadata(merged);
  if (cancelled || generation !== importGeneration) return;
  assets = merged;
  reports = meta.reports;
  kind = "all";
  page = 0;
  $("search").value = "";
  $("pool").value = "";
  await render();
  if (generation !== importGeneration) return;
  notice(
    meta.warnings.length
      ? `Imported ${incoming.size} files. Some manifest data could not be read: ${meta.warnings[0]}`
      : `${label || "Collection opened"} · ${incoming.size} files${replaced ? ` · ${replaced} existing paths replaced` : ""}`,
    meta.warnings.length > 0,
  );
  const first =
    [...incoming.values()].find((a) => a.kind === "model") ||
    [...incoming.values()].find((a) => a.kind === "image") ||
    [...incoming.values()][0];
  if (first) void selectAsset(first);
}

async function importFiles(files) {
  if (!files.length || importing) return;
  importing = true;
  cancelled = false;
  $("progress-dialog").showModal();
  $("progress-detail").textContent = "Reading files";
  $("import-progress").removeAttribute("value");
  try {
    const entries = [];
    for (const file of files) {
      if (cancelled) return;
      if (file.name.toLowerCase().endsWith(".zip")) {
        const unzipped = await new Promise((resolve, reject) => {
          importWorker = new Worker(
            new URL("./zip.worker.js", import.meta.url),
            { type: "module" },
          );
          importWorker.onmessage = ({ data }) => {
            if (data.error) {
              importWorker.terminate();
              importWorker = null;
              reject(new Error(data.error));
            } else if (data.files) {
              importWorker.terminate();
              importWorker = null;
              resolve(data.files);
            } else {
              $("import-progress").value = data.progress;
              $("progress-detail").textContent =
                `Opening ${file.name} · ${data.progress}%`;
            }
          };
          importWorker.onerror = () => {
            importWorker?.terminate();
            importWorker = null;
            reject(new Error("ZIP worker failed."));
          };
          $("cancel-import").onclick = () => {
            cancelled = true;
            importWorker?.terminate();
            importWorker = null;
            reject(new Error("Import cancelled."));
          };
          importWorker.postMessage(file);
        });
        entries.push(...unzipped);
      } else entries.push({ file, path: file.webkitRelativePath || file.name });
    }
    const opened = [];
    for (const entry of entries) {
      if (cancelled) break;
      if (/\.ff$/i.test(entry.file.name)) {
        $("progress-dialog").close();
        const result = await extractFastfile(entry.file);
        opened.push(...result.entries);
      } else opened.push(entry);
    }
    if (!cancelled && opened.length)
      await importEntries(opened, "Extraction opened");
  } catch (error) {
    if (!cancelled) notice(error.message, true);
  } finally {
    $("progress-dialog").close();
    importing = false;
    $("file-input").value = "";
    $("folder-input").value = "";
  }
}

function clearPreview() {
  previewController.abort();
  previewCleanup();
  previewCleanup = () => {};
  previewController = new AbortController();
}

async function selectAsset(asset, scroll = false) {
  if (asset.ext === "ff") {
    try {
      const result = await extractFastfile(asset.file);
      cancelled = false;
      await importEntries(result.entries, `Extracted ${result.job.name}`);
    } catch (error) {
      notice(error.message, true);
    }
    return;
  }
  clearPreview();
  const signal = previewController.signal;
  selected = asset.path;
  updateSelection();
  const inspector = $("inspector"),
    header = el("div", "inspector-header"),
    title = el("div", "inspector-title");
  title.append(
    el("h2", "", asset.displayName || asset.name),
    el("span", "", `${asset.type} / ${asset.ext}`),
  );
  header.append(title);
  button(header, "↓ Original", () => download(asset.file, asset.name));
  const toolbar = el("div", "preview-toolbar"),
    stage = el("div", "preview-stage"),
    details = el("section", "asset-details");
  details.append(el("h3", "", "Asset details"));
  const grid = el("dl", "detail-grid");
  details.append(grid);
  const info = {
    Path: asset.path,
    Size: formatBytes(asset.size),
    Type: asset.type,
  };
  const setInfo = (values) => {
    if (signal.aborted) return;
    Object.assign(info, values);
    grid.replaceChildren(
      ...Object.entries(info).flatMap(([k, v]) => [
        el("dt", "", k),
        el("dd", "", String(v)),
      ]),
    );
  };
  setInfo({});
  if (asset.metadata) {
    const disclosure = el("details");
    disclosure.append(
      el("summary", "", "Export record"),
      el("pre", "", JSON.stringify(asset.metadata, null, 2)),
    );
    details.append(disclosure);
  }
  inspector.replaceChildren(header, toolbar, stage, details);
  stage.append(el("span", "loading"));
  if (scroll && matchMedia("(max-width: 760px)").matches)
    inspector.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  try {
    if (asset.kind === "model") {
      const { showModel } = await import("./model.js");
      if (signal.aborted) return;
      const cleanup = await showModel(
        stage,
        toolbar,
        asset,
        assets,
        setInfo,
        signal,
      );
      if (signal.aborted) cleanup();
      else previewCleanup = cleanup;
    } else if (asset.kind === "image")
      await showImage(stage, toolbar, asset, setInfo, signal);
    else if (asset.kind === "audio") {
      toolbar.remove();
      const url = asset.file.url || URL.createObjectURL(asset.file),
        wrap = el("div", "audio-wrap"),
        audio = el("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = url;
      audio.setAttribute("aria-label", asset.name);
      audio.onerror = () => {
        if (!signal.aborted)
          notice(
            "This browser cannot decode this audio format. You can download the original.",
            true,
          );
      };
      wrap.append(el("span", "", "♫"), audio);
      stage.replaceChildren(wrap);
      previewCleanup = () => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        if (!asset.file.url) URL.revokeObjectURL(url);
      };
    } else if (asset.ext === "gscbin") {
      toolbar.replaceChildren(
        el("span", "subtle", "Decompiling IW8 script with ACTS…"),
      );
      const result = await decompileScript(asset, signal);
      if (signal.aborted) return;
      const limit = 1024 * 1024;
      const label =
        result.status === "partial"
          ? "Partially decompiled GSC"
          : "Decompiled GSC";
      toolbar.replaceChildren(el("span", "subtle", label));
      for (const warning of result.warnings)
        toolbar.append(el("span", "script-warning", warning));
      if (result.source.length > limit)
        toolbar.append(
          el(
            "span",
            "script-warning",
            "Preview limited to 1 MB; Download GSC saves the complete result.",
          ),
        );
      const download = el("button", "button quiet", "Download GSC");
      const url = URL.createObjectURL(
        new Blob([result.source], { type: "text/plain;charset=utf-8" }),
      );
      download.onclick = () => {
        const link = document.createElement("a");
        link.href = url;
        link.download = asset.name.replace(/\.gscbin$/i, "") + ".gsc";
        link.click();
      };
      toolbar.append(download);
      previewCleanup = () => URL.revokeObjectURL(url);
      stage.replaceChildren(
        highlightedGSC(result.source.slice(0, limit), signal),
      );
      setInfo({
        Preview: label,
        Language: "GSC",
        Engine: "IW8",
        "Compiled SHA-256": result.sha256,
      });
    } else if (asset.kind === "text") {
      const limit = 1024 * 1024;
      let text = await asset.file.slice(0, limit).text({ signal });
      if (signal.aborted) return;
      if (asset.ext === "json" && asset.size <= limit) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          setInfo({ Note: "Invalid JSON; showing original text" });
        }
      }
      toolbar.replaceChildren(
        el(
          "span",
          "subtle",
          asset.size > limit
            ? "Preview limited to the first 1 MB. Original download is complete."
            : "Text preview",
        ),
      );
      stage.replaceChildren(
        ["gsc", "csc", "gsh"].includes(asset.ext)
          ? highlightedGSC(text, signal)
          : el("pre", "text-preview", text),
      );
    } else {
      toolbar.remove();
      const bytes = new Uint8Array(
        await asset.file.slice(0, 4096).arrayBuffer({ signal }),
      );
      if (signal.aborted) return;
      const msg = el("div", "preview-message");
      if (asset.name.endsWith(".shared.bin"))
        msg.append(
          el("strong", "", "Packed model geometry"),
          el(
            "p",
            "",
            "Run the Replay exporter with --geometry and import its .geometry.glb sidecar to view this surface set.",
          ),
        );
      else
        msg.append(
          el("strong", "", "Binary asset"),
          el(
            "p",
            "",
            "No visual preview for this format. The original file remains available.",
          ),
        );
      const pre = el("pre", "text-preview");
      pre.textContent = Array.from(
        { length: Math.ceil(bytes.length / 16) },
        (_, row) => {
          const b = bytes.slice(row * 16, row * 16 + 16);
          return `${(row * 16).toString(16).padStart(8, "0")}  ${[...b]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join(" ")
            .padEnd(
              47,
            )}  ${[...b].map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : ".")).join("")}`;
        },
      ).join("\n");
      stage.style.display = "block";
      stage.style.overflow = "auto";
      msg.style.padding = "22px";
      pre.style.height = "auto";
      pre.style.paddingTop = "0";
      stage.replaceChildren(msg, pre);
      setInfo({ Preview: `First ${bytes.length} bytes` });
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = el("div", "preview-message");
    message.append(
      el("strong", "", "Preview unavailable"),
      el("p", "", error.message),
    );
    stage.replaceChildren(message);
    setInfo({ Preview: error.message });
  }
}

async function showImage(stage, toolbar, asset, setInfo, signal) {
  if (asset.size > MAX_FILE_BYTES)
    throw new Error("Image exceeds the 256 MB preview limit.");
  stage.classList.add("checker");
  const canvas = el("canvas", "image-surface");
  canvas.setAttribute("aria-label", `Image preview: ${asset.name}`);
  let decodeController,
    imageUrl,
    original,
    width,
    height,
    zoom = 1,
    panX = 0,
    panY = 0,
    channel = "rgba",
    disposed = false;
  const selectedResource = {},
    resourceControls = el("div");
  resourceControls.style.display = "contents";
  const percent = el("span", "subtle");
  const transform = () => {
    const fit = Math.min(
      (stage.clientWidth - 32) / width,
      (stage.clientHeight - 32) / height,
      1,
    );
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.transform = `translate(${panX}px,${panY}px) scale(${fit * zoom})`;
    percent.textContent = `${Math.round(fit * zoom * 100)}%`;
  };
  button(toolbar, "−", () => {
    zoom = Math.max(0.1, zoom / 1.4);
    transform();
  }).setAttribute("aria-label", "Zoom out");
  button(toolbar, "+", () => {
    zoom = Math.min(64, zoom * 1.4);
    transform();
  }).setAttribute("aria-label", "Zoom in");
  button(toolbar, "Fit", () => {
    zoom = 1;
    panX = panY = 0;
    transform();
  });
  toolbar.append(percent);
  const channels = el("select");
  channels.setAttribute("aria-label", "Image channel");
  for (const [value, label] of [
    ["rgba", "RGBA"],
    ["rgb", "RGB"],
    ["r", "Red"],
    ["g", "Green"],
    ["b", "Blue"],
    ["a", "Alpha"],
  ])
    channels.add(new Option(label, value));
  toolbar.append(channels);
  button(toolbar, "Save PNG", () =>
    canvas.toBlob((blob) => {
      if (blob) download(blob, asset.name.replace(/\.[^.]+$/, "") + ".png");
    }),
  );
  toolbar.append(resourceControls);
  function paint() {
    if (!original) return;
    const output = new Uint8ClampedArray(original);
    if (channel !== "rgba")
      for (let i = 0; i < output.length; i += 4) {
        if (channel !== "rgb")
          output[i] =
            output[i + 1] =
            output[i + 2] =
              original[i + { r: 0, g: 1, b: 2, a: 3 }[channel]];
        output[i + 3] = 255;
      }
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext("2d")
      .putImageData(new ImageData(output, width, height), 0, 0);
    stage.replaceChildren(canvas);
    transform();
  }
  channels.onchange = () => {
    channel = channels.value;
    paint();
  };
  async function decode() {
    decodeController?.abort();
    decodeController = new AbortController();
    const decoding = decodeController;
    const cancel = () => decoding.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (asset.ext === "dds") {
      let result;
      try {
        result = await readDDS(
          asset.file,
          { ...selectedResource },
          decoding.signal,
        );
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      if (decoding.signal.aborted) return;
      if (!result || signal.aborted || disposed) return;
      const { info, pixels } = result;
      width = info.width;
      height = info.height;
      original = new Uint8ClampedArray(pixels);
      setInfo({
        Dimensions: `${width} × ${height}`,
        Format: info.format,
        Mips: info.mips,
        Faces: info.faces,
        Layers: info.layers,
        "Volume slices": info.depth,
      });
      resourceControls.replaceChildren();
      for (const [field, label, count] of [
        ["mip", "Mip", info.mips],
        ["face", "Face", info.faces],
        ["layer", "Layer", info.layers],
        ["slice", "Slice", info.depth],
      ]) {
        if (count < 2) continue;
        const wrap = el("label", "", `${label} `),
          select = el("select");
        select.setAttribute("aria-label", `DDS ${label.toLowerCase()}`);
        for (let i = 0; i < count; i++)
          select.add(
            new Option(
              field === "face"
                ? ["+X", "−X", "+Y", "−Y", "+Z", "−Z"][i]
                : String(i),
              String(i),
            ),
          );
        select.value = String(selectedResource[field] || 0);
        select.onchange = async () => {
          selectedResource[field] = Number(select.value);
          if (field === "mip") selectedResource.slice = 0;
          try {
            await decode();
          } catch (error) {
            if (!signal.aborted && error.name !== "AbortError")
              notice(error.message, true);
          }
        };
        wrap.append(select);
        resourceControls.append(wrap);
      }
    } else {
      const image = new Image();
      imageUrl = asset.file.url || URL.createObjectURL(asset.file);
      image.src = imageUrl;
      await image.decode();
      if (signal.aborted || disposed) {
        URL.revokeObjectURL(imageUrl);
        return;
      }
      width = image.naturalWidth;
      height = image.naturalHeight;
      if (width * height > 16 * 1024 * 1024)
        throw new Error("Image exceeds the 16 million pixel preview limit.");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      original = ctx.getImageData(0, 0, width, height).data;
      setInfo({
        Dimensions: `${width} × ${height}`,
        Format: asset.ext.toUpperCase(),
      });
      URL.revokeObjectURL(imageUrl);
      imageUrl = null;
    }
    zoom = 1;
    panX = panY = 0;
    paint();
  }
  const pointers = new Map();
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
  };
  canvas.onpointermove = (e) => {
    const previous = pointers.get(e.pointerId);
    if (!previous) return;
    const other = [...pointers].find(([id]) => id !== e.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(previous[0] - other[0], previous[1] - other[1]),
        after = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
      if (before > 4)
        zoom = Math.max(0.1, Math.min(64, (zoom * after) / before));
    } else {
      panX += e.clientX - previous[0];
      panY += e.clientY - previous[1];
    }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    transform();
  };
  canvas.onpointerup = canvas.onpointercancel = (e) =>
    pointers.delete(e.pointerId);
  const wheel = (e) => {
    e.preventDefault();
    zoom = Math.max(0.1, Math.min(64, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    transform();
  };
  stage.addEventListener("wheel", wheel, { passive: false });
  const observer = new ResizeObserver(() => {
    if (width) transform();
  });
  observer.observe(stage);
  const cleanup = () => {
    disposed = true;
    decodeController?.abort();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    observer.disconnect();
    stage.removeEventListener("wheel", wheel);
    canvas.width = canvas.height = 0;
    original = null;
  };
  previewCleanup = cleanup;
  try {
    await decode();
  } catch (error) {
    cleanup();
    throw error;
  }
}

$("import-button").onclick = () => $("import-dialog").showModal();
$("help-button").onclick = () => $("help-dialog").showModal();
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => b.closest("dialog").close()));
for (const id of ["files-button", "dialog-files"])
  $(id).onclick = () => {
    $("import-dialog").close();
    $("file-input").click();
  };
for (const id of ["folder-button", "dialog-folder"])
  $(id).onclick = () => {
    $("import-dialog").close();
    $("folder-input").click();
  };
$("file-input").onchange = (e) => importFiles([...e.target.files]);
$("folder-input").onchange = (e) => importFiles([...e.target.files]);
$("search").oninput =
  $("sort").onchange =
  $("pool").onchange =
    () => {
      page = 0;
      render();
    };
$("previous").onclick = () => {
  page--;
  render();
  $("asset-list").scrollTop = 0;
};
$("next").onclick = () => {
  page++;
  render();
  $("asset-list").scrollTop = 0;
};
$("cancel-import").onclick = () => {
  cancelled = true;
};
$("progress-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  $("cancel-import").click();
});
$("clear-button").onclick = () => {
  importGeneration++;
  clearPreview();
  assets.clear();
  assets.revision = (assets.revision || 0) + 1;
  selected = undefined;
  kind = "all";
  page = 0;
  reports = [];
  render();
  $("inspector").replaceChildren();
  notice("Collection cleared. Your original files are unchanged.");
};
$("demo-button").onclick = async () => {
  const b = $("demo-button");
  b.disabled = true;
  b.textContent = "Opening demo…";
  try {
    const { demoFiles } = await import("./demo.js");
    cancelled = false;
    await importEntries(await demoFiles(), "Demo opened");
  } catch (error) {
    notice(error.message, true);
  } finally {
    b.disabled = false;
    b.textContent = "Open demo ↗";
  }
};
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    dragDepth++;
    $("drag-overlay").classList.remove("hidden");
  }
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("drag-overlay").classList.add("hidden");
  }
});
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drag-overlay").classList.add("hidden");
  const roots = [...(e.dataTransfer?.items || [])]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!roots.length) {
    importFiles([...(e.dataTransfer?.files || [])]);
    return;
  }
  const files = [];
  async function walk(entry, prefix = "") {
    if (files.length >= MAX_FILES)
      throw new Error("Folder exceeds 20,000 files.");
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) =>
        entry.file(resolve, reject),
      );
      Object.defineProperty(file, "webkitRelativePath", {
        value: prefix + file.name,
      });
      files.push(file);
    } else {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + "/");
      }
    }
  }
  try {
    for (const root of roots) await walk(root);
    await importFiles(files);
  } catch (error) {
    notice(error.message, true);
  }
});
render();
setupServerBrowser({
  importEntries: (entries, label) => {
    cancelled = false;
    return importEntries(entries, label);
  },
  importFiles,
  notice,
  extractFastfile,
});
setupExtractionHistory();
window.addEventListener("zone-extraction-status", (event) =>
  notice(event.detail),
);
window.addEventListener("zone-extraction-open", async (event) => {
  try {
    cancelled = false;
    await importEntries(
      event.detail.entries,
      `Opened ${event.detail.job.name}`,
    );
    if (event.detail.job.status !== "complete")
      notice(
        event.detail.job.error ||
          event.detail.job.message ||
          "Opened partial extraction output.",
        true,
      );
  } catch (error) {
    notice(error.message, true);
  }
});
