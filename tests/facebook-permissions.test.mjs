import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const workspaceId = "workspace-facebook-test";
const requiredScopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

async function loadPermissions({ database, fetchImpl, decryptImpl, env = {} } = {}) {
  const source = await readFile(new URL("../lib/integrations/facebook-permissions.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const runtime = {
    DB: database,
    META_APP_ID: "meta-app-id",
    META_APP_SECRET: "meta-app-secret",
    META_GRAPH_API_VERSION: "v26.0",
    ...env,
  };
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    AbortSignal,
    Date,
    JSON,
    URL,
    console,
    fetch: fetchImpl ?? (async () => { throw new Error("Unexpected fetch"); }),
    require(specifier) {
      if (specifier === "./crypto") {
        return { decryptCredentials: decryptImpl ?? (async () => ({ accessToken: "page-token" })) };
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
  new vm.Script(compiled, { filename: "facebook-permissions.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

function tokenData(overrides = {}) {
  return {
    is_valid: true,
    app_id: "meta-app-id",
    type: "PAGE",
    profile_id: "page-123",
    scopes: requiredScopes,
    granular_scopes: requiredScopes.map((scope) => ({ scope, target_ids: ["page-123"] })),
    ...overrides,
  };
}

test("checks the actual Page token with the app token and accepts exact grants", async () => {
  let captured;
  const api = await loadPermissions({
    fetchImpl: async (url, init) => {
      captured = { url: new URL(url), init };
      return Response.json({ data: tokenData() });
    },
  });

  const result = await api.inspectFacebookPageToken({
    pageId: "page-123",
    pageToken: "private-page-token",
    tasks: ["CREATE_CONTENT"],
  });

  assert.equal(result.ready, true);
  assert.deepEqual(Array.from(result.grantedScopes), requiredScopes);
  assert.equal(captured.url.pathname, "/v26.0/debug_token");
  assert.equal(captured.url.searchParams.get("input_token"), "private-page-token");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers.authorization, "Bearer meta-app-id|meta-app-secret");
  assert.doesNotMatch(JSON.stringify(result), /private-page-token|meta-app-secret/);
});

test("reports actual missing scopes instead of trusting configured scope names", async () => {
  const api = await loadPermissions({
    fetchImpl: async () => Response.json({ data: tokenData({
      scopes: ["pages_show_list"],
      granular_scopes: [{ scope: "pages_show_list", target_ids: ["page-123"] }],
    }) }),
  });
  const result = await api.inspectFacebookPageToken({
    pageId: "page-123",
    pageToken: "private-page-token",
    tasks: ["CREATE_CONTENT"],
  });

  assert.equal(result.ready, false);
  assert.equal(result.code, "FACEBOOK_SCOPES_MISSING");
  assert.deepEqual(Array.from(result.missingScopes), ["pages_read_engagement", "pages_manage_posts"]);
  assert.match(result.message, /kết nối lại Facebook/i);
  assert.doesNotMatch(JSON.stringify(result), /private-page-token/);
});

test("rejects app, Page, and granular Page-target mismatches", async (t) => {
  for (const scenario of [
    { name: "app", data: tokenData({ app_id: "other-app" }), code: "FACEBOOK_APP_MISMATCH" },
    { name: "Page", data: tokenData({ profile_id: "other-page" }), code: "FACEBOOK_PAGE_MISMATCH" },
    {
      name: "granular target",
      data: tokenData({ granular_scopes: [
        { scope: "pages_show_list", target_ids: ["page-123"] },
        { scope: "pages_read_engagement", target_ids: ["page-123"] },
        { scope: "pages_manage_posts", target_ids: ["other-page"] },
      ] }),
      code: "FACEBOOK_SCOPES_MISSING",
      missingScopes: ["pages_manage_posts"],
    },
  ]) {
    await t.test(scenario.name, async () => {
      const api = await loadPermissions({ fetchImpl: async () => Response.json({ data: scenario.data }) });
      const result = await api.inspectFacebookPageToken({
        pageId: "page-123",
        pageToken: "page-token",
        tasks: ["CREATE_CONTENT"],
      });
      assert.equal(result.ready, false);
      assert.equal(result.code, scenario.code);
      if (scenario.missingScopes) assert.deepEqual(Array.from(result.missingScopes), scenario.missingScopes);
    });
  }
});

class FakeFacebookDatabase {
  constructor(row) {
    this.row = { ...row };
    this.updateAttempts = 0;
  }

  prepare(sql) {
    if (sql.startsWith("UPDATE channel_connections")) this.lastUpdateSql = sql;
    return {
      bind: (...values) => ({
        first: async () => {
          const [id, requestedWorkspace] = values;
          if (id !== this.row.id || requestedWorkspace !== workspaceId) return null;
          if (!["connected", "error", "expired"].includes(this.row.status)) return null;
          return { ...this.row };
        },
        run: async () => {
          this.updateAttempts += 1;
          const [status, scopesJson, verificationJson, lastVerifiedAt, updatedAt, lastError,
            id, requestedWorkspace, expectedCiphertext, expectedIv] = values;
          const matches = id === this.row.id
            && requestedWorkspace === workspaceId
            && ["connected", "error", "expired"].includes(this.row.status)
            && expectedCiphertext === this.row.auth_ciphertext
            && expectedIv === this.row.auth_iv;
          if (matches) {
            let config = {};
            try { config = JSON.parse(this.row.config_json); } catch { /* replace invalid config */ }
            config.facebookPermissionVerification = JSON.parse(verificationJson);
            Object.assign(this.row, {
              status,
              scopes_json: scopesJson,
              config_json: JSON.stringify(config),
              last_verified_at: lastVerifiedAt,
              updated_at: updatedAt,
              last_error: lastError,
            });
          }
          return { success: true, meta: { changes: matches ? 1 : 0 } };
        },
      }),
    };
  }
}

function connectionRow(overrides = {}) {
  return {
    id: "facebook-connection",
    external_account_id: "page-123",
    status: "connected",
    config_json: JSON.stringify({ tasks: ["CREATE_CONTENT"], legacy: true }),
    auth_ciphertext: "cipher-old",
    auth_iv: "iv-old",
    ...overrides,
  };
}

test("verification marks a legacy connection non-publishable and stores actual grants", async () => {
  const database = new FakeFacebookDatabase(connectionRow());
  const api = await loadPermissions({
    database,
    fetchImpl: async () => Response.json({ data: tokenData({ scopes: ["pages_show_list"], granular_scopes: [] }) }),
  });
  const result = await api.verifyFacebookConnection("facebook-connection");

  assert.equal(result.ready, false);
  assert.equal(result.code, "FACEBOOK_SCOPES_MISSING");
  assert.deepEqual(Array.from(result.missingScopes), ["pages_read_engagement", "pages_manage_posts"]);
  assert.equal(database.row.status, "error");
  assert.deepEqual(JSON.parse(database.row.scopes_json), ["pages_show_list"]);
  assert.match(database.row.last_error, /pages_read_engagement/);
  const config = JSON.parse(database.row.config_json);
  assert.equal(config.legacy, true);
  assert.equal(config.facebookPermissionVerification.ready, false);
  assert.match(database.lastUpdateSql, /config_json = json_set/);
});

test("verification result cannot overwrite a concurrent reconnect", async () => {
  const database = new FakeFacebookDatabase(connectionRow());
  const api = await loadPermissions({
    database,
    fetchImpl: async () => {
      database.row.auth_ciphertext = "cipher-new";
      database.row.auth_iv = "iv-new";
      database.row.status = "connected";
      return Response.json({ data: tokenData() });
    },
  });
  const result = await api.verifyFacebookConnection("facebook-connection");

  assert.equal(result.ready, false);
  assert.equal(result.code, "FACEBOOK_CONNECTION_CHANGED");
  assert.equal(database.row.status, "connected");
  assert.equal(database.row.auth_ciphertext, "cipher-new");
  assert.equal(database.row.last_error, undefined);
  assert.equal(database.updateAttempts, 1);
});

test("transient debug failure does not downgrade a connection", async () => {
  const database = new FakeFacebookDatabase(connectionRow());
  const api = await loadPermissions({
    database,
    fetchImpl: async () => { throw new Error("temporary network failure"); },
  });
  const result = await api.verifyFacebookConnection("facebook-connection");

  assert.equal(result.ready, false);
  assert.equal(result.code, "FACEBOOK_VERIFICATION_UNAVAILABLE");
  assert.equal(database.row.status, "connected");
  assert.equal(database.updateAttempts, 0);
});

test("verification never reactivates disabled or revoked connections", async () => {
  for (const status of ["disabled", "revoked"]) {
    const database = new FakeFacebookDatabase(connectionRow({ status }));
    let fetched = false;
    const api = await loadPermissions({
      database,
      fetchImpl: async () => { fetched = true; return Response.json({ data: tokenData() }); },
    });
    await assert.rejects(
      api.verifyFacebookConnection("facebook-connection"),
      (error) => error.code === "FACEBOOK_REAUTH_REQUIRED" && error.status === 404,
    );
    assert.equal(fetched, false);
    assert.equal(database.updateAttempts, 0);
    assert.equal(database.row.status, status);
  }
});

async function loadVerifyRoute({ operator = true, verifyImpl } = {}) {
  const source = await readFile(new URL("../app/api/integrations/facebook/verify/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  class FacebookPermissionCheckError extends Error {
    constructor(code, userMessage, status = 502) { super(code); this.code = code; this.userMessage = userMessage; this.status = status; }
  }
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    Array,
    JSON,
    Response,
    TextEncoder,
    require(specifier) {
      if (specifier === "../../../../../lib/api") {
        return {
          ok: (data, init) => Response.json({ data }, { status: 200, ...init }),
          fail: (code, message, status = 400) => Response.json({ error: { code, message } }, { status }),
        };
      }
      if (specifier === "../../../../../lib/integrations/facebook-permissions") {
        return {
          FacebookPermissionCheckError,
          verifyFacebookConnection: verifyImpl ?? (async () => ({ ready: true })),
        };
      }
      if (specifier === "../../../../../lib/operator-auth") return { isOperatorRequest: () => operator };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "facebook-verify-route.cjs" }).runInContext(context);
  return commonJsModule.exports;
}

test("Facebook verification route authenticates before reading or checking a connection", async () => {
  let calls = 0;
  const route = await loadVerifyRoute({ operator: false, verifyImpl: async () => { calls += 1; return { ready: true }; } });
  const response = await route.POST(new Request("https://app.example.com/api/integrations/facebook/verify", { method: "POST" }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  assert.equal(calls, 0);
});

test("Facebook verification route returns the verifier contract and validates JSON objects", async () => {
  const calls = [];
  const result = { ready: false, code: "FACEBOOK_SCOPES_MISSING", message: "Hãy kết nối lại Facebook.", missingScopes: ["pages_manage_posts"] };
  const route = await loadVerifyRoute({ verifyImpl: async (connectionId) => { calls.push(connectionId); return result; } });
  const response = await route.POST(new Request("https://app.example.com/api/integrations/facebook/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId: "facebook-connection" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, result);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls, ["facebook-connection"]);

  const invalid = await route.POST(new Request("https://app.example.com/api/integrations/facebook/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_JSON");
  assert.equal(calls.length, 1);
});

test("Facebook verification route enforces actual body bytes without relying on Content-Length", async () => {
  let calls = 0;
  const route = await loadVerifyRoute({ verifyImpl: async () => { calls += 1; return { ready: true }; } });
  const response = await route.POST(new Request("https://app.example.com/api/integrations/facebook/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId: "x".repeat(5_000) }),
  }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "REQUEST_TOO_LARGE");
  assert.equal(calls, 0);
});
