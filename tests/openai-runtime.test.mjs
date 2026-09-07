import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Miniflare } = require(require.resolve("miniflare", { paths: [require.resolve("wrangler/package.json")] }));

test("OpenAI request options work in the deployed workerd runtime and reject redirects", async () => {
  const source = (await readFile(new URL("../lib/ai/openai.ts", import.meta.url), "utf8"))
    .replace('import { getRuntimeEnv } from "../integrations/env";', 'function getRuntimeEnv() { return { OPENAI_API_KEY: "test-runtime-key" }; }');
  const client = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const content = { sku: "PH0001", productDescription: "Giày PH0001", hashtags: ["#PH0001"], channels: { facebook: { title: "Giày PH0001", body: "Bài viết PH0001", hashtags: ["#PH0001"] } } };
  const script = `${client}
    export default { async fetch(request) {
      const captured = [];
      try {
        const result = await generateProductContent({ product: { sku: "PH0001", name: "Giày PH0001" }, targetProviders: ["facebook"] }, async (url, init) => {
          // Use workerd's actual Request constructor. A Node mock hid the production failure.
          const actual = new Request(url, init);
          captured.push({ redirect: actual.redirect, method: actual.method });
          if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid" } });
          return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: ${JSON.stringify(JSON.stringify(content))} }] }] });
        });
        return Response.json({ sku: result.content.sku, captured });
      } catch (error) { return Response.json({ code: error.code, retryable: error.retryable, captured }); }
    }};
  `;
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-05-22", script });
  try {
    const success = await (await runtime.dispatchFetch("http://localhost/content")).json();
    assert.equal(success.sku, "PH0001", JSON.stringify(success));
    assert.deepEqual(success.captured, [{ redirect: "manual", method: "POST" }]);
    const redirected = await (await runtime.dispatchFetch("http://localhost/redirect")).json();
    assert.equal(redirected.code, "OPENAI_REDIRECT_REJECTED");
    assert.equal(redirected.retryable, false);
    assert.equal(redirected.captured.length, 1);
  } finally { await runtime.dispose(); }
});
