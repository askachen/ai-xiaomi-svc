// src/handlers/line_webhook.ts
import { getOrCreateUser, logErrorToDb } from "../services/db";
import { hasUserAgreedLatestEula } from "../services/eula";
import { chatWithClassification } from "../services/openai";
import { replyTextMessage } from "../services/line";

export async function handleLineWebhook(
  request: Request,
  env: any,
  ctx: ExecutionContext
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const events: any[] = body.events ?? [];

  // 逐一處理每個 event（通常一次只會一個）
  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") {
      // 目前只處理純文字訊息，其它先忽略
      continue;
    }

    const replyToken: string = event.replyToken;
    const lineUserId: string | undefined = event.source?.userId;
    const userPrompt: string = event.message?.text ?? "";

    if (!replyToken || !lineUserId || !userPrompt) {
      continue;
    }

    try {
      // 1) 找 / 建 user
      const userId = await getOrCreateUser(env, lineUserId);

      // 2) 檢查是否已同意最新 EULA
      const { agreed, latestEula } = await hasUserAgreedLatestEula(env, userId);

      if (!agreed && latestEula) {
        const eulaText =
          "嗨～歡迎使用 AI 小咪！因為是第一次使用，小咪要先請你閱讀並同意「使用者條款」，小咪會好好保護你的個人資料，請放心喔！\n\n" +
          latestEula.url;

        await replyTextMessage(env, replyToken, eulaText);
        // 不再往下走聊天流程
        continue;
      }

      // 3) 撈出該 user「過去 36 小時」所有對話當作歷史
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

      // 4) 組 OpenAI messages（沿用原本 system prompt）
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

      // 5) 呼叫 OpenAI，一次拿分類 + 回覆
      const { reply: assistantReply, category: intentCategory } =
        await chatWithClassification(env, messages);

      // 6) 寫入 user 訊息
      await env.DB.prepare(
        `INSERT INTO chat_logs
          (user_id, session_id, direction, message_type, text_content, created_at, intent_category)
         VALUES (?1, NULL, 'user', 'text', ?2, datetime('now'), ?3)`
      )
        .bind(userId, userPrompt, intentCategory)
        .run();

      // 7) 寫入 bot 回覆
      await env.DB.prepare(
        `INSERT INTO chat_logs
          (user_id, session_id, direction, message_type, text_content, created_at, intent_category)
         VALUES (?1, NULL, 'bot', 'text', ?2, datetime('now'), NULL)`
      )
        .bind(userId, assistantReply)
        .run();

      // 8) 回 LINE
      await replyTextMessage(env, replyToken, assistantReply);
    } catch (err) {
      // 錯誤記錄 + 嘗試回一個安全訊息
      await logErrorToDb(env, "line_webhook", err, { event });

      try {
        await replyTextMessage(
          env,
          replyToken,
          "小咪這邊有點忙碌，等等再和你聊聊好嗎？"
        );
      } catch {
        // 就算這裡再錯，也不要讓整個 webhook 爆掉
      }
    }
  }

  // LINE 只需要 200 OK
  return new Response("OK");
}
