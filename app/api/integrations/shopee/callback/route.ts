import { redirectWithResult } from "../../../../../lib/api";
import { connectShopee } from "../../../../../lib/integrations/oauth";
import { consumeOAuthState } from "../../../../../lib/integrations/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shopId = url.searchParams.get("shop_id");
  const state = url.searchParams.get("state");
  if (!code || !shopId || !state) return redirectWithResult(request, "shopee", "error", "Shopee chưa trả về quyền của shop.");
  try {
    await consumeOAuthState(state, "shopee");
    await connectShopee(code, shopId);
    return redirectWithResult(request, "shopee", "connected");
  } catch {
    return redirectWithResult(request, "shopee", "error", "Không thể hoàn tất kết nối Shopee Seller.");
  }
}
