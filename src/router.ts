// src/router.ts
import { handleEulaConsent } from "./handlers/eula";
import { handleMakeChat } from "./handlers/make_chat";
import { EULA_CORS_HEADERS } from "./utils/cors";

export async function handleRequest(
  request: Request,
  env: any,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  // 0) CORS preflight for EULA 同意 API
  if (method === "OPTIONS" && pathname === "/api/external/line/eula/consent") {
    return new Response(null, {
      status: 204,
      headers: EULA_CORS_HEADERS,
    });
  }

  // 1) LIFF EULA 同意 API（給前端 index.html 呼叫，不驗 x-api-key）
  if (method === "POST" && pathname === "/api/external/line/eula/consent") {
    return handleEulaConsent(request, env, ctx);
  }

  // 2) Make.com 專用聊天 API（需要 x-api-key）
  if (method === "POST" && pathname === "/api/external/make/chat") {
    return handleMakeChat(request, env, ctx);
  }

  // 3) Default 根路徑：健康檢查用
  return new Response(
    JSON.stringify({
      success: true,
      message:
        "AI小咪後端運作正常（v6：EULA 檢查 + LIFF 同意 API + CORS + 多輪對談 + 分類）",
    }),
    { headers: { "content-type": "application/json" } }
  );
}
