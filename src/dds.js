const blocks = new Map([
  [71, ["BC1", 8, "bc1"]],
  [72, ["BC1 sRGB", 8, "bc1"]],
  [74, ["BC2", 16, "bc2"]],
  [75, ["BC2 sRGB", 16, "bc2"]],
  [77, ["BC3", 16, "bc3"]],
  [78, ["BC3 sRGB", 16, "bc3"]],
  [80, ["BC4", 8, "bc4"]],
  [83, ["BC5", 16, "bc5"]],
  [95, ["BC6H", 16, "bc6"]],
  [98, ["BC7", 16, "bc7"]],
  [99, ["BC7 sRGB", 16, "bc7"]],
]);
const pixels = new Map([
  [28, ["RGBA8", 4, "rgba"]],
  [29, ["RGBA8 sRGB", 4, "rgba"]],
  [87, ["BGRA8", 4, "bgra"]],
  [91, ["BGRA8 sRGB", 4, "bgra"]],
  [88, ["BGRX8", 4, "bgrx"]],
  [93, ["BGRX8 sRGB", 4, "bgrx"]],
  [61, ["R8", 1, "r8"]],
  [49, ["RG8", 2, "rg8"]],
  [65, ["A8", 1, "a8"]],
  [56, ["R16 UNORM", 2, "r16"]],
  [35, ["RG16 UNORM", 4, "rg16"]],
  [11, ["RGBA16 UNORM", 8, "rgba16"]],
  [54, ["R16 FLOAT", 2, "r16f"]],
  [34, ["RG16 FLOAT", 4, "rg16f"]],
  [10, ["RGBA16 FLOAT", 8, "rgba16f"]],
  [41, ["R32 FLOAT", 4, "r32f"]],
  [16, ["RG32 FLOAT", 8, "rg32f"]],
  [2, ["RGBA32 FLOAT", 16, "rgba32f"]],
  [24, ["RGB10A2", 4, "rgb10a2"]],
  [85, ["B5G6R5", 2, "565"]],
  [86, ["B5G5R5A1", 2, "5551"]],
]);

export function parseDDS(buffer, selected = {}, fileBytes = buffer.byteLength) {
  const d = new DataView(buffer);
  if (
    d.byteLength < 128 ||
    d.getUint32(0, true) !== 0x20534444 ||
    d.getUint32(4, true) !== 124 ||
    d.getUint32(76, true) !== 32
  )
    throw new Error("Invalid DDS header.");
  const width = d.getUint32(16, true),
    height = d.getUint32(12, true),
    depth = Math.max(1, d.getUint32(24, true));
  const mips = Math.max(1, d.getUint32(28, true));
  if (
    !width ||
    !height ||
    width > 32768 ||
    height > 32768 ||
    depth > 2048 ||
    mips > 16
  )
    throw new Error("DDS dimensions exceed preview limits.");
  const fourcc = d.getUint32(84, true);
  let format,
    offset = 128,
    faces = 1,
    layers = 1,
    volume = false;
  if (fourcc === 0x30315844) {
    if (d.byteLength < 148) throw new Error("Truncated DX10 header.");
    format = d.getUint32(128, true);
    offset = 148;
    faces = d.getUint32(136, true) & 4 ? 6 : 1;
    layers = d.getUint32(140, true);
    volume = d.getUint32(132, true) === 4;
    if (!layers || layers > 2048) throw new Error("Invalid DDS array size.");
  } else {
    const legacy = {
      0x31545844: 71,
      0x33545844: 74,
      0x35545844: 77,
      0x31495441: 80,
      0x32495441: 83,
      0x55344342: 80,
      0x55354342: 83,
    };
    format = legacy[fourcc];
    if (!fourcc && d.getUint32(88, true) === 32) {
      const r = d.getUint32(92, true),
        g = d.getUint32(96, true),
        b = d.getUint32(100, true),
        a = d.getUint32(104, true);
      if (g === 0xff00 && b === 0xff0000 && r === 0xff && a === 0xff000000)
        format = 28;
      if (
        g === 0xff00 &&
        b === 0xff &&
        r === 0xff0000 &&
        [0, 0xff000000].includes(a)
      )
        format = a ? 87 : 88;
    }
    const caps = d.getUint32(112, true);
    if (caps & 0x200 && (caps & 0xfc00) !== 0xfc00)
      throw new Error("Incomplete legacy cubemap.");
    faces = caps & 0x200 ? 6 : 1;
    volume = !!(caps & 0x200000);
  }
  const compressed = blocks.has(format),
    spec = blocks.get(format) || pixels.get(format);
  if (!spec)
    throw new Error(
      `DDS DXGI format ${format ?? "unknown"} has no visual decoder yet. The original file is still available.`,
    );
  const mip = Number(selected.mip || 0),
    face = Number(selected.face || 0),
    layer = Number(selected.layer || 0),
    slice = Number(selected.slice || 0);
  if (
    ![mip, face, layer, slice].every(Number.isInteger) ||
    mip < 0 ||
    mip >= mips ||
    face < 0 ||
    face >= faces ||
    layer < 0 ||
    layer >= layers ||
    slice < 0 ||
    slice >= (volume ? Math.max(1, depth >> mip) : 1)
  )
    throw new Error("Invalid DDS subresource.");
  const levelSize = (i) => {
    const w = Math.max(1, width >> i),
      h = Math.max(1, height >> i);
    return (compressed ? Math.ceil(w / 4) * Math.ceil(h / 4) : w * h) * spec[1];
  };
  let chain = 0;
  for (let i = 0; i < mips; i++)
    chain += levelSize(i) * (volume ? Math.max(1, depth >> i) : 1);
  if (
    !Number.isSafeInteger(chain * faces * layers) ||
    !Number.isSafeInteger(fileBytes) ||
    fileBytes < buffer.byteLength ||
    offset + chain * faces * layers > fileBytes
  )
    throw new Error("DDS pixel data is truncated.");
  offset += (layer * faces + face) * chain;
  for (let i = 0; i < mip; i++)
    offset += levelSize(i) * (volume ? Math.max(1, depth >> i) : 1);
  offset += slice * levelSize(mip);
  const w = Math.max(1, width >> mip),
    h = Math.max(1, height >> mip);
  if (w * h > 16 * 1024 * 1024)
    throw new Error(
      "This mip exceeds 16 million preview pixels. Select a smaller mip.",
    );
  return {
    width: w,
    height: h,
    originalWidth: width,
    originalHeight: height,
    mips,
    faces,
    layers,
    depth: volume ? Math.max(1, depth >> mip) : 1,
    format: spec[0],
    decoder: spec[2],
    stride: spec[1],
    compressed,
    offset,
    length: levelSize(mip),
    mip,
    face,
    layer,
    slice,
  };
}

function half(n) {
  const sign = n & 0x8000 ? -1 : 1,
    e = (n >> 10) & 31,
    f = n & 1023;
  return (
    sign *
    (e === 0
      ? (2 ** -14 * f) / 1024
      : e === 31
        ? f
          ? NaN
          : Infinity
        : 2 ** (e - 15) * (1 + f / 1024))
  );
}

export function decodePixels(bytes, info) {
  const out = new Uint8ClampedArray(info.width * info.height * 4),
    d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = info.decoder;
  for (let i = 0, p = 0; i < out.length; i += 4, p += info.stride) {
    let c;
    if (["rgba", "bgra", "bgrx"].includes(kind))
      c =
        kind === "rgba"
          ? [bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]
          : [
              bytes[p + 2],
              bytes[p + 1],
              bytes[p],
              kind === "bgrx" ? 255 : bytes[p + 3],
            ];
    else if (kind === "r8") c = [bytes[p], bytes[p], bytes[p], 255];
    else if (kind === "rg8") c = [bytes[p], bytes[p + 1], 0, 255];
    else if (kind === "a8") c = [255, 255, 255, bytes[p]];
    else if (kind === "rgb10a2") {
      const n = d.getUint32(p, true);
      c = [
        ((n & 1023) * 255) / 1023,
        (((n >>> 10) & 1023) * 255) / 1023,
        (((n >>> 20) & 1023) * 255) / 1023,
        (n >>> 30) * 85,
      ];
    } else if (kind === "565" || kind === "5551") {
      const n = d.getUint16(p, true);
      c =
        kind === "565"
          ? [
              ((n >> 11) * 255) / 31,
              (((n >> 5) & 63) * 255) / 63,
              ((n & 31) * 255) / 31,
              255,
            ]
          : [
              (((n >> 10) & 31) * 255) / 31,
              (((n >> 5) & 31) * 255) / 31,
              ((n & 31) * 255) / 31,
              (n >> 15) * 255,
            ];
    } else {
      const channels = kind.startsWith("rgba")
        ? 4
        : kind.startsWith("rg")
          ? 2
          : 1;
      const step = kind.includes("32") ? 4 : 2;
      c = [0, 0, 0, 255];
      for (let k = 0; k < channels; k++) {
        const v =
          step === 4
            ? d.getFloat32(p + k * step, true)
            : kind.endsWith("f")
              ? half(d.getUint16(p + k * step, true))
              : d.getUint16(p + k * step, true) / 65535;
        c[k] = Number.isNaN(v) ? 0 : Math.max(0, Math.min(1, v)) * 255;
      }
      if (channels === 1) c[1] = c[2] = c[0];
    }
    out.set(c, i);
  }
  return out;
}
