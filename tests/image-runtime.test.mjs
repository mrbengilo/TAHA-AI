import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Miniflare } = require(require.resolve("miniflare", { paths: [require.resolve("wrangler/package.json")] }));

function pngChunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
  header.writeUInt32BE(data.length); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, trailer]);
}

function noisyPng() {
  const width = 1024, height = 1024;
  const rows = Buffer.alloc(height * (1 + width * 3));
  let seed = 17;
  for (let y = 0; y < height; y += 1) {
    for (let x = 1; x <= width * 3; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      rows[y * (1 + width * 3) + x] = seed >>> 24;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

test("real workerd image binding decodes, resizes and encodes below both strict byte ceilings", { timeout: 60000 }, async () => {
  const source = (await readFile(new URL("../lib/image-compression.ts", import.meta.url), "utf8"))
    .replace('import { getRuntimeEnv } from "./integrations/env";', 'function getRuntimeEnv() { return {}; }')
    .replace(/^export /gm, "");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-05-22", images: { binding: "IMAGES" },
    script: `${code}
      export default { async fetch(request, env) {
        try {
          const ceiling = Number(new URL(request.url).searchParams.get("ceiling"));
          const result = await compressImageToJpeg(await request.blob(), ceiling, env.IMAGES);
          const decoded = await env.IMAGES.info(result.blob.stream());
          return Response.json({ bytes: result.blob.size, type: result.blob.type, width: decoded.width,
            height: decoded.height, claimedWidth: result.width, claimedHeight: result.height });
        } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
      }};` });
  try {
    const fixture = noisyPng();
    assert.ok(fixture.length > 300000);
    for (const ceiling of [200000, 300000]) {
      const response = await runtime.dispatchFetch(`http://localhost/encode?ceiling=${ceiling}`, {
        method: "POST", headers: { "content-type": "image/png" }, body: fixture,
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.ok(result.bytes > 0 && result.bytes < ceiling, JSON.stringify(result));
      assert.equal(result.type, "image/jpeg");
      assert.equal(result.width, result.claimedWidth);
      assert.equal(result.height, result.claimedHeight);
      assert.ok(result.width <= 1024 && result.height <= 1024);
    }
  } finally { await runtime.dispose(); }
});
