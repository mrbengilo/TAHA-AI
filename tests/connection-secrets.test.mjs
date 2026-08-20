import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const workspaceId = "workspace-test";
const fixedNow = 1_800_000_000_000;

class FakeD1 {
  constructor(changes = 1) {
    this.changes = changes;
    this.updates = [];
  }

  prepare(sql) {
    assert.match(sql, /^UPDATE channel_connections SET/);
    return {
      bind: (...values) => ({
        run: async () => {
          this.updates.push({ sql, values });
          return { success: true, meta: { changes: this.changes } };
        },
      }),
    };
  }
}

async function loadConnectionSecrets({ database = new FakeD1(), fetchImpl, env = {} } = {}) {
  const source = await readFile(new URL("../lib/integrations/connection-secrets.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const encryptCalls = [];
  const commonJsModule = { exports: {} };
  class FixedDate extends Date {
    static now() { return fixedNow; }
  }
  const runtime = { DB: database, ...env };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    AbortSignal,
    Date: FixedDate,
    URL,
    URLSearchParams,
    console,
    crypto: webcrypto,
    fetch: fetchImpl ?? (async () => { throw new Error("Unexpected fetch"); }),
    require(specifier) {
      if (specifier === "./crypto") {
        return {
          decryptCredentials: async () => ({}),
          encryptCredentials: async (credentials) => {
            encryptCalls.push(structuredClone(credentials));
            return { ciphertext: `encrypted-${encryptCalls.length}`, iv: `iv-${encryptCalls.length}`, keyVersion: 1 };
          },
          hmacHex: async (secret, value) => createHmac("sha256", secret).update(value).digest("hex"),
        };
      }
      if (specifier === "./env") {
        return {
          getRuntimeEnv: () => runtime,
          requireEnv: (name) => {
            const value = runtime[name];
            if (!value) throw new Error(`Missing test env: ${name}`);
            return value;
          },
        };
      }
      if (specifier === "./store") return { TAHA_WORKSPACE_ID: workspaceId };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "connection-secrets.cjs" }).runInContext(context);
  return { api: commonJsModule.exports, database, encryptCalls };
}

function connection(provider, overrides = {}) {
  return {
    id: `${provider}-connection`,
    provider,
    displayName: provider,
    externalAccountId: provider === "shopee" ? "987654" : "seller-open-id",
    status: "connected",
    config: provider === "shopee" ? { shopId: "987654" } : {},
    tokenExpiresAt: fixedNow - 1,
    credentials: { accessToken: "old-access", refreshToken: "old-refresh", preserved: "value" },
    ...overrides,
  };
}

test("returns a still-valid commerce access token without refreshing", async () => {
  const { api, database, encryptCalls } = await loadConnectionSecrets();
  const shopee = connection("shopee", { tokenExpiresAt: fixedNow + 10 * 60 * 1000 });

  assert.equal(await api.getShopeeAccessToken(shopee), "old-access");
  assert.equal(database.updates.length, 0);
  assert.equal(encryptCalls.length, 0);
});

test("refreshes Shopee with the official signature and persists rotated tokens once", async () => {
  const fetchCalls = [];
  const response = {
    error: "",
    access_token: "new-shopee-access",
    refresh_token: "new-shopee-refresh",
    expire_in: 14_400,
  };
  const loaded = await loadConnectionSecrets({
    env: {
      SHOPEE_BASE_URL: "https://partner.shopeemobile.com",
      SHOPEE_PARTNER_ID: "123456",
      SHOPEE_PARTNER_KEY: "partner-key",
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json(response);
    },
  });
  const shopee = connection("shopee");
  const concurrentShopee = connection("shopee");
  const [first, second] = await Promise.all([
    loaded.api.getShopeeAccessToken(shopee),
    loaded.api.getShopeeAccessToken(concurrentShopee),
  ]);

  assert.deepEqual([first, second], ["new-shopee-access", "new-shopee-access"]);
  assert.equal(fetchCalls.length, 1);
  const requestUrl = new URL(fetchCalls[0].url);
  const timestamp = String(Math.floor(fixedNow / 1000));
  const expectedSign = createHmac("sha256", "partner-key")
    .update(`123456/api/v2/auth/access_token/get${timestamp}`)
    .digest("hex");
  assert.equal(requestUrl.pathname, "/api/v2/auth/access_token/get");
  assert.equal(requestUrl.searchParams.get("partner_id"), "123456");
  assert.equal(requestUrl.searchParams.get("timestamp"), timestamp);
  assert.equal(requestUrl.searchParams.get("sign"), expectedSign);
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    refresh_token: "old-refresh",
    partner_id: 123456,
    shop_id: 987654,
  });

  assert.equal(loaded.encryptCalls.length, 1);
  assert.deepEqual(loaded.encryptCalls[0], {
    accessToken: "new-shopee-access",
    refreshToken: "new-shopee-refresh",
    preserved: "value",
  });
  assert.equal(loaded.database.updates.length, 1);
  const update = loaded.database.updates[0];
  assert.match(update.sql, /auth_ciphertext = \?, auth_iv = \?, auth_key_version = \?/);
  assert.match(update.sql, /token_expires_at = \?/);
  assert.match(update.sql, /workspace_id = \? AND provider = \? AND status = 'connected'/);
  assert.equal(update.values[3], fixedNow + 14_400 * 1000);
  assert.deepEqual(update.values.slice(6), [shopee.id, workspaceId, "shopee"]);
  assert.doesNotMatch(JSON.stringify(update.values), /new-shopee-access|new-shopee-refresh|old-refresh/);
  assert.equal(shopee.credentials.accessToken, "new-shopee-access");
  assert.equal(shopee.credentials.refreshToken, "new-shopee-refresh");
  assert.equal(concurrentShopee.credentials.accessToken, "new-shopee-access");
  assert.equal(concurrentShopee.credentials.refreshToken, "new-shopee-refresh");
});

test("refreshes TikTok Shop and normalizes Unix expiry timestamps", async () => {
  const accessExpirySeconds = Math.floor((fixedNow + 7 * 24 * 60 * 60 * 1000) / 1000);
  const refreshExpirySeconds = Math.floor((fixedNow + 30 * 24 * 60 * 60 * 1000) / 1000);
  const fetchCalls = [];
  const loaded = await loadConnectionSecrets({
    env: {
      TIKTOK_SHOP_AUTH_BASE_URL: "https://auth.tiktok-shops.com",
      TIKTOK_SHOP_APP_KEY: "app-key",
      TIKTOK_SHOP_APP_SECRET: "app-secret",
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({
        code: 0,
        message: "success",
        data: {
          access_token: "new-tiktok-access",
          refresh_token: "new-tiktok-refresh",
          access_token_expire_in: accessExpirySeconds,
          refresh_token_expire_in: refreshExpirySeconds,
        },
      });
    },
  });
  const tiktok = connection("tiktok_shop", {
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      refreshTokenExpireAt: Math.floor((fixedNow + 24 * 60 * 60 * 1000) / 1000),
      preserved: "value",
    },
  });

  assert.equal(await loaded.api.getTikTokShopAccessToken(tiktok), "new-tiktok-access");
  assert.equal(fetchCalls.length, 1);
  const requestUrl = new URL(fetchCalls[0].url);
  assert.equal(requestUrl.pathname, "/api/v2/token/refresh");
  assert.equal(requestUrl.searchParams.get("app_key"), "app-key");
  assert.equal(requestUrl.searchParams.get("app_secret"), "app-secret");
  assert.equal(requestUrl.searchParams.get("refresh_token"), "old-refresh");
  assert.equal(requestUrl.searchParams.get("grant_type"), "refresh_token");
  assert.equal(fetchCalls[0].init.method, "GET");
  assert.deepEqual(loaded.encryptCalls[0], {
    accessToken: "new-tiktok-access",
    refreshToken: "new-tiktok-refresh",
    refreshTokenExpireAt: refreshExpirySeconds * 1000,
    preserved: "value",
  });
  assert.equal(loaded.database.updates[0].values[3], accessExpirySeconds * 1000);
  assert.doesNotMatch(JSON.stringify(loaded.database.updates[0].values), /new-tiktok-access|new-tiktok-refresh|old-refresh/);
});

test("does not call TikTok when its refresh token is already expiring", async () => {
  let fetchCount = 0;
  const loaded = await loadConnectionSecrets({
    fetchImpl: async () => {
      fetchCount += 1;
      return Response.json({});
    },
  });
  const tiktok = connection("tiktok_shop", {
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      refreshTokenExpireAt: Math.floor((fixedNow + 60_000) / 1000),
    },
  });

  await assert.rejects(loaded.api.getTikTokShopAccessToken(tiktok), /TIKTOK_SHOP_REAUTH_REQUIRED/);
  assert.equal(fetchCount, 0);
  assert.equal(loaded.database.updates.length, 0);
  assert.equal(loaded.encryptCalls.length, 0);
});

test("does not expose rotated plaintext or mutate memory when atomic storage fails", async () => {
  const database = new FakeD1(0);
  const loaded = await loadConnectionSecrets({
    database,
    env: {
      SHOPEE_BASE_URL: "https://partner.shopeemobile.com",
      SHOPEE_PARTNER_ID: "123456",
      SHOPEE_PARTNER_KEY: "partner-key",
    },
    fetchImpl: async () => Response.json({
      error: "",
      access_token: "unsaved-access",
      refresh_token: "unsaved-refresh",
      expire_in: 14_400,
    }),
  });
  const shopee = connection("shopee");

  await assert.rejects(loaded.api.getShopeeAccessToken(shopee), /SHOPEE_TOKEN_STORAGE_FAILED/);
  assert.equal(shopee.credentials.accessToken, "old-access");
  assert.equal(shopee.credentials.refreshToken, "old-refresh");
  assert.doesNotMatch(JSON.stringify(database.updates[0].values), /unsaved-access|unsaved-refresh|old-refresh/);
});

test("rejects a connection passed to the wrong provider token helper", async () => {
  const { api } = await loadConnectionSecrets();
  await assert.rejects(api.getShopeeAccessToken(connection("tiktok_shop")), /CONNECTION_PROVIDER_MISMATCH/);
  await assert.rejects(api.getTikTokShopAccessToken(connection("shopee")), /CONNECTION_PROVIDER_MISMATCH/);
});
