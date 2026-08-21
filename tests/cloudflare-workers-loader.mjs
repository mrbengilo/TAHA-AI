const cloudflareWorkersMock =
  "data:text/javascript,export const env = globalThis.__TAHA_TEST_ENV__ ?? Object.create(null);";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: cloudflareWorkersMock,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
