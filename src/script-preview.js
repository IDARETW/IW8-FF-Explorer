import { getCapabilities } from "./extractions.js";

export { gscTokens } from "./gsc-tokens.js";
import { yieldToUI } from "./scheduling.js";

export function highlightedGSC(source, signal) {
  const pre = document.createElement("pre");
  pre.className = "text-preview gsc-source";
  const code = document.createElement("code");
  code.setAttribute("aria-label", "GSC source");
  code.textContent = source;
  pre.append(code);
  // Show readable text immediately; tokenize off-thread and build markup in batches.
  const worker = new Worker(new URL("./gsc.worker.js", import.meta.url), {
    type: "module",
  });
  const stop = () => {
    worker.terminate();
    signal?.removeEventListener("abort", stop);
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) {
    stop();
    return pre;
  }
  worker.onerror = stop;
  worker.onmessage = async ({ data: tokens }) => {
    worker.terminate();
    const fragment = document.createDocumentFragment();
    let block = document.createElement("span"),
      lines = 0;
    block.className = "gsc-chunk";
    for (const [i, token] of tokens.entries()) {
      for (const text of token.text.match(/[^\n]*\n|[^\n]+$/g) || []) {
        if (!token.kind) block.append(document.createTextNode(text));
        else {
          const span = document.createElement("span");
          span.className = `gsc-${token.kind}`;
          span.textContent = text;
          block.append(span);
        }
        if (text.endsWith("\n") && ++lines >= 100) {
          fragment.append(block);
          block = document.createElement("span");
          block.className = "gsc-chunk";
          lines = 0;
        }
      }
      if (i % 300 === 0) {
        await yieldToUI();
        if (signal?.aborted) {
          stop();
          return;
        }
      }
    }
    fragment.append(block);
    if (!signal?.aborted) code.replaceChildren(fragment);
    stop();
  };
  worker.postMessage(source);
  return pre;
}

export async function decompileScript(asset, signal) {
  if (asset.size > 8 * 1024 ** 2)
    throw new Error("Compiled script exceeds the 8 MB preview limit.");
  const config = await getCapabilities();
  if (!config?.extraction)
    throw new Error(
      "Compiled GSC previews need the authenticated ACTS server. Portable decompiled .gsc files can be viewed here directly.",
    );
  const body = await asset.file.arrayBuffer({ signal });
  const response = await fetch(new URL("./api/decompile", document.baseURI), {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      "X-Zone-Token": config.csrf,
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Script decompilation failed.");
  return result;
}
