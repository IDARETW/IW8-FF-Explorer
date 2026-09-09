import { parseDDS } from "./dds.js";
// Reuse WASM decoders across textures; at most two decodes run simultaneously.
const slots = Array.from({ length: 2 }, () => ({ worker: null, job: null }));
const queue = [];
export function decodeDDS(buffer, selected, signal, payload, fileBytes) {
  return new Promise((resolve, reject) => {
    const job = {
      buffer,
      selected,
      signal,
      resolve,
      reject,
      payload,
      fileBytes,
    };
    job.abort = () => {
      const slot = slots.find((s) => s.job === job);
      if (slot) {
        slot.worker.terminate();
        slot.worker = null;
        finish(slot, new DOMException("Preview cancelled", "AbortError"));
      } else {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        reject(new DOMException("Preview cancelled", "AbortError"));
      }
    };
    if (signal?.aborted) return job.abort();
    signal?.addEventListener("abort", job.abort, { once: true });
    queue.push(job);
    pump();
  });
}
function finish(slot, error, result) {
  const job = slot.job;
  if (!job) return;
  clearTimeout(job.timer);
  job.signal?.removeEventListener("abort", job.abort);
  slot.job = null;
  error ? job.reject(error) : job.resolve(result);
  pump();
}
function pump() {
  for (const slot of slots) {
    if (slot.job || !queue.length) continue;
    const job = (slot.job = queue.shift());
    slot.worker ||= new Worker(new URL("./dds.worker.js", import.meta.url), {
      type: "module",
    });
    slot.worker.onmessage = ({ data }) =>
      finish(slot, data.error ? new Error(data.error) : null, data);
    slot.worker.onerror = () => {
      slot.worker.terminate();
      slot.worker = null;
      finish(slot, new Error("DDS decoder failed."));
    };
    job.timer = setTimeout(() => {
      slot.worker.terminate();
      slot.worker = null;
      finish(
        slot,
        new Error("DDS preview exceeded the 30 second decode limit."),
      );
    }, 30000);
    slot.worker.postMessage(
      {
        buffer: job.buffer,
        selected: job.selected,
        payload: job.payload,
        fileBytes: job.fileBytes,
        wasmPath: new URL("./wasm", document.baseURI).href,
      },
      job.payload ? [job.buffer, job.payload] : [job.buffer],
    );
    job.buffer = job.payload = null;
  }
}

// Transfer only the chosen mip/face/layer, retaining the full-file bounds checks.
// Small DDS files use one request; large textures avoid downloading unused mips.
export async function readDDS(file, selection, signal) {
  const small = file.size <= 256 * 1024;
  const buffer = await (small ? file : file.slice(0, 148)).arrayBuffer({
    signal,
  });
  if (signal?.aborted)
    throw new DOMException("Preview cancelled", "AbortError");
  const selected =
    typeof selection === "function" ? selection(buffer) : selection;
  const info = parseDDS(buffer, selected, file.size);
  if (small) return decodeDDS(buffer, selected, signal);
  const payload = await file
    .slice(info.offset, info.offset + info.length)
    .arrayBuffer({ signal });
  return decodeDDS(buffer, selected, signal, payload, file.size);
}
