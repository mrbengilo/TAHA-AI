import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-workers-loader.mjs", import.meta.url), import.meta.url);

const projectRoot = new URL("../", import.meta.url);
const starterPreviewRoot = new URL("../app/_sites-preview/", import.meta.url);
const starterMarkers =
  /codex-preview|Building your site|Your site is taking shape|react-loading-skeleton/i;

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function assertMeta(html, attributeName, attributeValue, contentPattern) {
  const tag = html.match(
    new RegExp(
      `<meta(?=[^>]*\\b${attributeName}=["']${attributeValue}["'])[^>]*>`,
      "i",
    ),
  )?.[0];

  assert.ok(tag, `Missing ${attributeName}="${attributeValue}" metadata`);
  assert.match(tag, new RegExp(`\\bcontent=["']${contentPattern}["']`, "i"));
}

async function assertHtmlResponse(pathname) {
  const response = await render(pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  return response.text();
}

test("server-renders the TAHA AI operations dashboard", async () => {
  const html = await assertHtmlResponse("/");

  assert.match(html, /<html[^>]*\blang=["']vi["']/i);
  assert.match(
    html,
    /<title>TAHA AI (?:—|&#x2014;) Trung tâm vận hành bán hàng đa kênh<\/title>/i,
  );
  assert.match(html, /Chào buổi sáng, TAHA\./);
  assert.match(html, /Nội dung của bạn/);
  assert.match(html, /Mọi kênh, một nhịp vận hành/);
  assert.match(html, /Kết nối kênh/);
  assert.doesNotMatch(html, starterMarkers);

  assertMeta(
    html,
    "property",
    "og:title",
    "TAHA AI (?:—|&#x2014;) Vận hành bán hàng đa kênh",
  );
  assertMeta(
    html,
    "property",
    "og:description",
    "Google Drive và Sheet đi vào một luồng duyệt, lên lịch và xuất bản đa kênh\\.",
  );
  assertMeta(html, "property", "og:image", "[^\"']*\\/og\\.png");
});

test("server-renders the channel connection center", async () => {
  const html = await assertHtmlResponse("/connections");

  assert.match(html, /<title>Kết nối kênh \| TAHA AI<\/title>/i);
  assert.match(html, /Kết nối các kênh của bạn/);
  assert.match(html, /Nguồn sản phẩm đi vào từ Google/);
  assert.match(html, /Quay lại tổng quan/);
  assert.match(html, /Thông tin được bảo vệ/);
  assert.doesNotMatch(html, starterMarkers);
  assertMeta(html, "property", "og:image", "[^\"']*\\/og\\.png");
});

test("removes the disposable starter preview and dependency", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /SkeletonPreview|codex-preview|_sites-preview/);
  assert.doesNotMatch(layout, /SkeletonPreview|codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(layout, /title:\s*"TAHA AI/);
  assert.match(layout, /openGraph:\s*\{/);
  assert.match(layout, /images:\s*\[\{\s*url:\s*"\/og\.png"/);

  await assert.rejects(access(starterPreviewRoot));
  await access(new URL("public/og.png", projectRoot));
});
