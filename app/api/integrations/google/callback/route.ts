import { redirectWithResult } from "../../../../../lib/api";
import { connectGoogle } from "../../../../../lib/integrations/oauth";
import { consumeOAuthState } from "../../../../../lib/integrations/store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || url.searchParams.has("error")) return redirectWithResult(request, "google", "error", "Google chưa cấp quyền.");
  try {
    await consumeOAuthState(state, "google");
    await connectGoogle(code);
    return redirectWithResult(request, "google", "connected");
  } catch {
    return redirectWithResult(request, "google", "error", "Không thể hoàn tất kết nối Google.");
  }
}
