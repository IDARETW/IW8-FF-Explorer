import { mapConcurrent } from "./scheduling.js";
import { remoteFile } from "./server-files.js";
import { formatBytes } from "./library.js";

let capabilities;
let capabilityRequest;
let panelOwner;
const $ = (id) => document.getElementById(id);
const terminal = new Set(["complete", "partial", "failed", "cancelled"]);

export async function getCapabilities() {
  capabilityRequest ||= fetch(new URL("./api/roots", document.baseURI), {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) => (response.ok ? response.json() : null))
    .catch(() => null);
  capabilities = await capabilityRequest;
  return capabilities;
}

async function api(path, data, raw = false) {
  const config = await getCapabilities();
  if (!config?.extraction)
    throw new Error(
      "Automatic fastfile extraction needs the authenticated ACTS server. Open this viewer through your PC test link.",
    );
  const response = await fetch(new URL(`./api/${path}`, document.baseURI), {
    method: data === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      data === undefined
        ? {}
        : {
            "X-Zone-Token": config.csrf,
            "Content-Type": raw
              ? "application/octet-stream"
              : "application/json",
          },
    body: data === undefined ? undefined : raw ? data : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error || `Extraction request failed (${response.status}).`,
    );
  return result;
}

export async function extractionEntries(id) {
  const first = await api(`extractions/${id}/entries?offset=0`);
  const pages = [first];
  if (first.next !== null && Number.isInteger(first.total)) {
    const offsets = [];
    for (
      let offset = first.next;
      offset < first.total;
      offset += first.entries.length
    )
      offsets.push(offset);
    pages.push(
      ...(await mapConcurrent(offsets, 3, (offset) =>
        api(`extractions/${id}/entries?offset=${offset}`),
      )),
    );
  } else {
    let offset = first.next;
    while (offset !== null) {
      const result = await api(`extractions/${id}/entries?offset=${offset}`);
      pages.push(result);
      offset = result.next;
    }
  }
  return pages.flatMap((result) =>
    result.entries.map((entry) => ({
      path: `${result.root.id}/${entry.path}`,
      file: remoteFile(entry, result.root),
    })),
  );
}

function showJob(job) {
  if (panelOwner !== job.id) return;
  $("extraction-title").textContent = job.name;
  $("extraction-state").textContent = job.cached
    ? "Opening cached extraction"
    : job.status;
  $("extraction-state").dataset.status = job.status;
  $("extraction-message").textContent =
    job.error || job.message || "Starting ACTS";
  $("extraction-log").textContent = job.log || "Waiting for ACTS output…";
  const p = job.progress || {};
  $("extraction-counts").textContent =
    `${(p.loaded_assets || 0).toLocaleString()} assets loaded · ${(p.tested || 0).toLocaleString()} exported · ${formatBytes(job.output_bytes || 0)} on disk`;
  const progress = $("extraction-progress");
  if (terminal.has(job.status))
    progress.value = job.status === "complete" ? 100 : 0;
  else progress.removeAttribute("value");
  $("extraction-cancel").hidden = terminal.has(job.status);
  $("extraction-open").hidden = !terminal.has(job.status) || !job.files;
}

export async function extractFastfile(file) {
  let cancelled = false,
    upload,
    job;
  const dialog = $("extraction-dialog");
  const initialOwner = Symbol("upload");
  panelOwner = initialOwner;
  if (!dialog.open) dialog.showModal();
  $("extraction-title").textContent = file.name;
  $("extraction-state").textContent = file.server
    ? "Preparing extraction"
    : "Uploading fastfile";
  $("extraction-message").textContent = file.server
    ? "ACTS will read this fastfile on the game PC."
    : "The fastfile is sent to your PC in small chunks, then extracted by ACTS.";
  $("extraction-counts").textContent = "";
  $("extraction-log").textContent = "";
  $("extraction-open").hidden = true;
  $("extraction-cancel").hidden = false;
  $("extraction-progress").removeAttribute("value");
  $("extraction-cancel").onclick = async () => {
    cancelled = true;
    try {
      if (job && !terminal.has(job.status))
        showJob(await api(`extractions/${job.id}/cancel`, {}));
      if (upload) await api(`uploads/${upload.id}/cancel`, {});
    } catch (error) {
      $("extraction-message").textContent = error.message;
    }
  };
  try {
    if (file.server) job = await api("extractions", file.server);
    else {
      upload = await api("uploads", { name: file.name, size: file.size });
      for (let offset = 0; offset < file.size;) {
        if (cancelled) throw new Error("Fastfile upload cancelled.");
        const chunk = file.slice(offset, offset + upload.chunk_bytes);
        const result = await api(
          `uploads/${upload.id}/chunk?offset=${offset}`,
          chunk,
          true,
        );
        offset = result.offset;
        $("extraction-progress").value = (offset / file.size) * 100;
        $("extraction-counts").textContent =
          `${formatBytes(offset)} / ${formatBytes(file.size)} uploaded`;
      }
      if (cancelled) throw new Error("Fastfile upload cancelled.");
      job = await api(`uploads/${upload.id}/finish`, {});
      upload = null;
    }
    if (panelOwner === initialOwner) panelOwner = job.id;
    // Closing the progress panel does not stop the job. Reopen it from Extractions.
    while (!terminal.has(job.status)) {
      if (cancelled) {
        await api(`extractions/${job.id}/cancel`, {});
        throw new Error(
          "Extraction cancelled. Partial output remains in the cache.",
        );
      }
      showJob(job);
      await new Promise((resolve) => setTimeout(resolve, 750));
      job = await api(`extractions/${job.id}`);
    }
    showJob(job);
    if (job.status === "complete") {
      const entries = await extractionEntries(job.id);
      if (panelOwner === job.id) dialog.close();
      return { entries, job };
    }
    if (job.files && panelOwner === job.id) {
      $("extraction-open").onclick = async () => {
        const entries = await extractionEntries(job.id);
        dialog.close();
        window.dispatchEvent(
          new CustomEvent("zone-extraction-open", { detail: { entries, job } }),
        );
      };
    }
    throw new Error(
      job.error || job.message || "ACTS could not extract this fastfile.",
    );
  } catch (error) {
    if (upload) {
      try {
        await api(`uploads/${upload.id}/cancel`, {});
      } catch {}
    }
    if (panelOwner === initialOwner || panelOwner === job?.id) {
      $("extraction-message").textContent = error.message;
      $("extraction-state").textContent = cancelled
        ? "cancelled"
        : job?.status || "failed";
      $("extraction-state").dataset.status = cancelled
        ? "cancelled"
        : job?.status || "failed";
      $("extraction-progress").value = 0;
      $("extraction-cancel").hidden = true;
    }
    throw error;
  }
}

export async function setupExtractionHistory() {
  const config = await getCapabilities();
  if (!config?.extraction) return;
  document
    .querySelectorAll(".extraction-option")
    .forEach((el) => el.classList.remove("hidden"));
  $("extractions-button").onclick = async () => {
    $("jobs-dialog").showModal();
    const list = $("job-list");
    list.textContent = "Loading extraction history…";
    try {
      const { jobs } = await api("extractions");
      list.replaceChildren(
        ...jobs.map((job) => {
          const row = document.createElement("button");
          row.className = "job-row";
          const name = document.createElement("strong");
          name.textContent = job.name;
          const state = document.createElement("span");
          state.textContent = `${job.status} · ${job.files || 0} files · ${formatBytes(job.output_bytes || 0)}`;
          row.append(name, state);
          row.onclick = async () => {
            try {
              $("jobs-dialog").close();
              if (job.status === "complete" && job.files) {
                window.dispatchEvent(
                  new CustomEvent("zone-extraction-status", {
                    detail: `Opening ${job.name}…`,
                  }),
                );
                const entries = await extractionEntries(job.id);
                window.dispatchEvent(
                  new CustomEvent("zone-extraction-open", {
                    detail: { entries, job },
                  }),
                );
              } else {
                const dialog = $("extraction-dialog");
                panelOwner = job.id;
                if (!dialog.open) dialog.showModal();
                $("extraction-cancel").onclick = async () =>
                  showJob(await api(`extractions/${job.id}/cancel`, {}));
                let current;
                do {
                  current = await api(`extractions/${job.id}`);
                  showJob(current);
                  if (terminal.has(current.status)) break;
                  await new Promise((resolve) => setTimeout(resolve, 750));
                } while (panelOwner === job.id && dialog.open);
                if (
                  panelOwner === job.id &&
                  terminal.has(current.status) &&
                  current.files
                ) {
                  $("extraction-open").onclick = async () => {
                    try {
                      const entries = await extractionEntries(job.id);
                      dialog.close();
                      window.dispatchEvent(
                        new CustomEvent("zone-extraction-open", {
                          detail: { entries, job: current },
                        }),
                      );
                    } catch (error) {
                      $("extraction-message").textContent = error.message;
                    }
                  };
                }
              }
            } catch (error) {
              list.textContent = error.message;
              if (!$("extraction-dialog").open) $("jobs-dialog").showModal();
              if ($("extraction-dialog").open)
                $("extraction-message").textContent = error.message;
            }
          };
          return row;
        }),
      );
      if (!jobs.length)
        list.textContent =
          "No extractions yet. Select a .ff file to start one.";
    } catch (error) {
      list.textContent = error.message;
    }
  };
}
