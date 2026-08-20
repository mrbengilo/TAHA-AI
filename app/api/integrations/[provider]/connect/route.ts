import { fail, ok } from "../../../../../lib/api";
import { createSignedState } from "../../../../../lib/integrations/crypto";
import { IntegrationConfigError } from "../../../../../lib/integrations/env";
import { buildAuthorizationUrl, connectAssistedZalo, connectWebsite } from "../../../../../lib/integrations/oauth";
import { getProviderReadiness, isProviderId } from "../../../../../lib/integrations/providers";
import { saveOAuthState } from "../../../../../lib/integrations/store";
import { isOperatorRequest } from "../../../../../lib/operator-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để kết nối tài khoản.", 401);
  const { provider: rawProvider } = await context.params;
  if (!isProviderId(rawProvider)) return fail("PROVIDER_NOT_FOUND", "Kênh kết nối không hợp lệ.", 404);

  const readiness = getProviderReadiness(rawProvider);
  if (!readiness.configured) {
    return fail("INTEGRATION_NOT_CONFIGURED", "Kênh chưa có đủ cấu hình trên máy chủ.", 409, { missing: readiness.missing });
  }

  try {
    if (rawProvider === "zalo_personal") {
      const connectionId = await connectAssistedZalo();
      return ok({ mode: "assisted", connectionId, redirectTo: "/connections?provider=zalo_personal&result=connected" });
    }
    if (rawProvider === "website") {
      const connectionId = await connectWebsite();
      return ok({ mode: "api", connectionId, redirectTo: "/connections?provider=website&result=connected" });
    }

    const body = await request.json().catch(() => ({})) as { returnTo?: string };
    const { token, payload } = await createSignedState(rawProvider, body.returnTo ?? "/connections");
    await saveOAuthState(payload);
    const authorizationUrl = await buildAuthorizationUrl(rawProvider, token);
    return ok({ mode: "oauth", authorizationUrl });
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return fail("INTEGRATION_NOT_CONFIGURED", "Kênh chưa có đủ cấu hình trên máy chủ.", 409, { missing: [error.variable] });
    }
    return fail("INTEGRATION_CONNECT_FAILED", "Không thể bắt đầu kết nối. Vui lòng kiểm tra database và cấu hình máy chủ.", 500);
  }
}
