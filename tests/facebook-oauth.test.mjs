import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadOAuth(runtimeOverrides = {}, testOverrides = {}) {
  const source = await readFile(new URL("../lib/integrations/oauth.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const runtime = {
    META_APP_ID: "meta-app-id",
    META_APP_SECRET: "meta-app-secret",
    META_LOGIN_CONFIG_ID: "meta-login-config-id",
    META_GRAPH_API_VERSION: "v26.0",
    META_REDIRECT_URI: "https://app.example.com/api/integrations/facebook/callback",
    ...runtimeOverrides,
  };
  const commonJsModule = { exports: {} };
  const upserts = [];
  const persisted = [];
  class FacebookPermissionCheckError extends Error {
    constructor(code, userMessage, status = 502) {
      super(code);
      this.code = code;
      this.userMessage = userMessage;
      this.status = status;
    }
  }
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    URL,
    URLSearchParams,
    Response,
    fetch: testOverrides.fetchImpl ?? (async () => { throw new Error("Unexpected fetch"); }),
    require(specifier) {
      if (specifier === "./crypto") {
        return {
          encryptCredentials: async () => ({ ciphertext: "encrypted-token", iv: "token-iv", keyVersion: 1 }),
          hmacHex: async () => "signature",
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
      if (specifier === "./facebook-permissions") {
        return {
          FacebookPermissionCheckError,
          inspectFacebookPageToken: testOverrides.inspectFacebookPageToken ?? (async () => ({
            ready: true,
            grantedScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
          })),
          persistFacebookPermissionState: testOverrides.persistFacebookPermissionState ?? (async (input) => {
            persisted.push(input);
            return true;
          }),
        };
      }
      if (specifier === "./providers") return { providerDefinitions: { facebook: { capabilities: ["publish"] } } };
      if (specifier === "./store") return { upsertConnection: async (input) => { upserts.push(input); return "facebook-connection"; } };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "oauth.cjs" }).runInContext(context);
  Object.assign(commonJsModule.exports, { __test: { upserts, persisted, FacebookPermissionCheckError } });
  return commonJsModule.exports;
}

test("builds a Facebook Login for Business authorization URL from config_id without scope", async () => {
  const oauth = await loadOAuth();
  const authorizationUrl = new URL(await oauth.buildAuthorizationUrl("facebook", "oauth-state"));

  assert.equal(authorizationUrl.origin, "https://www.facebook.com");
  assert.equal(authorizationUrl.pathname, "/v26.0/dialog/oauth");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "meta-app-id");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://app.example.com/api/integrations/facebook/callback");
  assert.equal(authorizationUrl.searchParams.get("config_id"), "meta-login-config-id");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("override_default_response_type"), "true");
  assert.equal(authorizationUrl.searchParams.get("state"), "oauth-state");
  assert.equal(authorizationUrl.searchParams.has("scope"), false);
});

test("requires a Facebook Login for Business configuration ID", async () => {
  const oauth = await loadOAuth({ META_LOGIN_CONFIG_ID: "" });
  await assert.rejects(
    oauth.buildAuthorizationUrl("facebook", "oauth-state"),
    /Missing test env: META_LOGIN_CONFIG_ID/,
  );
});

function facebookFetch() {
  return async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/oauth/access_token")) {
      return Response.json({ access_token: url.searchParams.has("fb_exchange_token") ? "long-user-token" : "short-user-token" });
    }
    if (url.pathname.endsWith("/me/accounts")) {
      assert.equal(url.searchParams.get("access_token"), "long-user-token");
      return Response.json({ data: [{ id: "page-123", name: "TAHA SHOES", access_token: "page-token", tasks: ["CREATE_CONTENT"] }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("Facebook connect persists the scopes actually granted to the Page token", async () => {
  const actualScopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management"];
  const oauth = await loadOAuth({}, {
    fetchImpl: facebookFetch(),
    inspectFacebookPageToken: async (input) => {
      assert.equal(input.pageId, "page-123");
      assert.equal(input.pageToken, "page-token");
      assert.deepEqual(Array.from(input.tasks), ["CREATE_CONTENT"]);
      return { ready: true, grantedScopes: actualScopes };
    },
  });

  await oauth.connectFacebook("authorization-code");

  assert.equal(oauth.__test.upserts.length, 1);
  assert.equal(oauth.__test.upserts[0].status, "connected");
  assert.deepEqual(Array.from(oauth.__test.upserts[0].scopes), actualScopes);
  assert.equal(oauth.__test.persisted.length, 1);
  assert.deepEqual(Array.from(oauth.__test.persisted[0].inspection.grantedScopes), actualScopes);
});

test("Facebook connect stores definitive missing permissions as non-publishable and returns a safe error", async () => {
  const message = "Facebook chưa cấp quyền pages_read_engagement, pages_manage_posts cho Trang này. Hãy cập nhật Login Configuration rồi kết nối lại Facebook.";
  const oauth = await loadOAuth({}, {
    fetchImpl: facebookFetch(),
    inspectFacebookPageToken: async () => ({
      ready: false,
      code: "FACEBOOK_SCOPES_MISSING",
      message,
      missingScopes: ["pages_read_engagement", "pages_manage_posts"],
      grantedScopes: ["pages_show_list"],
    }),
  });

  await assert.rejects(oauth.connectFacebook("authorization-code"), (error) => {
    assert.equal(error.code, "FACEBOOK_SCOPES_MISSING");
    assert.equal(error.userMessage, message);
    assert.equal(error.status, 403);
    assert.doesNotMatch(JSON.stringify(error), /page-token|short-user-token|long-user-token/);
    return true;
  });
  assert.equal(oauth.__test.upserts.length, 1);
  assert.equal(oauth.__test.upserts[0].status, "error");
  assert.deepEqual(Array.from(oauth.__test.upserts[0].scopes), ["pages_show_list"]);
  assert.equal(oauth.__test.persisted.length, 1);
});

test("Facebook connect does not downgrade or replace a connection when permission verification is unavailable", async () => {
  let persisted = false;
  const oauth = await loadOAuth({}, {
    fetchImpl: facebookFetch(),
    inspectFacebookPageToken: async () => {
      throw new (class extends Error {
        constructor() { super("FACEBOOK_VERIFICATION_UNAVAILABLE"); this.code = "FACEBOOK_VERIFICATION_UNAVAILABLE"; }
      })();
    },
    persistFacebookPermissionState: async () => { persisted = true; return true; },
  });

  await assert.rejects(oauth.connectFacebook("authorization-code"), /FACEBOOK_VERIFICATION_UNAVAILABLE/);
  assert.equal(oauth.__test.upserts.length, 0);
  assert.equal(persisted, false);
});

test("Facebook callback shows the specific safe permission failure", async () => {
  const source = await readFile(new URL("../app/api/integrations/facebook/callback/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  class FacebookPermissionCheckError extends Error {
    constructor(code, userMessage, status = 403) { super(code); this.code = code; this.userMessage = userMessage; this.status = status; }
  }
  const specificMessage = "Facebook chưa cấp đủ quyền. Hãy cập nhật Login Configuration rồi kết nối lại Facebook.";
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    URL,
    require(specifier) {
      if (specifier === "../../../../../lib/api") {
        return { redirectWithResult: (_request, provider, result, message) => ({ provider, result, message }) };
      }
      if (specifier === "../../../../../lib/integrations/facebook-permissions") return { FacebookPermissionCheckError };
      if (specifier === "../../../../../lib/integrations/oauth") {
        return { connectFacebook: async () => { throw new FacebookPermissionCheckError("FACEBOOK_SCOPES_MISSING", specificMessage); } };
      }
      if (specifier === "../../../../../lib/integrations/store") return { consumeOAuthState: async () => undefined };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "facebook-callback.cjs" }).runInContext(context);
  const result = await commonJsModule.exports.GET(new Request("https://app.example.com/api/integrations/facebook/callback?code=code&state=state"));
  assert.deepEqual(result, { provider: "facebook", result: "error", message: specificMessage });
});
