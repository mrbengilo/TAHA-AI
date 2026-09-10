import { fail, ok } from "@/lib/api";
import { isOperatorRequest } from "@/lib/operator-auth";
import {
  POST_TEMPLATE_PREVIEW_VALUES,
  getPostTemplate,
  postTemplateErrorResponse,
  previewPostTemplate,
} from "@/lib/post-template";
import { updatePostTemplate } from "@/lib/post-template-refresh";

export const dynamic = "force-dynamic";

function actorId(request: Request) {
  return request.headers.get("oai-authenticated-user-id")
    || request.headers.get("oai-authenticated-user-email")
    || "operator";
}

function responseForError(error: unknown) {
  const shaped = postTemplateErrorResponse(error);
  return fail(shaped.code, shaped.message, shaped.status, shaped.details);
}

export async function GET(request: Request) {
  if (!isOperatorRequest(request)) {
    return fail("OPERATOR_REQUIRED", "Chỉ quản trị viên mới được xem và chỉnh sửa bài viết mẫu.", 401);
  }
  try {
    const template = await getPostTemplate();
    return ok({
      template,
      preview: previewPostTemplate(template.config),
      previewValues: POST_TEMPLATE_PREVIEW_VALUES,
    });
  } catch (error) {
    return responseForError(error);
  }
}

export async function PUT(request: Request) {
  if (!isOperatorRequest(request)) {
    return fail("OPERATOR_REQUIRED", "Chỉ quản trị viên mới được cập nhật bài viết mẫu.", 401);
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return fail("INVALID_JSON", "Dữ liệu bài viết mẫu không phải JSON hợp lệ.", 400);
  }
  try {
    const body = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const result = await updatePostTemplate({
      expectedVersion: body.expectedVersion,
      config: body.config,
    }, actorId(request));
    return ok({ ...result, previewValues: POST_TEMPLATE_PREVIEW_VALUES });
  } catch (error) {
    return responseForError(error);
  }
}
