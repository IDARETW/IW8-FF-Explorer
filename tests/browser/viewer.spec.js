import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { materialFixture } from "../material-fixture.mjs";

const md5 = (text) => createHash("md5").update(text).digest("hex");
test.beforeEach(async ({ context, baseURL }) => {
  if (!process.env.VIEWER_ACCESS_FILE)
    throw new Error(
      "Set VIEWER_ACCESS_FILE to the existing workbench access JSON.",
    );
  const auth = JSON.parse(
    readFileSync(process.env.VIEWER_ACCESS_FILE, "utf8").replace(/^\uFEFF/, ""),
  );
  const challenge = await context.request.get(baseURL);
  expect(challenge.status()).toBe(401);
  const nonce = challenge
    .headers()
    ["www-authenticate"].match(/nonce="([^"]+)"/)[1];
  const cnonce = randomBytes(16).toString("hex");
  let count = 0;
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== new URL(baseURL).origin) return route.abort();
    const nc = (++count).toString(16).padStart(8, "0"),
      uri = url.pathname + url.search;
    const response = md5(
      `${auth.digest_ha1}:${nonce}:${nc}:${cnonce}:auth:${md5(`${request.method()}:${uri}`)}`,
    );
    await route.continue({
      headers: {
        ...request.headers(),
        Authorization: `Digest username="${auth.username}", realm="MW164 Label Workbench", nonce="${nonce}", uri="${uri}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`,
      },
    });
  });
});

test("large cached collection navigation timing", async ({page}, testInfo) => {
  test.skip(!process.env.VIEWER_NAV_TIMING, "Existing Shipment extraction required.");
  test.setTimeout(180000);
  await page.addInitScript(() => {
    window.navLongTasks = [];
    new PerformanceObserver(list => window.navLongTasks.push(...list.getEntries().map(e => ({start:e.startTime, duration:e.duration})))).observe({type:"longtask", buffered:true});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Extractions',exact:true}).click();
  const started = Date.now();
  await page.locator('.job-row').filter({hasText:'mp_shipment.ff'}).first().click();
  await expect(page.locator('.asset-row').first()).toBeVisible({timeout:90000});
  const collectionMs = Date.now()-started;
  const search = await page.evaluate(async () => {
    const input=document.querySelector('#search'), results=[];
    for (const query of ['barrier','foliage','tree','fence','barrier_chain_link_fence_96_01_rusty_lod010v211']) {
      const start=performance.now(); input.value=query; input.dispatchEvent(new Event('input'));
      results.push(performance.now()-start);
      await new Promise(r=>setTimeout(r,100));
    }
    return results;
  });
  const row=page.locator('.asset-row').filter({hasText:'GLB'});
  await expect(row).toHaveCount(1);
  const modelStart=Date.now();
  const selectionMs=await row.evaluate(b=>{const start=performance.now();b.click();return performance.now()-start;});
  expect(Math.max(...search)).toBeLessThan(50);
  expect(selectionMs).toBeLessThan(50);
  await expect(page.locator('.model-canvas')).toBeVisible({timeout:60000});
  const geometryMs=Date.now()-modelStart;
  await expect(page.locator('.model-texture-status')).toHaveAttribute('data-cutout-surfaces',/^[1-9]/,{timeout:60000});
  const texturedMs=Date.now()-modelStart;
  const result={collectionMs,searchHandlerMs:search,selectionMs,geometryMs,texturedMs,longTasks:await page.evaluate(()=>window.navLongTasks)};
  console.log('NAV_TIMING',testInfo.project.name,JSON.stringify(result));
  await testInfo.attach('navigation-timing',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});

test("saved mp_frontend extraction assembles its Replay scene", async ({page}, testInfo) => {
  test.skip(!process.env.VIEWER_LIVE_SCENE, "Saved mp_frontend extraction required.");
  test.setTimeout(180000);
  await page.goto('/');
  await page.getByRole('button',{name:'Extractions',exact:true}).click();
  await page.locator('.job-row').filter({hasText:'mp_frontend.ff'}).first().click();
  await page.getByRole('button',{name:'Open available files',exact:true}).click();
  await expect(page.locator('.asset-row').first()).toBeVisible({timeout:90000});
  await page.getByLabel('Search assets',{exact:true}).fill('mp_frontend.scene.json');
  const scene=page.locator('.asset-row').filter({hasText:'mp_frontend.scene.json'});
  await expect(scene).toHaveCount(1);
  await scene.click();
  await expect(page.locator('.model-canvas')).toBeVisible({timeout:30000});
  await expect(page.locator('.model-texture-status')).toContainText('Scene ready',{timeout:120000});
  await expect(page.locator('.detail-grid')).toContainText('694 / 694');
  await page.screenshot({path:`.local/${testInfo.project.name}-mp-frontend-scene.png`,fullPage:true});
});

test("GSC source is syntax highlighted without interpreting embedded HTML", async ({page}) => {
  await page.goto('/');
  const source='main() { if (true) return "<img src=x onerror=window.gscInjected=true>"; // comment\n}';
  await page.locator('#file-input').setInputFiles({name:'example.gsc',mimeType:'text/plain',buffer:Buffer.from(source)});
  await expect(page.locator('.gsc-source')).toHaveText(source);
  await expect(page.locator('.gsc-keyword').first()).toBeVisible();
  expect(await page.evaluate(()=>window.gscInjected)).toBeUndefined();
});

test("large collection searches stay responsive and latest navigation wins", async ({page}) => {
  test.setTimeout(90000);
  await page.goto('/');
  const files={};
  for(let i=0;i<20000;i++) files[`large/file_${String(i).padStart(5,'0')}.txt`]=strToU8(`file ${i}`);
  await page.locator('#file-input').setInputFiles({name:'large.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))});
  await expect(page.locator('#result-count')).toHaveText('20,000 files',{timeout:45000});
  await expect(page.locator('#progress-dialog')).not.toBeVisible();
  const timings=await page.evaluate(()=>{
    const input=document.querySelector('#search'), timings=[];
    for(const value of ['file_0','file_09','file_199','file_19999']) {
      const start=performance.now();input.value=value;input.dispatchEvent(new Event('input'));timings.push(performance.now()-start);
    }
    return timings;
  });
  expect(Math.max(...timings)).toBeLessThan(50);
  await expect(page.locator('.asset-row')).toHaveCount(1);
  const row=page.locator('.asset-row');
  await row.click();
  await expect(row).toBeFocused();
  await expect(page.locator('.text-preview')).toHaveText('file 19999');
  await page.getByLabel('Search assets',{exact:true}).fill('');
  await expect(page.locator('#result-count')).toHaveText('20,000 files');
  await page.locator('#next').click();
  await expect(page.locator('#page-label')).toHaveText('2 / 250');
  await expect(page.locator('.asset-row').first()).toContainText('file_00080');
  await page.evaluate(()=>{
    document.querySelector('#search').dispatchEvent(new Event('input'));
    document.querySelector('#clear-button').click();
  });
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('.asset-row')).toHaveCount(0);
});

test("geometry opens before delayed textures and abandoned previews cannot take over", async ({page}) => {
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const read=File.prototype.arrayBuffer;
    window.releaseTextureReads=[];
    window.delayTextures=true;
    File.prototype.arrayBuffer=async function(...args) {
      if(window.delayTextures && this.name.endsWith('.dds')) await new Promise(resolve=>window.releaseTextureReads.push(resolve));
      return read.apply(this,args);
    };
  });
  await page.goto('/');
  const files=materialFixture(); files['last.txt']=strToU8('Latest selected file');
  await page.locator('#file-input').setInputFiles({name:'delayed.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))});
  await expect(page.locator('.model-canvas')).toBeVisible();
  await page.evaluate(()=>{window.firstModelCanvas=document.querySelector('.model-canvas');});
  await expect(page.locator('.model-texture-status')).toContainText('Loading model textures');
  await expect(page.locator('#progress-dialog')).not.toBeVisible();
  await page.getByRole('button',{name:'Open last.txt',exact:true}).click();
  await expect(page.locator('.text-preview')).toHaveText('Latest selected file');
  await page.evaluate(()=>{window.delayTextures=false;for(const release of window.releaseTextureReads) release();});
  // Let every pending file read and decoder completion settle.
  await page.waitForTimeout(250);
  await expect(page.locator('.text-preview')).toHaveText('Latest selected file');
  await expect(page.locator('.model-canvas')).toHaveCount(0);
  await page.getByRole('button',{name:'Open fixture/mesh',exact:true}).click();
  await expect(page.locator('.model-texture-status')).toHaveText('2 / 2 surfaces textured');
  expect(await page.evaluate(()=>window.firstModelCanvas===document.querySelector('.model-canvas'))).toBe(true);
  expect(errors).toEqual([]);
});

test("Replay scene manifests assemble instanced textured models", async ({page}) => {
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  const files=materialFixture(true);
  files['viewer_scenes/fixture.scene.json']=strToU8(JSON.stringify({
    format:'mw19-replay-scene',version:1,name:'maps/mp/fixture.d3dbsp',coordinateSystem:'iw8-z-up-inches',
    world:{geometry:'missing.world.glb',surfaceSet:'viewer/world/fixture',materials:[]},models:[{name:'fixture_model',surface:'fixture/mesh',geometry:'../assets/xmodelsurfs/fixture.glb',lod:1,
      instances:[
        {translationFixed:[0,0,0],rotation:[0,0,0,1],scale:1},
        {translationFixed:[163840,0,0],rotation:[0,0,0,1],scale:1},
      ]}],
    counts:{placements:2,models:1,worldSurfaces:0,missingModels:0,skippedPlacements:0},missingModels:[],
    unsupported:{splinedModels:0,clutterCollections:0},
  }));
  await page.locator('#file-input').setInputFiles({name:'scene.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(files))});
  await expect(page.locator('.model-canvas')).toBeVisible();
  await expect(page.locator('.model-texture-status')).toContainText('Scene ready');
  await expect(page.locator('.detail-grid')).toContainText('2 / 2');
  await expect(page.locator('.detail-grid')).toContainText('2');
  await expect(page.locator('.detail-grid')).toContainText('World unavailable');
  expect(errors).toEqual([]);
});

test("large DDS range decoding preserves selected mip pixels", async ({page}) => {
  await page.goto('/');
  const bytes=Buffer.alloc(148+512*512*4+256*256*4);
  for(const [offset,value] of Object.entries({0:0x20534444,4:124,12:512,16:512,28:2,76:32,84:0x30315844,128:28,132:3,140:1})) bytes.writeUInt32LE(value,Number(offset));
  for(let i=148;i<148+512*512*4;i+=4) {bytes[i]=255;bytes[i+3]=255;}
  for(let i=148+512*512*4;i<bytes.length;i+=4) {bytes[i+1]=255;bytes[i+3]=255;}
  await page.locator('#file-input').setInputFiles({name:'large.dds',mimeType:'application/octet-stream',buffer:bytes});
  const canvas=page.locator('.image-surface');
  await expect(canvas).toBeVisible();
  const pixel=()=>canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,1,1).data));
  expect(await pixel()).toEqual([255,0,0,255]);
  await page.getByLabel('DDS mip',{exact:true}).selectOption('1');
  await expect(page.locator('.detail-grid')).toContainText('256 × 256');
  expect(await pixel()).toEqual([0,255,0,255]);
});

test("large GSC highlighting preserves the complete source and navigation", async ({page}) => {
  await page.goto('/');
  const source=('main() { if (true) return "<safe>"; } // comment\n').repeat(9000);
  await page.locator('#file-input').setInputFiles({name:'large.gsc',mimeType:'text/plain',buffer:Buffer.from(source)});
  await expect(page.locator('.gsc-keyword').first()).toBeVisible();
  expect(await page.locator('.gsc-source code').textContent()).toBe(source);
  await page.locator('#clear-button').click();
  await expect(page.locator('#welcome')).toBeVisible();
});

test("selected compiled IW8 script is decompiled and highlighted", async ({page}, testInfo) => {
  test.skip(!process.env.VIEWER_GSC_FIXTURE, 'A selected GSCBIN fixture is required.');
  test.setTimeout(90000);
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(process.env.VIEWER_GSC_FIXTURE);
  await expect(page.locator('.gsc-source')).toBeVisible({timeout:60000});
  await expect(page.locator('.gsc-source')).not.toContainText('<errlocal:');
  await expect(page.locator('.gsc-keyword').first()).toBeVisible();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download GSC',exact:true}).click();
  expect((await download).suggestedFilename()).toMatch(/\.gsc$/);
  await page.screenshot({path:`.local/${testInfo.project.name}-gsc-source.png`,fullPage:true});
});

test("cached Shipment fence and foliage render opacity cutouts", async ({page}, testInfo) => {
  test.skip(!process.env.VIEWER_CUTOUT_STOCK,'Existing Shipment extraction required.');
  test.setTimeout(240000);
  await page.goto('/');
  await page.getByRole('button',{name:'Extractions',exact:true}).click();
  await page.locator('.job-row').filter({hasText:'mp_shipment.ff'}).first().click();
  if(await page.locator('#extraction-dialog').isVisible()) await page.locator('#extraction-open').click();
  for(const name of ['barrier_chain_link_fence_96_01_rusty_lod010v211','uk_trees_large_magnolia_tree_01_lod010-1-vf41']) {
    await page.getByLabel('Search assets',{exact:true}).fill(name);
    await page.locator('.asset-row').filter({hasText:'GLB'}).click();
    await expect(page.locator('.model-texture-status')).toHaveAttribute('data-cutout-surfaces',/^[1-9]/,{timeout:60000});
    await page.getByLabel('Cutouts',{exact:true}).uncheck();
    const opaque=await page.locator('canvas.model-canvas').screenshot();
    await page.getByLabel('Cutouts',{exact:true}).check();
    const cutout=await page.locator('canvas.model-canvas').screenshot();
    expect(opaque.equals(cutout)).toBe(false);
    await page.screenshot({path:`.local/${testInfo.project.name}-cutout-${name}.png`,fullPage:true});
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("demo renders a model, DDS mip, safe text and responsive layout", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Inside the zone." }),
  ).toBeVisible();
  await page.screenshot({
    path: `.local/${testInfo.project.name}-welcome.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /Open demo/ }).click();
  await expect(page.locator("canvas.model-canvas")).toBeVisible();
  await expect(page.locator(".detail-grid")).toContainText("Triangles");
  await page.getByLabel("Wireframe", { exact: true }).check();
  await page.getByLabel("Wireframe", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page.screenshot({
    path: `.local/${testInfo.project.name}-model.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open zone_demo_checker" }).click();
  await expect(page.locator("canvas.image-surface")).toBeVisible();
  await page.getByLabel("DDS mip", { exact: true }).selectOption("2");
  await expect(page.locator(".detail-grid")).toContainText("16 × 16");
  await page.getByLabel("Image channel").selectOption("a");
  expect(
    await page
      .locator("canvas.image-surface")
      .evaluate((c) =>
        Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data),
      ),
  ).toEqual([255, 255, 255, 255]);
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save PNG" }).click();
  expect((await saved).suggestedFilename()).toContain(".png");
  await page.screenshot({
    path: `.local/${testInfo.project.name}-image.png`,
    fullPage: true,
  });
  await page.getByLabel("Search assets", { exact: true }).fill("demo_material");
  await expect(page.locator(".asset-row")).toHaveCount(1);
  await page.locator(".asset-row").click();
  await expect(page.locator(".text-preview")).toContainText("roughness");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("ZIP import uses ACTS paths, malformed ZIP is rejected, and text cannot execute", async ({
  page,
}) => {
  await page.goto("/");
  const zip = zipSync({
    "fixture/assets/rawfile/sample.txt": strToU8(
      '<img src=x onerror="window.pwned=true">',
    ),
    "fixture/assets.jsonl": strToU8(
      JSON.stringify({
        name: "fixture_script",
        type: "rawfile",
        file: "assets/rawfile/sample.txt",
      }),
    ),
  });
  await page.locator("#file-input").setInputFiles({
    name: "fixture.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await expect(page.locator(".text-preview")).toContainText("<img");
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await expect(
    page.getByRole("button", { name: "Open fixture_script" }),
  ).toBeVisible();
  const bad = zipSync({ "../escape.txt": strToU8("no") });
  await page.locator("#file-input").setInputFiles({
    name: "bad.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(bad),
  });
  await expect(page.locator("#notice")).toContainText("leaves the collection");
  await expect(page.locator(".asset-row")).toHaveCount(2);
});

test("compressed DDS uses WASM with correct color and BC7 dispatch", async ({
  page,
}) => {
  await page.goto("/");
  function dds(format, data) {
    const buffer = Buffer.alloc(148 + data.length);
    for (const [offset, value] of Object.entries({
      0: 0x20534444,
      4: 124,
      12: 4,
      16: 4,
      28: 1,
      76: 32,
      84: 0x30315844,
      128: format,
      132: 3,
      140: 1,
    }))
      buffer.writeUInt32LE(value, Number(offset));
    Buffer.from(data).copy(buffer, 148);
    return buffer;
  }
  await page.locator("#file-input").setInputFiles({
    name: "red.dds",
    mimeType: "application/octet-stream",
    buffer: dds(71, [0, 248, 0, 0, 0, 0, 0, 0]),
  });
  await expect(page.locator("canvas.image-surface")).toBeVisible();
  expect(
    await page
      .locator("canvas.image-surface")
      .evaluate((c) =>
        Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data),
      ),
  ).toEqual([255, 0, 0, 255]);
  await page.locator("#file-input").setInputFiles({
    name: "bc7.dds",
    mimeType: "application/octet-stream",
    buffer: dds(98, [64, ...Array(15).fill(0)]),
  });
  await expect(page.locator(".detail-grid")).toContainText("BC7");
  await expect(page.locator("canvas.image-surface")).toBeVisible();
});

test("missing model dependency produces a clear error without an external request", async ({
  page,
}) => {
  await page.goto("/");
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ uri: "https://example.com/private.bin", byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 1],
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  await page.locator("#file-input").setInputFiles({
    name: "external.gltf",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(gltf)),
  });
  await expect(page.locator(".preview-message")).toContainText(
    "External model resources are disabled",
  );
});

test("server browser loads an ACTS native-exported GLB without a device upload", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.VIEWER_NATIVE_FIXTURE,
    "Set VIEWER_NATIVE_FIXTURE to a relative synthetic export folder under acts_extractions.",
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Browse server files", exact: true })
    .click();
  await page.getByLabel("Server location").selectOption("acts_extractions");
  for (const folder of process.env.VIEWER_NATIVE_FIXTURE.split("/")) {
    await page
      .locator("#server-files")
      .getByRole("button", { name: new RegExp(`${folder}.*Open`) })
      .click();
  }
  await page
    .getByRole("button", { name: "Open this folder", exact: true })
    .click();
  await expect(page.locator("canvas.model-canvas")).toBeVisible();
  await expect(page.locator(".detail-grid")).toContainText(
    "base surface geometry",
  );
  await expect(page.locator(".detail-grid")).toContainText("Triangles");
  expect(await page.locator(".detail-grid dd").allTextContents()).toContain(
    "3",
  );
  await page.screenshot({
    path: `.local/${testInfo.project.name}-server-native-model.png`,
    fullPage: true,
  });
});

test("server DDS preview reads host bytes over the authenticated API", async ({
  page,
}) => {
  test.skip(
    !process.env.VIEWER_NATIVE_FIXTURE,
    "Local host sample setup required.",
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Browse server files", exact: true })
    .click();
  await page.getByLabel("Server location").selectOption("viewer_samples");
  await page
    .getByRole("button", { name: "Open this folder", exact: true })
    .click();
  await expect(page.locator("canvas.model-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Open red_bc1", exact: true }).click();
  await expect(page.locator("canvas.image-surface")).toBeVisible();
  expect(
    await page
      .locator("canvas.image-surface")
      .evaluate((c) =>
        Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data),
      ),
  ).toEqual([255, 0, 0, 255]);
});

async function openHostFastfile(page, root, folders, filename) {
  if (await page.locator("#collection").isVisible())
    await page.getByRole("button", { name: /Import extraction/ }).click();
  await page
    .getByRole("button", { name: "Browse server files", exact: true })
    .click();
  await page.getByLabel("Server location").selectOption(root);
  for (const folder of folders)
    await page
      .locator("#server-files")
      .getByRole("button", { name: new RegExp(`^.*${folder}.*Open`) })
      .click();
  await page
    .getByRole("checkbox", { name: `Select ${filename}`, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Open selected (1)", exact: true })
    .click();
}

test("portable ACTS ZIP maps each primitive to its material and switches variants", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "textured.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zipSync(materialFixture())),
  });
  await expect(page.locator("canvas.model-canvas")).toBeVisible();
  await expect(page.locator(".model-texture-status")).toHaveText(
    "2 / 2 surfaces textured",
  );
  const canvas = page.locator("canvas.model-canvas");
  const first = await canvas.screenshot();
  await page.getByLabel("Textures", { exact: true }).uncheck();
  const plain = await canvas.screenshot();
  expect(first.equals(plain)).toBe(false);
  await page.getByLabel("Textures", { exact: true }).check();
  await page.getByLabel("Material set").selectOption("1");
  await expect(page.locator(".model-texture-status")).toHaveText(
    "2 / 2 surfaces textured",
  );
  const swapped = await canvas.screenshot();
  expect(first.equals(swapped)).toBe(false);
  await page.screenshot({
    path: `.local/${testInfo.project.name}-material-variants.png`,
    fullPage: true,
  });
});

test("selecting a server fastfile extracts with ACTS, renders GLB, and reuses its cache", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.VIEWER_FF_FIXTURE,
    "Set VIEWER_FF_FIXTURE to the native synthetic triangle.ff path.",
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await openHostFastfile(
    page,
    "acts_extractions",
    ["ff-native-geometry-fixture"],
    "triangle.ff",
  );
  await expect(page.locator("canvas.model-canvas")).toBeVisible({
    timeout: 30000,
  });
  expect(await page.locator(".detail-grid dd").allTextContents()).toContain(
    "3",
  );
  const before = await page.evaluate(
    async () => (await (await fetch("/api/extractions")).json()).jobs,
  );
  expect(before.find((j) => j.name === "triangle.ff")?.status).toBe("complete");
  await page.reload();
  await openHostFastfile(
    page,
    "acts_extractions",
    ["ff-native-geometry-fixture"],
    "triangle.ff",
  );
  await expect(page.locator("canvas.model-canvas")).toBeVisible({
    timeout: 30000,
  });
  const after = await page.evaluate(
    async () => (await (await fetch("/api/extractions")).json()).jobs,
  );
  expect(
    after.filter((j) => j.name === "triangle.ff").map((j) => j.id),
  ).toEqual(before.filter((j) => j.name === "triangle.ff").map((j) => j.id));
  await page.screenshot({
    path: `.local/${testInfo.project.name}-automatic-fastfile.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("device fastfile upload automatically extracts and survives a page reload in history", async ({
  page,
}) => {
  test.skip(
    !process.env.VIEWER_FF_FIXTURE,
    "Native synthetic fastfile required.",
  );
  await page.goto("/");
  await page
    .locator("#file-input")
    .setInputFiles(process.env.VIEWER_FF_FIXTURE);
  await expect(page.locator("canvas.model-canvas")).toBeVisible({
    timeout: 30000,
  });
  await page.reload();
  await page.getByRole("button", { name: "Extractions", exact: true }).click();
  await page
    .locator(".job-row")
    .filter({ hasText: "triangle.ff" })
    .first()
    .click();
  await expect(page.locator("canvas.model-canvas")).toBeVisible();
  expect(await page.locator(".detail-grid dd").allTextContents()).toContain(
    "3",
  );
});

test("malformed fastfiles report a visible extraction error", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "invalid.ff",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(64, 42),
  });
  await expect(page.locator("#extraction-message")).toContainText(
    "not an IW8 fastfile",
  );
  await expect(page.locator("#extraction-state")).toContainText("failed");
  await expect(page.locator("#extraction-open")).toBeHidden();
  await page.screenshot({
    path: `.local/${testInfo.project.name}-fastfile-error.png`,
    fullPage: true,
  });
});

test("fastfiles inside a ZIP extract automatically and partial native errors stay visible", async ({
  page,
}) => {
  test.skip(
    !process.env.VIEWER_FF_FIXTURE,
    "Native synthetic fastfile required.",
  );
  await page.goto("/");
  const zip = zipSync({
    "nested/triangle.ff": new Uint8Array(
      readFileSync(process.env.VIEWER_FF_FIXTURE),
    ),
  });
  await page.locator("#file-input").setInputFiles({
    name: "fastfile.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zip),
  });
  await expect(page.locator("canvas.model-canvas")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator("#collection-title")).toHaveText("triangle");
  await openHostFastfile(
    page,
    "acts_extractions",
    ["ff-native-geometry-fixture"],
    "bad-index.ff",
  );
  await expect(page.locator("#extraction-state")).toHaveText("partial", {
    timeout: 30000,
  });
  await expect(page.locator("#extraction-message")).toContainText("failures");
  await page.locator("#extraction-open").click();
  await expect(page.locator("#extraction-dialog")).not.toBeVisible();
  await expect(page.locator("#notice")).toContainText("failures");
});

test("older Replay fastfiles apply matching patches for host selection and device upload", async ({ page }, testInfo) => {
  test.skip(!process.env.VIEWER_PATCH_FF, "Set VIEWER_PATCH_FF to installed global_core_mp.ff.");
  test.setTimeout(180000);
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await openHostFastfile(page, "replay_game", ["zone"], "global_core_mp.ff");
  await expect(page.locator("#extraction-dialog")).not.toBeVisible({ timeout: 120000 });
  await expect(page.locator(".asset-row").first()).toBeVisible();
  let jobs = await page.evaluate(async () => (await (await fetch("/api/extractions")).json()).jobs);
  let job = jobs.find((j) => j.name === "global_core_mp.ff");
  expect(job.status).toBe("complete");
  expect(job.progress.loaded_assets).toBeGreaterThan(0);
  expect(job.progress.tested).toBe(job.progress.loaded_assets);
  expect(job.log).toContain("loading fp patch");
  await page.reload();
  await page.locator("#file-input").setInputFiles(process.env.VIEWER_PATCH_FF);
  await expect(page.locator("#extraction-dialog")).not.toBeVisible({ timeout: 120000 });
  await expect(page.locator(".asset-row").first()).toBeVisible();
  jobs = await page.evaluate(async () => (await (await fetch("/api/extractions")).json()).jobs);
  job = jobs.find((j) => j.name === "global_core_mp.ff");
  expect(job.status).toBe("complete"); expect(job.log).toContain("loading fp patch");
  expect(errors).toEqual([]);
  await page.screenshot({ path: `.local/${testInfo.project.name}-patched-fastfile.png`, fullPage: true });
});

test("unpatched older Replay transient uploads render real model geometry", async ({ page }, testInfo) => {
  test.skip(!process.env.VIEWER_LEGACY_FF, "Set VIEWER_LEGACY_FF to a real 0xfcd model transient.");
  test.setTimeout(180000);
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(process.env.VIEWER_LEGACY_FF);
  await expect(page.locator("canvas.model-canvas")).toBeVisible({ timeout: 150000 });
  const jobs = await page.evaluate(async () => (await (await fetch("/api/extractions")).json()).jobs);
  const name = process.env.VIEWER_LEGACY_FF.replaceAll("\\", "/").split("/").at(-1);
  const job = jobs.find((j) => j.name === name);
  expect(job.status).toBe("complete"); expect(job.progress.loaded_assets).toBeGreaterThan(0);
  await expect(page.locator(".detail-grid")).toContainText("Triangles");
  await page.screenshot({ path: `.local/${testInfo.project.name}-legacy-model.png`, fullPage: true });
});

test("stock Replay fastfile automatically exports every contained asset", async ({
  page,
}) => {
  test.skip(
    !process.env.VIEWER_STOCK_FF,
    "Set VIEWER_STOCK_FF=1 to allow a code_pre_gfx.ff disk extraction.",
  );
  await page.goto("/");
  await openHostFastfile(page, "replay_game", ["zone"], "code_pre_gfx.ff");
  await expect(page.locator("#extraction-dialog")).not.toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator(".asset-row").first()).toBeVisible();
  const jobs = await page.evaluate(
    async () => (await (await fetch("/api/extractions")).json()).jobs,
  );
  const job = jobs.find((j) => j.name === "code_pre_gfx.ff");
  expect(job.status).toBe("complete");
  expect(job.progress.loaded_assets).toBe(43);
  expect(job.progress.tested).toBe(43);
  expect(job.progress.failed).toBe(0);
  expect(job.progress.unavailable).toBe(0);
});

test("repaired code_post_gfx exports all assets and renders the resident button image", async ({ page }, testInfo) => {
  test.skip(!process.env.VIEWER_AFFECTED_FF, "Selected owner fastfiles required.");
  test.setTimeout(600000);
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/");
  await openHostFastfile(page, "replay_game", ["zone"], "code_post_gfx.ff");
  await expect(page.locator("#extraction-dialog")).not.toBeVisible({timeout: 540000});
  const jobs = await page.evaluate(async () => (await (await fetch("/api/extractions")).json()).jobs);
  const job = jobs.find(j => j.name === "code_post_gfx.ff");
  expect(job.status).toBe("complete");
  expect(job.progress.loaded_assets).toBe(6012);
  expect(job.progress.tested).toBe(6012);
  expect(job.progress.failed).toBe(0); expect(job.progress.unavailable).toBe(0);
  await page.getByLabel("Search assets", {exact:true}).fill("button_alt1");
  await page.getByRole("button", {name: "Open button_alt1", exact:true}).click();
  const canvas = page.locator("canvas.image-surface");
  await expect(canvas).toBeVisible();
  const pixels = await canvas.evaluate(c => {
    const ctx = c.getContext("2d");
    return [[0,0],[8,32],[32,32]].map(([x,y]) => Array.from(ctx.getImageData(x,y,1,1).data));
  });
  expect(pixels[0][3]).toBe(0);
  expect(pixels[1].slice(0,3).every(v => v > 240)).toBe(true);
  expect(pixels[1][3]).toBe(255);
  expect(pixels[2].slice(0,3).every(v => v < 90)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({path:`.local/${testInfo.project.name}-repaired-button.png`,fullPage:true});
});

test("repaired frontend loads its older world and prepares model textures", async ({ page }, testInfo) => {
  test.skip(!process.env.VIEWER_AFFECTED_FF, "Selected owner fastfiles required.");
  test.setTimeout(600000);
  await page.goto("/");
  const started = page.waitForResponse(r => r.url().endsWith("/api/extractions") && r.request().method() === "POST");
  await openHostFastfile(page,"replay_game",["zone"],"mp_frontend.ff");
  const submitted = await (await started).json();
  const identity = submitted.id;
  await expect.poll(async () => {
    const jobs=await page.evaluate(async()=> (await (await fetch("/api/extractions")).json()).jobs);
    return jobs.find(j=>j.id===identity)?.status;
  },{timeout:540000,intervals:[1500]}).toMatch(/^(complete|partial)$/);
  const jobs=await page.evaluate(async()=> (await (await fetch("/api/extractions")).json()).jobs);
  const job=jobs.find(j=>j.id===identity);
  expect(job.progress.complete).toBe(true); expect(job.progress.loaded_assets).toBe(2013);
  expect(job.progress.failed).toBe(0);
  expect(job.material_summary?.surface_sets).toBeGreaterThan(0);
  if(await page.locator("#extraction-dialog").isVisible()) await page.locator("#extraction-open").click();
  await expect(page.locator(".asset-row").first()).toBeVisible();
  await page.screenshot({path:`.local/${testInfo.project.name}-repaired-frontend.png`,fullPage:true});
});

test("cached repaired frontend renders all available model texture assignments", async ({ page }, testInfo) => {
  test.skip(!process.env.VIEWER_AFFECTED_FF, "A repaired mp_frontend extraction is required.");
  test.setTimeout(180000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", {name:"Extractions", exact:true}).click();
  await page.locator(".job-row").filter({hasText:"mp_frontend.ff"}).first().click();
  await page.locator("#extraction-open").click();
  for (const [name, count] of [
    ["military_carepackage_01_lod010-4-v00c11", 6],
    ["offhand_vm_deployable_cover10v0000050", 11],
    ["accessory_ui_perk_patch_01_lod010v40", 1],
  ]) {
    await page.getByLabel("Search assets", {exact:true}).fill(name);
    await page.locator(".asset-row").filter({hasText:"GLB"}).click();
    await expect(page.locator("canvas.model-canvas")).toBeVisible({timeout:45000});
    await expect(page.locator(".model-texture-status")).toHaveText(`${count} / ${count} surfaces textured`, {timeout:45000});
    await page.screenshot({path:`.local/${testInfo.project.name}-frontend-${name}.png`,fullPage:true});
  }
  await page.getByLabel("Material set").selectOption("1");
  await expect(page.locator(".model-texture-status")).toHaveText("1 / 1 surfaces textured", {timeout:30000});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Replay header-only patch and older world transient open through host selection", async ({ page }) => {
  test.skip(!process.env.VIEWER_PATCH_FF, "Local Replay installation required.");
  test.setTimeout(180000);
  await page.goto("/");
  await openHostFastfile(page, "replay_game", ["zone", "worldwide"], "ww_mp_bm_tut.ff");
  await expect(page.locator("#extraction-dialog")).not.toBeVisible({ timeout: 120000 });
  await expect(page.locator(".asset-row").first()).toBeVisible();
  let jobs = await page.evaluate(async () => (await (await fetch("/api/extractions")).json()).jobs);
  let job = jobs.find((j) => j.name === "ww_mp_bm_tut.ff");
  expect(job.status).toBe("complete"); expect(job.progress.loaded_assets).toBe(141);
  expect(job.log).toContain("header-only patch: retaining");
  await page.reload();
  await openHostFastfile(page, "replay_game", ["zone"], "mp_br_quarry_00001_tr.ff");
  await expect(page.locator("#extraction-dialog")).not.toBeVisible({ timeout: 120000 });
  await expect(page.locator(".asset-row").first()).toBeVisible();
  jobs = await page.evaluate(async () => (await (await fetch("/api/extractions")).json()).jobs);
  job = jobs.find((j) => j.name === "mp_br_quarry_00001_tr.ff");
  expect(job.status).toBe("complete"); expect(job.progress.loaded_assets).toBe(2);
});

test("Shipment's native model uses its companion material and DDS color textures", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.VIEWER_TEXTURE_STOCK,
    "Set VIEWER_TEXTURE_STOCK=1 to open or upgrade the existing Shipment cache.",
  );
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await openHostFastfile(page, "replay_game", ["zone"], "mp_shipment.ff");
  await expect(page.locator("canvas.model-canvas")).toBeVisible({
    timeout: 90000,
  });
  await page
    .getByLabel("Search assets", { exact: true })
    .fill("barrier_chain_link_fence_32_01_rusty_lod010v811");
  await page.locator(".asset-row").filter({ hasText: "GLB" }).click();
  await expect(page.locator(".model-texture-status")).toHaveText(
    "2 / 2 surfaces textured",
    { timeout: 30000 },
  );
  await expect(page.locator(".detail-grid")).toContainText(
    "2 / 2 surfaces textured",
  );
  await page.getByLabel("Textures", { exact: true }).uncheck();
  await page.screenshot({
    path: `.local/${testInfo.project.name}-shipment-untextured.png`,
    fullPage: true,
  });
  await page.getByLabel("Textures", { exact: true }).check();
  await page.screenshot({
    path: `.local/${testInfo.project.name}-shipment-textured.png`,
    fullPage: true,
  });
  await page
    .getByLabel("Search assets", { exact: true })
    .fill("body_al_qatala_desert_02_lod020d8bd8873v00000000000040");
  await page.locator(".asset-row").filter({ hasText: "GLB" }).click();
  await expect(page.locator(".model-texture-status")).toHaveText(
    "25 / 25 surfaces textured",
    { timeout: 30000 },
  );
  await page.getByLabel("Material set").selectOption("1");
  await expect(page.locator(".model-texture-status")).toHaveText(
    "25 / 25 surfaces textured",
    { timeout: 30000 },
  );
  await page.screenshot({
    path: `.local/${testInfo.project.name}-shipment-character-textured.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
