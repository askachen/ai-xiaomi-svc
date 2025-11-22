// src/handlers/make_chat.ts
import { getOrCreateUser, logErrorToDb } from "../services/db";
import { hasUserAgreedLatestEula } from "../services/eula";
import { chatWithClassification } from "../services/openai";

export async function handleMakeChat(
  request: Request,
  env: any,
  ctx: ExecutionContext
): Promise<Response> {
  // 只對 server-to-server 這支做 API Key 驗證
  const apiKey = request.headers.get("x-api-key");
  if (!apiKey || apiKey !== env.API_KEY) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

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

    // 1) 找 / 建 user
    const userId = await getOrCreateUser(env, lineId);

    // 1.5) 檢查是否已同意最新 EULA
    const { agreed, latestEula } = await hasUserAgreedLatestEula(env, userId);

    if (!agreed && latestEula) {
      // 還沒同意最新 EULA，請前端 / Make.com 引導去 EULA LIFF
      return new Response(
        JSON.stringify({
          success: true,
          needEulaConsent: true,
          eula: {
            id: latestEula.id,
            version: latestEula.version,
            url: latestEula.url,
          },
          replyText:
            "嗨～歡迎使用 AI 小咪！因為是第一次使用，小咪要先請你閱讀並同意「使用者條款」，小咪會好好保護你的個人資料，請放心喔！\n\n" +
            latestEula.url,
          echo: { lineId, userPrompt, source, metadata },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

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

    // 4) 呼叫 OpenAI，一次拿分類 + 回覆
    const { reply: assistantReply, category: intentCategory } =
      await chatWithClassification(env, messages);

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
    await logErrorToDb(env, "make_chat", err, {
      path: "/api/external/make/chat",
      method: "POST",
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: err?.message ?? String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
