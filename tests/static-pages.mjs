import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import { zipSync } from "fflate";
import { materialFixture } from "./material-fixture.mjs";

const root = resolve("dist");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/repo/")) throw Error("outside test subpath");
    const path = resolve(
      root,
      decodeURIComponent(url.pathname.slice(6)) || "index.html",
    );
    if (!path.startsWith(root + sep)) throw Error("outside static root");
    const body = await readFile(path);
    res.setHeader(
      "Content-Type",
      {
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".css": "text/css",
        ".html": "text/html",
      }[extname(path)] || "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  for (const withIndex of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/repo/`);
    await expect(page.locator("#server-button")).toBeHidden();
    await expect(page.locator("#extractions-button")).toBeHidden();
    await page.locator("#file-input").setInputFiles({
      name: "portable.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync(materialFixture(withIndex))),
    });
    await expect(page.locator("canvas.model-canvas")).toBeVisible();
    await expect(page.locator(".model-texture-status")).toHaveText(
      "2 / 2 surfaces textured",
    );
    await page.screenshot({
      path: `.local/static-textured-${withIndex ? "indexed" : "json"}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await page.close();
  }
  console.log(
    "Static GitHub Pages subpath: textured model ZIP with ACTS JSON and material index both passed; PC APIs disabled.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
