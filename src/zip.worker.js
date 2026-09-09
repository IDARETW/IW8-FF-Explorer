import { Unzip, UnzipInflate } from "fflate";
import {
  safePath,
  MAX_FILES,
  MAX_ZIP_BYTES,
  MAX_FILE_BYTES,
} from "./library.js";
import { crcUpdate, zipDirectory } from "./zip.js";

self.onmessage = async ({ data: file }) => {
  try {
    if (file.size > MAX_ZIP_BYTES)
      throw new Error(
        "ZIP exceeds the 512 MB import limit. Import a folder instead.",
      );
    const source = await file.arrayBuffer(),
      directory = zipDirectory(source);
    let total = 0,
      count = 0,
      finished = 0;
    const files = [],
      names = new Set();
    const unzip = new Unzip((entry) => {
      if (entry.name.endsWith("/")) return;
      const path = safePath(entry.name);
      const expected = directory.get(path);
      if (!expected)
        throw new Error("ZIP local entry is missing from its directory.");
      if (++count > MAX_FILES)
        throw new Error("ZIP contains more than 20,000 files.");
      if (names.has(path)) throw new Error(`Duplicate ZIP path: ${path}`);
      names.add(path);
      let size = 0,
        crc = 0xffffffff;
      const chunks = [];
      entry.ondata = (error, chunk, final) => {
        if (error) throw error;
        size += chunk.length;
        total += chunk.length;
        crc = crcUpdate(crc, chunk);
        if (size > MAX_FILE_BYTES || total > MAX_ZIP_BYTES)
          throw new Error(
            "Expanded ZIP exceeds the 256 MB file or 512 MB collection limit.",
          );
        chunks.push(chunk);
        if (final) {
          if (
            size !== expected.size ||
            (crc ^ 0xffffffff) >>> 0 !== expected.crc
          )
            throw new Error(`ZIP checksum or size mismatch: ${path}`);
          files.push({ path, file: new File(chunks, path.split("/").at(-1)) });
          finished++;
        }
      };
      if (entry.originalSize > MAX_FILE_BYTES)
        throw new Error("ZIP entry exceeds 256 MB.");
      entry.start();
    });
    unzip.register(UnzipInflate);
    // Small chunks bound synchronous inflate expansion before its size check.
    for (let offset = 0; offset < file.size; offset += 4096) {
      unzip.push(
        new Uint8Array(
          source,
          offset,
          Math.min(4096, source.byteLength - offset),
        ),
        offset + 4096 >= file.size,
      );
      if (offset % (512 * 1024) === 0)
        self.postMessage({ progress: Math.round((100 * offset) / file.size) });
    }
    if (!count || finished !== count || finished !== directory.size)
      throw new Error("ZIP is empty or incomplete.");
    self.postMessage({ files });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
