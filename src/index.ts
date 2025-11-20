// 建議在上面宣告一個 helper：取得或建立 user
async function getOrCreateUser(env: Env, lineId: string): Promise<number> {
  // 1. 先找看看有沒有這個 user
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first< { id: number } >();

  if (existing && existing.id) {
    return existing.id;
  }

  // 2. 沒有的話就建立一個新的
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (line_user_id, created_at, updated_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind(lineId, now, now)
    .run();

  // 3. 再查一次拿 id（D1 的 last_insert_rowid 取得比較麻煩，這樣寫最穩）
  const created = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first< { id: number } >();

  if (!created || !created.id) {
    throw new Error("Failed to create user");
  }

  return created.id;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ---------------------------
    // 0. API Key 驗證
    // ---------------------------
    const apiKey = request.headers.get("x-api-key");

    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // ---------------------------
    // 1. Make.com 專用 API
    // ---------------------------
    if (request.method === "POST" && pathname === "/api/external/make/chat") {
      try {
        const body = await request.json();

        const {
          lineId,
          userPrompt,
          source = "make",
          sessionId = crypto.randomUUID(),
          metadata = {},
        } = body;

        if (!lineId || !userPrompt) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Missing required fields: lineId or userPrompt",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // 1) 先找 / 建立 user
        const userId = await getOrCreateUser(env, lineId);

        // 2) 寫入 user 的發話紀錄 → chat_logs
        await env.DB.prepare(
          `INSERT INTO chat_logs
             (user_id, session_id, direction, message_type, text_content, created_at)
           VALUES
             (?1, ?2, 'user', 'text', ?3, datetime('now'))`
        )
          .bind(userId, sessionId, userPrompt)
          .run();

        // 3) 產生 bot 回覆（之後可以換成 LLM）
        const assistantReply = `收到你的訊息：「${userPrompt}」`;

        // 4) 寫入 bot 回覆紀錄
        await env.DB.prepare(
          `INSERT INTO chat_logs
             (user_id, session_id, direction, message_type, text_content, created_at)
           VALUES
             (?1, ?2, 'bot', 'text', ?3, datetime('now'))`
        )
          .bind(userId, sessionId, assistantReply)
          .run();

        // 5) 回傳給 Make.com
        return new Response(
          JSON.stringify({
            success: true,
            replyText: assistantReply,
            replyId: crypto.randomUUID(),
            sessionId,
            source,
            echo: { lineId, userPrompt, metadata },
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({ success: false, error: err.message ?? String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ---------------------------
    // Default 回應
    // ---------------------------
    return new Response(
      JSON.stringify({
        success: true,
        message: "AI小咪後端運作正常",
      }),
      { headers: { "content-type": "application/json" } }
    );
  },
} satisfies ExportedHandler<Env>;
