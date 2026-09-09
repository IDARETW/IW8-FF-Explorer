import test from "node:test";
import assert from "node:assert/strict";
import {gscTokens} from "../src/script-preview.js";
import {surfaceMaterial} from "../src/material-bindings.js";
import {expandOpacityChannel} from "../src/model-textures.js";

test("single-channel BC4 masks reach Three's green-channel alpha sampler", () => {
  const pixels=new Uint8Array([0,0,0,255,255,0,0,255,128,0,0,255]);
  assert.deepEqual([...expandOpacityChannel(pixels)], [0,0,0,255,255,255,255,255,128,128,128,255]);
});

test("GSC lexer preserves source and distinguishes comments, strings and keywords", () => {
  const source = '#include maps\\mp\\_utility;\nmain() { if (self.x == 42) return "<script>if</script>"; /* while */ // end\n}\n';
  const tokens = gscTokens(source);
  assert.equal(tokens.map(t => t.text).join(''), source);
  assert.ok(tokens.some(t => t.kind === 'keyword' && t.text === 'if'));
  assert.ok(tokens.some(t => t.kind === 'string' && t.text.includes('<script>')));
  assert.ok(tokens.some(t => t.kind === 'function' && t.text === 'main'));
  assert.ok(tokens.some(t => t.kind === 'comment' && t.text.includes('while')));
  const long = 'x + '.repeat(30000);
  assert.equal(gscTokens(long).map(t => t.text).join(''), long);
});

test("opacity follows its explicit material slot, separately from packed color alpha", () => {
  const color = {path:'color'}, mask = {path:'mask'};
  const binding = {variants:[{materials:['net']}],materials:{net:{textures:[{slot:0,image:'packed'},{slot:27,image:'opacity'}]}},images:new Map([['packed',color],['opacity',mask]])};
  assert.equal(surfaceMaterial(binding,0,0).image,color);
  assert.equal(surfaceMaterial(binding,0,0).opacity,mask);
  binding.images.delete('opacity');
  assert.equal(surfaceMaterial(binding,0,0).opacity,undefined);
  assert.equal(surfaceMaterial(binding,0,0).opacityName,'opacity');
});
