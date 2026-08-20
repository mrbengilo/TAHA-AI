import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const workspaceId = "workspace-test";

class FakeD1 {
  constructor(connections) {
    this.connections = new Map(connections.map((connection) => [connection.id, connection]));
    this.jobs = new Map();
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        first: async () => {
          if (sql.includes("FROM channel_connections")) {
            const [connectionId] = values;
            const connection = this.connections.get(connectionId);
            return connection?.status === "connected" ? connection : null;
          }

          if (sql.includes("INSERT INTO publish_jobs")) {
            const [id, , connectionId, jobKind, dedupeKey, status, , , payloadSnapshot] = values;
            if (this.jobs.has(dedupeKey)) return null;
            const row = {
              id,
              connection_id: connectionId,
              job_kind: jobKind,
              status,
              payload_snapshot_json: payloadSnapshot,
              external_post_id: null,
              external_url: null,
            };
            this.jobs.set(dedupeKey, row);
            return row;
          }

          if (sql.includes("FROM publish_jobs")) {
            const [, dedupeKey] = values;
            return this.jobs.get(dedupeKey) ?? null;
          }

          throw new Error(`Unexpected query: ${sql}`);
        },
      }),
    };
  }
}

async function loadPublishJobs(database) {
  const source = await readFile(new URL("../lib/publish-jobs.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    crypto: webcrypto,
    console,
    require(specifier) {
      if (specifier === "./integrations/crypto") {
        return {
          sha256Hex: async (value) => createHash("sha256").update(value).digest("hex"),
        };
      }
      if (specifier === "./integrations/env") return { getRuntimeEnv: () => ({ DB: database }) };
      if (specifier === "./integrations/store") return { TAHA_WORKSPACE_ID: workspaceId };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "publish-jobs.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function input(overrides = {}) {
  return {
    connectionId: "zalo",
    dedupeKey: "schedule:one:1000",
    jobKind: "social_post",
    payload: { message: "Bài A", mediaIds: ["media-1"] },
    status: "awaiting_confirmation",
    expectedProvider: "zalo_personal",
    expectedPublishMode: "assisted",
    ...overrides,
  };
}

test("atomically creates one job and replays the other concurrent request", async () => {
  const database = new FakeD1([
    { id: "zalo", provider: "zalo_personal", publish_mode: "assisted", status: "connected" },
  ]);
  const { startPublishJob } = await loadPublishJobs(database);
  const results = await Promise.all([startPublishJob(input()), startPublishJob(input())]);

  assert.equal(database.jobs.size, 1);
  assert.deepEqual(results.map((result) => result.replay).sort(), [false, true]);
});

test("scopes the caller key by connection and rejects a changed payload", async () => {
  const database = new FakeD1([
    { id: "zalo", provider: "zalo_personal", publish_mode: "assisted", status: "connected" },
    { id: "zalo-2", provider: "zalo_personal", publish_mode: "assisted", status: "connected" },
  ]);
  const { startPublishJob } = await loadPublishJobs(database);

  await startPublishJob(input());
  await startPublishJob(input({ connectionId: "zalo-2" }));
  assert.equal(database.jobs.size, 2);
  await assert.rejects(
    startPublishJob(input({ payload: { message: "Nội dung khác", mediaIds: ["media-1"] } })),
    /IDEMPOTENCY_KEY_IN_USE/,
  );
});

test("requires the expected Zalo provider and assisted mode", async () => {
  const database = new FakeD1([
    { id: "facebook", provider: "facebook", publish_mode: "api", status: "connected" },
  ]);
  const { startPublishJob } = await loadPublishJobs(database);

  await assert.rejects(
    startPublishJob(input({ connectionId: "facebook" })),
    /CONNECTION_NOT_FOUND/,
  );
});
