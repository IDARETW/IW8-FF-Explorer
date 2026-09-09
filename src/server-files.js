import { safePath, formatBytes, MAX_ZIP_BYTES } from "./library.js";

export function remoteFile(entry, root) {
  const url = new URL("./api/file", document.baseURI);
  url.searchParams.set("root", root.id);
  url.searchParams.set("path", entry.path);
  // The server checks these on every read, so an extraction changing underneath
  // the collection cannot silently mix bytes from different file versions.
  url.searchParams.set("size", String(entry.size));
  url.searchParams.set("mtime", entry.mtime);
  const read = async (start, end, signal) => {
    const headers =
      start !== undefined
        ? { Range: `bytes=${start}-${Math.max(start, end - 1)}` }
        : {};
    if (start !== undefined && end <= start) return new Blob();
    const response = await fetch(url, {
      headers,
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "Server file changed. Open the folder again to refresh it."
          : `Cannot read server file (${response.status}).`,
      );
    return response.blob();
  };
  return {
    name: entry.name,
    size: entry.size,
    url: url.href,
    server: {
      root: root.id,
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
    },
    async blob({ signal } = {}) {
      return read(undefined, undefined, signal);
    },
    async arrayBuffer({ signal } = {}) {
      return (await read(undefined, undefined, signal)).arrayBuffer();
    },
    async text({ signal } = {}) {
      return (await read(undefined, undefined, signal)).text();
    },
    slice(start = 0, end = entry.size) {
      start = Math.max(
        0,
        Math.min(start < 0 ? entry.size + start : start, entry.size),
      );
      end = Math.max(
        start,
        Math.min(end < 0 ? entry.size + end : end, entry.size),
      );
      return {
        async arrayBuffer({ signal } = {}) {
          return (await read(start, end, signal)).arrayBuffer();
        },
        async text({ signal } = {}) {
          return (await read(start, end, signal)).text();
        },
      };
    },
  };
}

export async function setupServerBrowser({
  importEntries,
  importFiles,
  notice,
  extractFastfile,
}) {
  const $ = (id) => document.getElementById(id);
  let capabilities;
  try {
    const response = await fetch(new URL("./api/roots", document.baseURI), {
      credentials: "same-origin",
    });
    if (!response.ok) return;
    capabilities = await response.json();
  } catch {
    return;
  }
  if (!capabilities.roots?.length) return;
  document
    .querySelectorAll(".server-option")
    .forEach((node) => node.classList.remove("hidden"));
  $("server-root").replaceChildren(
    ...capabilities.roots.map((root) => new Option(root.label, root.id)),
  );
  let path = "",
    entries = [],
    checked = new Set(),
    root,
    request,
    busy = false;
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const updateSelection = () => {
    $("server-open-selected").disabled = !checked.size || busy;
    $("server-open-selected").textContent =
      `Open selected${checked.size ? ` (${checked.size})` : ""}`;
  };
  async function list(nextPath = "") {
    request?.abort();
    request = new AbortController();
    const signal = request.signal;
    root = capabilities.roots.find((r) => r.id === $("server-root").value);
    path = nextPath;
    checked.clear();
    updateSelection();
    $("server-path").textContent = `${root.label} / ${path}`;
    $("server-up").disabled = !path;
    $("server-message").textContent = "Reading directory…";
    $("server-files").replaceChildren();
    const url = new URL("./api/list", document.baseURI);
    url.searchParams.set("root", root.id);
    url.searchParams.set("path", path);
    try {
      const response = await fetch(url, { signal, credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Cannot read directory.");
      if (signal.aborted) return;
      entries = data.entries;
      $("server-files").replaceChildren(
        ...entries.map((entry) => {
          if (entry.directory) {
            const b = node("button", "server-entry");
            b.append(
              node("span", "", "▱"),
              node("span", "entry-name", entry.name),
              node("small", "", "Open →"),
            );
            b.onclick = () => list(entry.path);
            return b;
          }
          const row = node("label", "server-entry"),
            input = document.createElement("input");
          input.type = "checkbox";
          input.setAttribute("aria-label", `Select ${entry.name}`);
          input.onchange = () => {
            if (input.checked) checked.add(entry.path);
            else checked.delete(entry.path);
            updateSelection();
          };
          row.append(
            input,
            node("span", "entry-name", entry.name),
            node("small", "", formatBytes(entry.size)),
          );
          return row;
        }),
      );
      $("server-message").textContent = entries.length
        ? `${entries.length} entries. Select a .ff to extract and open it automatically.`
        : "This folder is empty.";
    } catch (error) {
      if (!signal.aborted) $("server-message").textContent = error.message;
    }
  }
  const open = () => {
    $("import-dialog").close();
    $("server-dialog").showModal();
    list(path);
  };
  $("server-button").onclick = $("dialog-server").onclick = open;
  $("server-root").onchange = () => list("");
  $("server-up").onclick = () => list(path.split("/").slice(0, -1).join("/"));
  async function importServer(all) {
    if (busy) return;
    busy = true;
    updateSelection();
    $("server-open-folder").disabled = true;
    const chosenRoot = root;
    try {
      let chosen;
      if (all) {
        $("server-message").textContent =
          "Indexing this folder. Asset bytes load only when needed.";
        const url = new URL("./api/tree", document.baseURI);
        url.searchParams.set("root", root.id);
        url.searchParams.set("path", path);
        const response = await fetch(url, { credentials: "same-origin" });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Cannot index directory.");
        chosen = data.entries;
      } else chosen = entries.filter((e) => checked.has(e.path));
      if (!chosen.length) throw new Error("No files in this selection.");
      const local = chosen.map((entry) => ({
        path: safePath(`${chosenRoot.id}/${entry.path}`),
        file: remoteFile(entry, chosenRoot),
      }));
      $("server-dialog").close();
      const archives = all
        ? []
        : local.filter((e) => e.file.name.toLowerCase().endsWith(".zip"));
      const ordinary = all
        ? local
        : local.filter((e) => !/\.(zip|ff)$/i.test(e.file.name));
      const fastfiles = all
        ? []
        : local.filter((e) => /\.ff$/i.test(e.file.name));
      if (archives.some((e) => e.file.size > MAX_ZIP_BYTES))
        throw new Error(
          "Selected ZIP exceeds 512 MB. Open the extracted folder instead.",
        );
      if (ordinary.length)
        await importEntries(ordinary, "Server collection opened");
      for (const entry of archives) {
        const blob = await entry.file.blob();
        await importFiles([new File([blob], entry.file.name)]);
      }
      for (const entry of fastfiles) {
        const result = await extractFastfile(entry.file);
        await importEntries(result.entries, `Extracted ${result.job.name}`);
      }
    } catch (error) {
      $("server-message").textContent = error.message;
      notice(error.message, true);
    } finally {
      busy = false;
      $("server-open-folder").disabled = false;
      updateSelection();
    }
  }
  $("server-open-folder").onclick = () => importServer(true);
  $("server-open-selected").onclick = () => importServer(false);
}
