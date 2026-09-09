import { strFromU8 } from "fflate";
import {
  safePath,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_ZIP_BYTES,
} from "./library.js";

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let n = value;
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n;
});
export function crcUpdate(crc, data) {
  for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return crc >>> 0;
}

export function zipDirectory(buffer) {
  const d = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  let end = -1;
  for (
    let at = d.byteLength - 22;
    at >= Math.max(0, d.byteLength - 65557);
    at--
  ) {
    if (
      d.getUint32(at, true) === 0x06054b50 &&
      at + 22 + d.getUint16(at + 20, true) === d.byteLength
    ) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP is incomplete: end directory is missing.");
  const count = d.getUint16(end + 10, true),
    size = d.getUint32(end + 12, true),
    start = d.getUint32(end + 16, true);
  if (
    d.getUint32(end + 4, true) ||
    d.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    start === 0xffffffff ||
    size === 0xffffffff
  )
    throw new Error(
      "Split and ZIP64 archives are not supported. Import the extracted folder.",
    );
  if (count > MAX_FILES || start + size !== end)
    throw new Error("Invalid ZIP directory or too many files.");
  let at = start,
    total = 0;
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || d.getUint32(at, true) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry.");
    const flags = d.getUint16(at + 8, true),
      method = d.getUint16(at + 10, true);
    const crc = d.getUint32(at + 16, true),
      compressed = d.getUint32(at + 20, true),
      expanded = d.getUint32(at + 24, true);
    const nameSize = d.getUint16(at + 28, true),
      extra = d.getUint16(at + 30, true),
      comment = d.getUint16(at + 32, true),
      local = d.getUint32(at + 42, true);
    if (
      at + 46 + nameSize + extra + comment > end ||
      local + 30 > start ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff
    )
      throw new Error("Truncated or ZIP64 entry. Import the extracted folder.");
    if (flags & 1 || ![0, 8].includes(method))
      throw new Error(
        "Encrypted or unsupported ZIP compression. Use a normal ZIP or folder.",
      );
    const name = strFromU8(
      bytes.subarray(at + 46, at + 46 + nameSize),
      !(flags & 2048),
    );
    if (!name.endsWith("/")) {
      const path = safePath(name);
      if (entries.has(path)) throw new Error(`Duplicate ZIP path: ${path}`);
      if (expanded > MAX_FILE_BYTES || (total += expanded) > MAX_ZIP_BYTES)
        throw new Error(
          "Expanded ZIP exceeds the 256 MB file or 512 MB collection limit.",
        );
      entries.set(path, { crc, size: expanded });
    }
    at += 46 + nameSize + extra + comment;
  }
  if (at !== end || !entries.size)
    throw new Error("ZIP directory is empty or inconsistent.");
  return entries;
}
