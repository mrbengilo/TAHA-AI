import { redirectWithResult } from "../../../../../lib/api";
import { connectTikTokShop } from "../../../../../lib/integrations/oauth";
import { consumeOAuthState } from "../../../../../lib/integrations/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || url.searchParams.has("error")) return redirectWithResult(request, "tiktok_shop", "error", "TikTok Shop chưa cấp quyền.");
  try {
    await consumeOAuthState(state, "tiktok_shop");
    await connectTikTokShop(code);
    return redirectWithResult(request, "tiktok_shop", "connected");
  } catch {
    return redirectWithResult(request, "tiktok_shop", "error", "Không thể hoàn tất kết nối TikTok Shop.");
  }
}
