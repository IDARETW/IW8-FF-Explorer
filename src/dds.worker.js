import { parseDDS, decodePixels } from "./dds.js";
let decoder;
self.onmessage = async ({
  data: { buffer, selected, wasmPath, payload, fileBytes },
}) => {
  try {
    const info = parseDDS(buffer, selected, fileBytes);
    if (payload && payload.byteLength !== info.length)
      throw new Error("DDS subresource is truncated.");
    const bytes = payload
      ? new Uint8Array(payload)
      : new Uint8Array(buffer, info.offset, info.length);
    let rgba;
    if (!info.compressed) rgba = decodePixels(bytes, info);
    else {
      decoder ||= await (
        await import(/* @vite-ignore */ `${wasmPath}/texture2ddecoder.js`)
      ).default();
      let bgra;
      if (info.decoder === "bc2") {
        // BC3 forces four-color interpolation, as BC2 requires even if c0 <= c1.
        const blocks = bytes.length / 16,
          colors = new Uint8Array(bytes.length);
        for (let b = 0; b < blocks; b++) {
          colors[b * 16] = colors[b * 16 + 1] = 255;
          colors.set(bytes.subarray(b * 16 + 8, b * 16 + 16), b * 16 + 8);
        }
        bgra = new Uint8Array(
          decoder.decode_bc3(colors, info.width, info.height),
        );
        const across = Math.ceil(info.width / 4);
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++) {
            const b = Math.floor(y / 4) * across + Math.floor(x / 4),
              pixel = (y % 4) * 4 + (x % 4);
            bgra[(y * info.width + x) * 4 + 3] =
              ((bytes[b * 16 + (pixel >> 1)] >> ((pixel & 1) * 4)) & 15) * 17;
          }
      } else
        bgra = new Uint8Array(
          decoder[`decode_${info.decoder}`](bytes, info.width, info.height),
        );
      if (bgra.length !== info.width * info.height * 4)
        throw new Error(
          "Texture decoder did not return the expected pixel count.",
        );
      rgba = new Uint8ClampedArray(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2];
        rgba[i + 1] = bgra[i + 1];
        rgba[i + 2] = bgra[i];
        rgba[i + 3] = bgra[i + 3];
      }
    }
    self.postMessage({ info, pixels: rgba.buffer }, [rgba.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
