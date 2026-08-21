import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadOAuth(runtimeOverrides = {}) {
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
    META_LOGIN_CONFIG_ID: "meta-login-config-id",
    META_GRAPH_API_VERSION: "v26.0",
    META_REDIRECT_URI: "https://app.example.com/api/integrations/facebook/callback",
    ...runtimeOverrides,
  };
  const commonJsModule = { exports: {} };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    URL,
    URLSearchParams,
    require(specifier) {
      if (specifier === "./crypto") {
        return {
          encryptCredentials: async () => ({ ciphertext: "", iv: "", keyVersion: 1 }),
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
      if (specifier === "./providers") return { providerDefinitions: {} };
      if (specifier === "./store") return { upsertConnection: async () => undefined };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  new vm.Script(compiled, { filename: "oauth.cjs" }).runInContext(context);
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
