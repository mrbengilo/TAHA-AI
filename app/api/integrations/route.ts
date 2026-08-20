import { fail, ok } from "../../../lib/api";
import { providerIds, safeProviderDefinition } from "../../../lib/integrations/providers";
import { listConnections } from "../../../lib/integrations/store";
import { isOperatorRequest } from "../../../lib/operator-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isOperatorRequest(request)) return fail("UNAUTHORIZED", "Bạn cần đăng nhập để xem các kết nối.", 401);
  const connections = await listConnections();
  return ok({
    providers: providerIds.map((provider) => ({
      ...safeProviderDefinition(provider),
      connections: connections.filter((connection) => connection.provider === provider),
    })),
  });
}
