import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

class MockPublishDeliveryError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

class FakeDispatcherD1 {
  constructor({ jobs, connections }) {
    this.jobs = new Map(jobs.map((job) => [job.id, { ...job }]));
    this.connections = new Map(connections.map((connection) => [connection.id, { ...connection }]));
  }

  result(changes) {
    return { meta: { changes } };
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        all: async () => {
          if (!sql.includes("FROM publish_jobs j")) throw new Error(`Unexpected all: ${sql}`);
          if (sql.includes("c.provider = 'tiktok_shop'") && sql.includes("j.external_post_id IS NOT NULL")) {
            const [limit] = values;
            const rows = [...this.jobs.values()]
              .filter((job) => {
                const connection = this.connections.get(job.connection_id);
                return connection?.provider === "tiktok_shop"
                  && job.product_id
                  && job.external_post_id
                  && ["blocked", "published"].includes(job.status)
                  && !job.mapping_recorded;
              })
              .sort((left, right) => left.updated_at - right.updated_at)
              .slice(0, limit);
            return { results: rows };
          }
          const [now, , limit] = values;
          const rows = [...this.jobs.values()]
            .filter((job) => ["queued", "retry_wait"].includes(job.status) && job.available_at <= now)
            .sort((left, right) => left.available_at - right.available_at)
            .slice(0, limit)
            .flatMap((job) => {
              const connection = this.connections.get(job.connection_id);
              if (!connection) return [];
              return [{
                ...job,
                provider: connection.provider,
                connection_status: connection.status,
                publish_mode: connection.publish_mode,
              }];
            });
          return { results: rows };
        },
        first: async () => {
          if (sql.includes("attempt_count = attempt_count + 1")) {
            const [workerId, leaseExpiresAt, startedAt, updatedAt, id, workspaceId, availableAt] = values;
            const job = this.jobs.get(id);
            if (
              !job
              || job.workspace_id !== workspaceId
              || !["queued", "retry_wait"].includes(job.status)
              || job.available_at > availableAt
            ) return null;
            job.status = "publishing";
            job.attempt_count += 1;
            job.lease_owner = workerId;
            job.lease_expires_at = leaseExpiresAt;
            job.started_at ??= startedAt;
            job.updated_at = updatedAt;
            return { attempt_count: job.attempt_count, max_attempts: job.max_attempts };
          }

          if (sql.includes("SET status = 'published'")) {
            const [externalId, externalUrl, providerResponse, completedAt, updatedAt, id, workspaceId, workerId] = values;
            const job = this.jobs.get(id);
            if (!job || job.workspace_id !== workspaceId || job.status !== "publishing" || job.lease_owner !== workerId) return null;
            Object.assign(job, {
              status: "published",
              external_post_id: externalId,
              external_url: externalUrl,
              provider_response_json: providerResponse,
              lease_owner: null,
              lease_expires_at: null,
              completed_at: completedAt,
              updated_at: updatedAt,
            });
            return { id };
          }

          throw new Error(`Unexpected first: ${sql}`);
        },
        run: async () => {
          if (sql.includes("mapped.external_id = publish_jobs.external_post_id")) {
            const [completedAt, updatedAt] = values;
            let changes = 0;
            for (const job of this.jobs.values()) {
              const connection = this.connections.get(job.connection_id);
              if (
                job.status !== "blocked"
                || !job.product_id
                || !job.external_post_id
                || connection?.provider !== "tiktok_shop"
                || !job.mapping_recorded
              ) continue;
              Object.assign(job, {
                status: "published",
                error_code: null,
                error_message: null,
                completed_at: job.completed_at ?? completedAt,
                updated_at: updatedAt,
              });
              changes += 1;
            }
            return this.result(changes);
          }

          if (sql.includes("LEASE_EXPIRED_RETRY")) {
            const [availableAt, updatedAt, expiresAt] = values;
            let changes = 0;
            for (const job of this.jobs.values()) {
              const connection = this.connections.get(job.connection_id);
              if (job.status !== "publishing" || job.lease_expires_at == null || job.lease_expires_at > expiresAt || connection?.provider !== "website") continue;
              Object.assign(job, {
                status: "retry_wait",
                available_at: availableAt,
                lease_owner: null,
                lease_expires_at: null,
                error_code: "LEASE_EXPIRED_RETRY",
                updated_at: updatedAt,
              });
              changes += 1;
            }
            return this.result(changes);
          }

          if (
            sql.includes("error_code = 'DELIVERY_OUTCOME_UNKNOWN'")
            && sql.includes("WHERE status = 'publishing' AND lease_expires_at")
          ) {
            const [updatedAt, expiresAt] = values;
            let changes = 0;
            for (const job of this.jobs.values()) {
              if (job.status !== "publishing" || job.lease_expires_at == null || job.lease_expires_at > expiresAt) continue;
              Object.assign(job, {
                status: "blocked",
                lease_owner: null,
                lease_expires_at: null,
                error_code: "DELIVERY_OUTCOME_UNKNOWN",
                updated_at: updatedAt,
              });
              changes += 1;
            }
            return this.result(changes);
          }

          if (sql.includes("completed_at = COALESCE(completed_at")) {
            const [completedAt, updatedAt, id, workspaceId, externalId] = values;
            const job = this.jobs.get(id);
            if (
              !job
              || job.workspace_id !== workspaceId
              || job.external_post_id !== externalId
              || !["blocked", "published"].includes(job.status)
            ) return this.result(0);
            Object.assign(job, {
              status: "published",
              error_code: null,
              error_message: null,
              completed_at: job.completed_at ?? completedAt,
              updated_at: updatedAt,
              mapping_recorded: true,
            });
            return this.result(1);
          }

          if (sql.includes("error_code = 'TIKTOK_MAPPING_PENDING'") && sql.includes("external_post_id = ?")) {
            const [updatedAt, id, workspaceId, externalId] = values;
            const job = this.jobs.get(id);
            if (
              !job
              || job.workspace_id !== workspaceId
              || job.external_post_id !== externalId
              || !["blocked", "published"].includes(job.status)
            ) return this.result(0);
            Object.assign(job, {
              status: "blocked",
              error_code: "TIKTOK_MAPPING_PENDING",
              updated_at: updatedAt,
            });
            return this.result(1);
          }

          if (sql.includes("UPDATE publish_jobs SET external_post_id = ?")) {
            const [externalId, externalUrl, providerResponse, updatedAt, id, workspaceId, workerId] = values;
            const job = this.jobs.get(id);
            if (
              !job
              || job.workspace_id !== workspaceId
              || !(
                (job.status === "publishing" && job.lease_owner === workerId)
                || (job.status === "blocked" && job.error_code === "DELIVERY_OUTCOME_UNKNOWN" && !job.external_post_id)
              )
            ) return this.result(0);
            Object.assign(job, {
              external_post_id: externalId,
              external_url: externalUrl,
              provider_response_json: providerResponse,
              updated_at: updatedAt,
            });
            return this.result(1);
          }

          if (sql.includes("external_post_id = ?") && sql.includes("provider_response_json = ?")) {
            const [
              externalId,
              externalUrl,
              providerResponse,
              errorCode,
              errorMessage,
              updatedAt,
              id,
              workspaceId,
              workerId,
              recoveredExternalId,
            ] = values;
            const job = this.jobs.get(id);
            if (
              !job
              || job.workspace_id !== workspaceId
              || !(
                (job.status === "publishing" && job.lease_owner === workerId)
                || (
                  job.status === "blocked"
                  && job.error_code === "DELIVERY_OUTCOME_UNKNOWN"
                  && job.external_post_id === recoveredExternalId
                )
              )
            ) return this.result(0);
            Object.assign(job, {
              status: "blocked",
              external_post_id: externalId,
              external_url: externalUrl,
              provider_response_json: providerResponse,
              error_code: errorCode,
              error_message: errorMessage,
              lease_owner: null,
              lease_expires_at: null,
              completed_at: null,
              updated_at: updatedAt,
            });
            return this.result(1);
          }

          if (sql.includes("SET status = 'blocked'")) {
            const [errorCode, errorMessage, updatedAt, id, workspaceId, workerId] = values;
            const job = this.jobs.get(id);
            if (!job || job.workspace_id !== workspaceId || job.status !== "publishing" || job.lease_owner !== workerId) return this.result(0);
            Object.assign(job, {
              status: "blocked",
              error_code: errorCode,
              error_message: errorMessage,
              lease_owner: null,
              lease_expires_at: null,
              updated_at: updatedAt,
            });
            return this.result(1);
          }

          if (sql.includes("SET status = 'retry_wait'")) {
            const [availableAt, errorCode, errorMessage, updatedAt, id, workspaceId, workerId] = values;
            const job = this.jobs.get(id);
            if (!job || job.workspace_id !== workspaceId || job.status !== "publishing" || job.lease_owner !== workerId) return this.result(0);
            Object.assign(job, {
              status: "retry_wait",
              available_at: availableAt,
              error_code: errorCode,
              error_message: errorMessage,
              lease_owner: null,
              lease_expires_at: null,
              updated_at: updatedAt,
            });
            return this.result(1);
          }

          if (sql.includes("SET status = 'failed'")) {
            const [errorCode, errorMessage, completedAt, updatedAt, id, workspaceId, workerId] = values;
            const job = this.jobs.get(id);
            if (!job || job.workspace_id !== workspaceId || job.status !== "publishing" || job.lease_owner !== workerId) return this.result(0);
            Object.assign(job, {
              status: "failed",
              error_code: errorCode,
              error_message: errorMessage,
              completed_at: completedAt,
              lease_owner: null,
              lease_expires_at: null,
              updated_at: updatedAt,
            });
            return this.result(1);
          }

          throw new Error(`Unexpected run: ${sql}`);
        },
      }),
    };
  }
}

async function loadDispatcher() {
  const source = await readFile(new URL("../lib/dispatcher.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    crypto: webcrypto,
    console,
    require(specifier) {
      if (specifier === "./integrations/env") return { getRuntimeEnv: () => ({}) };
      if (specifier === "./publishing") {
        return {
          PublishDeliveryError: MockPublishDeliveryError,
          sendFacebookPost: async () => { throw new Error("not injected"); },
          sendWebsitePayload: async () => { throw new Error("not injected"); },
          recordFacebookMapping: async () => true,
        };
      }
      if (specifier === "./tiktok-shop-publishing") {
        return {
          sendTikTokShopListing: async () => { throw new Error("not injected"); },
          recordTikTokShopMappings: async () => true,
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "dispatcher.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function connection(id, provider) {
  return { id, provider, status: "connected", publish_mode: "api" };
}

function job(id, connectionId, overrides = {}) {
  return {
    id,
    workspace_id: "workspace-test",
    connection_id: connectionId,
    product_id: null,
    draft_id: null,
    job_kind: "social_post",
    dedupe_key: `schedule:${id}:1000`,
    payload_snapshot_json: JSON.stringify({ message: `Bài ${id}`, mediaIds: [] }),
    status: "queued",
    scheduled_for: 1_000,
    available_at: 1_000,
    attempt_count: 0,
    max_attempts: 5,
    provider_response_json: "{}",
    external_post_id: null,
    external_url: null,
    error_code: null,
    lease_owner: null,
    lease_expires_at: null,
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}

function publishers(overrides = {}) {
  return {
    facebook: async () => ({ externalId: "fb-1", externalUrl: "https://facebook.test/fb-1", providerResponse: {} }),
    website: async () => ({ externalId: "web-1", externalUrl: "https://shop.test/web-1", providerResponse: {} }),
    recordFacebook: async () => true,
    tiktokShop: async () => ({ externalId: "tts-1", externalUrl: null, providerResponse: {} }),
    recordTikTokShop: async () => true,
    ...overrides,
  };
}

test("a conditional lease lets concurrent dispatchers publish a job once", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("one", "facebook")],
    connections: [connection("facebook", "facebook")],
  });
  let calls = 0;
  const configured = publishers({
    facebook: async () => {
      calls += 1;
      await Promise.resolve();
      return { externalId: "fb-1", externalUrl: "https://facebook.test/fb-1", providerResponse: {} };
    },
  });

  await Promise.all([
    runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker-a" }),
    runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker-b" }),
  ]);

  assert.equal(calls, 1);
  assert.equal(database.jobs.get("one").status, "published");
  assert.equal(database.jobs.get("one").attempt_count, 1);
});

test("retries a temporary failure with bounded backoff then publishes", async () => {
  const { retryDelayMs, runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("retry", "facebook")],
    connections: [connection("facebook", "facebook")],
  });
  let calls = 0;
  const configured = publishers({
    facebook: async () => {
      calls += 1;
      if (calls === 1) throw new MockPublishDeliveryError("FACEBOOK_API_429", { retryable: true });
      return { externalId: "fb-retry", externalUrl: "https://facebook.test/fb-retry", providerResponse: {} };
    },
  });

  await runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker-a" });
  const waiting = database.jobs.get("retry");
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.available_at, 2_000 + retryDelayMs(1));

  await runPublishDispatcher({ database, publishers: configured, now: waiting.available_at, workerId: "worker-b" });
  assert.equal(database.jobs.get("retry").status, "published");
  assert.equal(database.jobs.get("retry").attempt_count, 2);
});

test("dispatches TikTok product drafts, blocks Shopee, and never touches Zalo confirmation jobs", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [
      job("shop", "shopee", { job_kind: "listing_upsert" }),
      job("tiktok", "tiktok", {
        job_kind: "listing_upsert",
        product_id: "product-1",
        payload_snapshot_json: JSON.stringify({
          mediaIds: ["media-1"],
          platformData: { tiktokShop: { saveMode: "AS_DRAFT" } },
          productSnapshot: {
            id: "product-1",
            name: "Giày thể thao TAHA chính hãng",
            description: "Mô tả listing đã duyệt.",
            currency: "VND",
            variants: [{
              id: "variant-1",
              sku: "TAHA-001",
              priceMinor: 490000,
              inventoryQuantity: 12,
            }],
          },
        }),
      }),
      job("zalo", "zalo", { status: "awaiting_confirmation" }),
    ],
    connections: [
      connection("shopee", "shopee"),
      connection("tiktok", "tiktok_shop"),
      { ...connection("zalo", "zalo_personal"), publish_mode: "assisted" },
    ],
  });
  let sentInput = null;
  let mappedInput = null;
  const configured = publishers({
    tiktokShop: async (input) => {
      sentInput = input;
      return {
        externalId: "tts-product-1",
        externalUrl: null,
        providerResponse: { operation: "created", saveMode: "AS_DRAFT" },
      };
    },
    recordTikTokShop: async (input) => {
      assert.equal(database.jobs.get("tiktok").status, "publishing", "mapping must be durable before the job is published");
      assert.equal(database.jobs.get("tiktok").external_post_id, "tts-product-1", "remote receipt must be durable before mapping");
      mappedInput = input;
      return true;
    },
  });

  const result = await runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker" });
  assert.equal(result.blocked, 1, JSON.stringify({ result, tiktok: database.jobs.get("tiktok") }));
  assert.equal(result.published, 1);
  assert.equal(database.jobs.get("shop").status, "blocked");
  assert.equal(database.jobs.get("shop").error_code, "COMMERCE_PUBLISH_NOT_IMPLEMENTED");
  assert.equal(database.jobs.get("tiktok").status, "published");
  assert.equal(sentInput.productId, "product-1");
  assert.equal(sentInput.workerId, "worker");
  assert.equal(Object.keys(sentInput.progress).length, 0);
  assert.equal(sentInput.externalId, null);
  assert.equal(sentInput.payload.platformData.tiktokShop.saveMode, "AS_DRAFT");
  assert.equal(mappedInput.externalId, "tts-product-1");
  assert.equal(mappedInput.payload.productSnapshot.variants[0].sku, "TAHA-001");
  assert.equal(database.jobs.get("zalo").status, "awaiting_confirmation");
});

test("durably blocks a TikTok mapping failure and reconciles it without resending", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("tiktok-mapping", "tiktok", {
      job_kind: "listing_upsert",
      product_id: "product-1",
      payload_snapshot_json: JSON.stringify({
        mediaIds: ["media-1"],
        productSnapshot: {
          id: "product-1",
          name: "Giày thể thao TAHA chính hãng",
          description: "Mô tả listing đã duyệt.",
          currency: "VND",
          variants: [{ id: "variant-1", sku: "TAHA-001", priceMinor: 490000, inventoryQuantity: 12 }],
        },
      }),
    })],
    connections: [connection("tiktok", "tiktok_shop")],
  });
  let sendCalls = 0;
  let mappingCalls = 0;
  const configured = publishers({
    tiktokShop: async () => {
      sendCalls += 1;
      return {
        externalId: "tts-product-1",
        externalUrl: null,
        providerResponse: {
          operation: "created",
          skus: [{ id: "tts-sku-1", externalSkuId: "variant-1" }],
        },
      };
    },
    recordTikTokShop: async () => {
      mappingCalls += 1;
      return mappingCalls > 1;
    },
  });

  const first = await runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker-a" });
  const pending = database.jobs.get("tiktok-mapping");
  assert.equal(sendCalls, 1);
  assert.equal(mappingCalls, 1);
  assert.equal(first.published, 0);
  assert.equal(first.blocked, 1, JSON.stringify({ first, pending }));
  assert.equal(pending.status, "blocked");
  assert.equal(pending.error_code, "TIKTOK_MAPPING_PENDING");
  assert.equal(pending.external_post_id, "tts-product-1");
  assert.equal(JSON.parse(pending.provider_response_json).operation, "created");

  const second = await runPublishDispatcher({ database, publishers: configured, now: 3_000, workerId: "worker-b" });
  assert.equal(sendCalls, 1, "reconciliation must never call Create Product again");
  assert.equal(mappingCalls, 2);
  assert.equal(second.reconciledMappings, 1);
  assert.equal(database.jobs.get("tiktok-mapping").status, "published");
  assert.equal(database.jobs.get("tiktok-mapping").error_code, null);
  assert.equal(database.jobs.get("tiktok-mapping").completed_at, 3_000);
});

test("keeps the TikTok receipt reconcilable when lease recovery races remote acceptance", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("tiktok-lease-race", "tiktok", {
      job_kind: "listing_upsert",
      product_id: "product-1",
      payload_snapshot_json: JSON.stringify({
        mediaIds: ["media-1"],
        productSnapshot: {
          id: "product-1",
          name: "Giày thể thao TAHA chính hãng",
          description: "Mô tả listing đã duyệt.",
          currency: "VND",
          variants: [{ id: "variant-1", sku: "TAHA-001", priceMinor: 490000, inventoryQuantity: 12 }],
        },
      }),
    })],
    connections: [connection("tiktok", "tiktok_shop")],
  });
  let sendCalls = 0;
  let mappingCalls = 0;
  const configured = publishers({
    tiktokShop: async () => {
      sendCalls += 1;
      Object.assign(database.jobs.get("tiktok-lease-race"), {
        status: "blocked",
        lease_owner: null,
        lease_expires_at: null,
        error_code: "DELIVERY_OUTCOME_UNKNOWN",
      });
      return {
        externalId: "tts-product-race",
        externalUrl: null,
        providerResponse: {
          operation: "created",
          skus: [{ id: "tts-sku-race", externalSkuId: "variant-1" }],
        },
      };
    },
    recordTikTokShop: async () => {
      mappingCalls += 1;
      return mappingCalls > 1;
    },
  });

  const first = await runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker-a" });
  const pending = database.jobs.get("tiktok-lease-race");
  assert.equal(sendCalls, 1);
  assert.equal(mappingCalls, 1);
  assert.equal(first.blocked, 1);
  assert.equal(pending.status, "blocked");
  assert.equal(pending.error_code, "TIKTOK_MAPPING_PENDING");
  assert.equal(pending.external_post_id, "tts-product-race");

  const second = await runPublishDispatcher({ database, publishers: configured, now: 3_000, workerId: "worker-b" });
  assert.equal(sendCalls, 1, "lease recovery reconciliation must not resend Create Product");
  assert.equal(mappingCalls, 2);
  assert.equal(second.reconciledMappings, 1);
  assert.equal(database.jobs.get("tiktok-lease-race").status, "published");
});

test("finalizes a blocked TikTok job when its matching mapping was already committed", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("tiktok-confirmation", "tiktok", {
      job_kind: "listing_upsert",
      product_id: "product-1",
      status: "blocked",
      external_post_id: "tts-product-1",
      error_code: "LOCAL_CONFIRMATION_FAILED",
      mapping_recorded: true,
    })],
    connections: [connection("tiktok", "tiktok_shop")],
  });
  let remoteCalls = 0;
  let mappingCalls = 0;
  const configured = publishers({
    tiktokShop: async () => { remoteCalls += 1; throw new Error("must not resend"); },
    recordTikTokShop: async () => { mappingCalls += 1; return true; },
  });

  const result = await runPublishDispatcher({ database, publishers: configured, now: 4_000, workerId: "worker" });
  assert.equal(remoteCalls, 0);
  assert.equal(mappingCalls, 0);
  assert.equal(result.reconciledMappings, 1);
  assert.equal(database.jobs.get("tiktok-confirmation").status, "published");
  assert.equal(database.jobs.get("tiktok-confirmation").error_code, null);
});

test("reconciles a persisted TikTok receipt recovered as an unknown delivery outcome", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("tiktok-recovered-receipt", "tiktok", {
      job_kind: "listing_upsert",
      product_id: "product-1",
      status: "blocked",
      external_post_id: "tts-product-recovered",
      error_code: "DELIVERY_OUTCOME_UNKNOWN",
      provider_response_json: JSON.stringify({ operation: "created", skus: [] }),
      payload_snapshot_json: JSON.stringify({
        productSnapshot: {
          id: "product-1",
          name: "Giày TAHA",
          description: "Mô tả listing đã duyệt.",
          currency: "VND",
          variants: [{ id: "variant-1", sku: "TAHA-001", priceMinor: 490000, inventoryQuantity: 12 }],
        },
      }),
    })],
    connections: [connection("tiktok", "tiktok_shop")],
  });
  let sendCalls = 0;
  let mappingCalls = 0;
  const configured = publishers({
    tiktokShop: async () => { sendCalls += 1; throw new Error("must not resend"); },
    recordTikTokShop: async () => { mappingCalls += 1; return true; },
  });

  const result = await runPublishDispatcher({ database, publishers: configured, now: 4_000, workerId: "worker" });
  assert.equal(sendCalls, 0);
  assert.equal(mappingCalls, 1);
  assert.equal(result.reconciledMappings, 1);
  assert.equal(database.jobs.get("tiktok-recovered-receipt").status, "published");
  assert.equal(database.jobs.get("tiktok-recovered-receipt").error_code, null);
});

test("blocks a TikTok listing missing operator configuration without retrying", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [job("tiktok-config", "tiktok", {
      job_kind: "listing_upsert",
      product_id: "product-1",
    })],
    connections: [connection("tiktok", "tiktok_shop")],
  });
  const configured = publishers({
    tiktokShop: async () => {
      throw new MockPublishDeliveryError("TIKTOK_CATEGORY_REQUIRED");
    },
  });

  const result = await runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker" });
  assert.equal(result.blocked, 1);
  assert.equal(result.retrying, 0);
  assert.equal(database.jobs.get("tiktok-config").status, "blocked");
  assert.equal(database.jobs.get("tiktok-config").error_code, "TIKTOK_CATEGORY_REQUIRED");
});

test("recovers website leases with idempotent retry but blocks uncertain Facebook leases", async () => {
  const { runPublishDispatcher } = await loadDispatcher();
  const database = new FakeDispatcherD1({
    jobs: [
      job("website-crash", "website", { status: "publishing", lease_owner: "dead", lease_expires_at: 1_500 }),
      job("facebook-crash", "facebook", { status: "publishing", lease_owner: "dead", lease_expires_at: 1_500 }),
    ],
    connections: [connection("website", "website"), connection("facebook", "facebook")],
  });
  let websiteCalls = 0;
  const configured = publishers({
    website: async () => {
      websiteCalls += 1;
      return { externalId: "web", externalUrl: "https://shop.test/web", providerResponse: {} };
    },
  });

  const result = await runPublishDispatcher({ database, publishers: configured, now: 2_000, workerId: "worker" });
  assert.equal(result.recoveredRetrying, 1);
  assert.equal(result.recoveredBlocked, 1);
  assert.equal(websiteCalls, 1);
  assert.equal(database.jobs.get("website-crash").status, "published");
  assert.equal(database.jobs.get("facebook-crash").status, "blocked");
});
