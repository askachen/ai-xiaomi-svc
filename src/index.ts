// 取得或建立 user
async function getOrCreateUser(env: Env, lineId: string): Promise<number> {
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first<{ id: number }>();

  if (existing && existing.id) return existing.id;

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (line_user_id, created_at, updated_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind(lineId, now, now)
    .run();

  const created = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first<{ id: number }>();

  if (!created?.id) throw new Error("Failed to create user");

  return created.id;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 0. API Key 驗證
    const apiKey = request.headers.get("x-api-key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
    
    if (request.method === "POST" && pathname === "/api/external/make/chat") {
      try {
        const body = await request.json();
    
        const {
          lineId,
          userPrompt,
          source = "make",
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
    
        // 1) 找/建 user
        const userId = await getOrCreateUser(env, lineId);
    
        // 2) 撈 36 小時內的歷史訊息
        const historyRows = await env.DB.prepare(
          `SELECT direction, text_content
           FROM chat_logs
           WHERE user_id = ?1
             AND created_at >= datetime('now', '-36 hours')
           ORDER BY id ASC`
        ).bind(userId).all<{ direction: string; text_content: string }>();
    
        const historyMessages = (historyRows?.results ?? []).map((row) => ({
          role: row.direction === "user" ? "user" : "assistant",
          content: row.text_content,
        }));
    
        // 3) 組 OpenAI messages
        const messages = [
          {
            role: "system",
            content:
              "你是 AI 小咪，一位溫柔、療癒、正向的健康教練，擅長飲食、健康、情緒支持。回答語氣自然，不機械。",
          },
          ...historyMessages,
          {
            role: "user",
            content: userPrompt,
          },
        ];
    
        // 4) GPT-4.1 mini 回覆
        const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages,
            max_tokens: 300,
            temperature: 0.7,
          }),
        });
    
        const json = await openaiResponse.json();
    
        if (!json.choices || !json.choices[0]) {
          throw new Error("Invalid OpenAI response: " + JSON.stringify(json));
        }
    
        const assistantReply = json.choices[0].message.content;
    
        // 5) 將 user/bot 回覆寫回 DB（session_id = NULL）
        await env.DB.prepare(
          `INSERT INTO chat_logs
            (user_id, session_id, direction, message_type, text_content, created_at)
          VALUES (?1, NULL, 'user', 'text', ?2, datetime('now'))`
        )
          .bind(userId, userPrompt)
          .run();
    
        await env.DB.prepare(
          `INSERT INTO chat_logs
            (user_id, session_id, direction, message_type, text_content, created_at)
          VALUES (?1, NULL, 'bot', 'text', ?2, datetime('now'))`
        )
          .bind(userId, assistantReply)
          .run();
    
        // 6) 回傳
        return new Response(
          JSON.stringify({
            success: true,
            replyText: assistantReply,
            replyId: crypto.randomUUID(),
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
    
    // Default
    return new Response(
      JSON.stringify({
        success: true,
        message: "AI小咪後端運作正常（GPT-4.1 Mini 已啟用）",
      }),
      { headers: { "content-type": "application/json" } }
    );
  },
} satisfies ExportedHandler<Env>;
