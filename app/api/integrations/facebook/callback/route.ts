import { redirectWithResult } from "../../../../../lib/api";
import { connectFacebook } from "../../../../../lib/integrations/oauth";
import { consumeOAuthState } from "../../../../../lib/integrations/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || url.searchParams.has("error")) return redirectWithResult(request, "facebook", "error", "Facebook chưa cấp quyền.");
  try {
    await consumeOAuthState(state, "facebook");
    await connectFacebook(code);
    return redirectWithResult(request, "facebook", "connected");
  } catch {
    return redirectWithResult(request, "facebook", "error", "Không thể hoàn tất kết nối Facebook Page.");
  }
}
