import { mkdir, copyFile } from "node:fs/promises";
await mkdir("public/wasm", { recursive: true });
await copyFile(
  "node_modules/texture2ddecoder-wasm/wasm/texture2ddecoder.wasm",
  "public/wasm/texture2ddecoder.wasm",
);
await copyFile(
  "node_modules/texture2ddecoder-wasm/wasm/texture2ddecoder.js",
  "public/wasm/texture2ddecoder.js",
);
await copyFile(
  "node_modules/texture2ddecoder-wasm/LICENSE",
  "public/wasm/LICENSE.txt",
);
await mkdir("public/licenses", { recursive: true });
for (const [name, license] of [
  ["three", "LICENSE"],
  ["fflate", "LICENSE"],
  ["texture2ddecoder-wasm", "LICENSE"],
]) {
  await copyFile(
    `node_modules/${name}/${license}`,
    `public/licenses/${name}.txt`,
  );
}
