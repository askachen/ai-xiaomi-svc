// index.ts v3 - AI 小咪後端
// 需求：
// - x-api-key 驗證
// - 使用 D1 (env.DB)
// - 多輪對話：過去 36 小時的歷史
// - 呼叫 OpenAI gpt-4.1-mini，一次拿到 reply + category
// - 寫入 users / chat_logs

// 小工具：找或建立 user
async function getOrCreateUser(env: any, lineId: string): Promise<number> {
  // 1. 先找 user
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first();

  if (existing && (existing as any).id) {
    return (existing as any).id as number;
  }

  // 2. 沒有就建立一個新的
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (line_user_id, created_at, updated_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind(lineId, now, now)
    .run();

  // 3. 再查一次拿 id
  const created = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first();

  if (!created || !(created as any).id) {
    throw new Error("Failed to create user");
  }

  return (created as any).id as number;
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

    // 1. Make.com 專用 API
    if (request.method === "POST" && pathname === "/api/external/make/chat") {
      try {
        const body = await request.json();
        const {
          lineId,
          userPrompt,
          source = "make",
          metadata = {},
        } = body ?? {};

        if (!lineId || !userPrompt) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Missing required fields: lineId or userPrompt",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        if (!env.OPENAI_API_KEY) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "OPENAI_API_KEY is not configured",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }

        // 1) 找 / 建 user
        const userId = await getOrCreateUser(env, lineId);

        // 2) 撈出該 user「過去 36 小時」所有對話當作歷史
        const historyResult = await env.DB.prepare(
          `SELECT direction, text_content
           FROM chat_logs
           WHERE user_id = ?1
             AND created_at >= datetime('now', '-36 hours')
           ORDER BY id ASC`
        )
          .bind(userId)
          .all();

        const historyRows = (historyResult as any).results ?? [];

        const historyMessages = historyRows.map((row: any) => ({
          role: row.direction === "user" ? "user" : "assistant",
          content: row.text_content as string,
        }));

        // 3) 組 OpenAI messages
        const messages = [
          {
            role: "system",
            content: `
你是「AI 小咪」，一位溫柔、療癒、正向的健康教練，
擅長幫助使用者在飲食、減重、健康習慣和情緒上做調整。
你會：
- 先理解使用者的狀況與情緒
- 給出貼心、具體、可執行的建議（用繁體中文）
- 不要用太制式的口吻，要像一位溫柔但有行動力的教練

除了回覆之外，你還需要「替使用者這一句話做分類」：
intent_category 只能是以下四個英文字其中之一：
- "diet"    : 與飲食、減肥、卡路里、吃什麼、喝什麼相關
- "emotion" : 與心情、壓力、焦慮、沮喪、動力、鼓勵相關
- "health"  : 與運動、睡眠、身體不適、健康習慣相關
- "general" : 其他不屬於上述三類的內容

請你只回傳「一段 JSON 字串」，格式如下：

{
  "category": "diet | emotion | health | general 其中一個",
  "reply": "你要對使用者說的完整回覆內容（字串，繁體中文）"
}

不要加註解、不要多一句話，只能是 JSON。
          `.trim(),
          },
          ...historyMessages,
          {
            role: "user",
            content: userPrompt,
          },
        ];

        // 4) 呼叫 OpenAI gpt-4.1-mini，一次拿分類 + 回覆
        const openaiResponse = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-4.1-mini",
              messages,
              max_tokens: 400,
              temperature: 0.7,
            }),
          }
        );

        const json = await openaiResponse.json();

        if (!json.choices || !json.choices[0]) {
          throw new Error("Invalid OpenAI response: " + JSON.stringify(json));
        }

        const rawContent =
          json.choices[0].message?.content ?? json.choices[0].message ?? "";

        let assistantReply = "";
        let intentCategory = "general";

        try {
          const parsed = JSON.parse(rawContent);
          assistantReply = parsed.reply ?? "";
          intentCategory = parsed.category ?? "general";
          if (
            !["diet", "emotion", "health", "general"].includes(intentCategory)
          ) {
            intentCategory = "general";
          }
        } catch (e) {
          // 模型沒乖乖回 JSON，就當成純文字回覆
          assistantReply =
            typeof rawContent === "string" && rawContent.trim().length > 0
              ? rawContent
              : "小咪這邊有點忙碌，等等再和你聊聊好嗎？";
          intentCategory = "general";
        }

        // 5) 寫入 user 訊息（intent_category 填入模型判斷結果）
        await env.DB.prepare(
          `INSERT INTO chat_logs
            (user_id, session_id, direction, message_type, text_content, created_at, intent_category)
           VALUES (?1, NULL, 'user', 'text', ?2, datetime('now'), ?3)`
        )
          .bind(userId, userPrompt, intentCategory)
          .run();

        // 6) 寫入 bot 回覆（intent_category 先留 NULL 或之後再補）
        await env.DB.prepare(
          `INSERT INTO chat_logs
            (user_id, session_id, direction, message_type, text_content, created_at, intent_category)
           VALUES (?1, NULL, 'bot', 'text', ?2, datetime('now'), NULL)`
        )
          .bind(userId, assistantReply)
          .run();

        // 7) 回傳給 Make.com
        return new Response(
          JSON.stringify({
            success: true,
            replyText: assistantReply,
            intentCategory,
            replyId: crypto.randomUUID(),
            source,
            echo: { lineId, userPrompt, metadata },
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            success: false,
            error: err?.message ?? String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Default 根路徑：健康檢查用
    return new Response(
      JSON.stringify({
        success: true,
        message: "AI小咪後端運作正常（v3，多輪對談 + 分類啟用）",
      }),
      { headers: { "content-type": "application/json" } }
    );
  },
} satisfies ExportedHandler<Env>;
