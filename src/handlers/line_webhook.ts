// src/handlers/line_webhook.ts
import { getOrCreateUser, logErrorToDb } from "../services/db";
import { hasUserAgreedLatestEula } from "../services/eula";
import { chatWithClassification, analyzeMealFromImage } from "../services/openai";
import { replyTextMessage } from "../services/line";

const LINE_CONTENT_ENDPOINT = "https://api-data.line.me/v2/bot/message";

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

  // ✅ 改成非同步：立即回應 LINE，實際處理丟到 waitUntil 裡面
  for (const event of events) {
    ctx.waitUntil(
      (async () => {
        try {
          if (event.type !== "message") {
            return;
          }

          const msgType = event.message?.type;
          const replyToken: string = event.replyToken;
          const lineUserId: string | undefined = event.source?.userId;

          if (!replyToken || !lineUserId) {
            return;
          }

          if (msgType === "text") {
            await handleTextMessage(event, env, replyToken, lineUserId);
          } else if (msgType === "image") {
            await handleImageMessage(event, env, replyToken, lineUserId);
          } else {
            // 其他類型暫時回一個說明
            try {
              await replyTextMessage(
                env,
                replyToken,
                "小咪現在先專心處理文字跟餐點照片喔～其他類型的訊息之後會慢慢學會 💪"
              );
            } catch {
              // ignore
            }
          }
        } catch (err) {
          // 額外保險：整個 event 處理如果炸掉，也寫進 error_logs
          await logErrorToDb(env, "line_webhook_event", err, { event });
        }
      })()
    );
  }

  // 這裡會很快就回 200，避免 LINE timeout
  return new Response("OK");
}

async function handleTextMessage(
  event: any,
  env: any,
  replyToken: string,
  lineUserId: string
) {
  const userPrompt: string = event.message?.text ?? "";

  if (!userPrompt) return;

  try {
    const userId = await getOrCreateUser(env, lineUserId);

    // EULA 檢查
    const { agreed, latestEula } = await hasUserAgreedLatestEula(env, userId);
    if (!agreed && latestEula) {
      const eulaText =
        "嗨～歡迎使用 AI 小咪！因為是第一次使用，小咪要先請你閱讀並同意「使用者條款」，小咪會好好保護你的個人資料，請放心喔！\n\n" +
        latestEula.url;
      await replyTextMessage(env, replyToken, eulaText);
      return;
    }

    // 撈過去 36 小時的歷史訊息
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

    const systemPrompt = `
你是「AI 小咪」，一位溫柔、可愛、但也很務實的健康生活教練。
請用繁體中文回覆，語氣自然、有溫度，不要太制式，也不要太油膩。
你的核心任務：
1. 陪伴使用者記錄每天的身體狀況（精神、體力、心情、睡眠）。
2. 協助分析飲食與熱量，給出具體、可執行的小建議。
3. 協助維持動力與習慣建立，不責備、但會適度提醒。
4. 不提供專業醫療診斷，不使用「診斷、處方、治療」等字眼，改用「建議、可以考慮、可以試試看」。

回覆原則：
- 回覆長度以 1～3 段為主，避免一次塞太多訊息。
- 優先肯定、理解使用者的感受，再給建議。
- 若牽涉到明顯的醫療風險，請溫柔建議「尋求專業醫師或營養師協助」，不要自己下結論。

請務必用繁體中文作答。
`.trim();

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...historyMessages,
      {
        role: "user",
        content: userPrompt,
      },
    ];

    const { reply: assistantReply, category: intentCategory } =
      await chatWithClassification(env, messages);

    // 寫入 user 訊息
    await env.DB.prepare(
      `INSERT INTO chat_logs
        (user_id, session_id, direction, message_type, text_content, created_at, intent_category)
       VALUES (?1, NULL, 'user', 'text', ?2, datetime('now'), ?3)`
    )
      .bind(userId, userPrompt, intentCategory)
      .run();

    // 寫入 bot 回覆
    await env.DB.prepare(
      `INSERT INTO chat_logs
        (user_id, session_id, direction, message_type, text_content, created_at, intent_category)
       VALUES (?1, NULL, 'bot', 'text', ?2, datetime('now'), NULL)`
    )
      .bind(userId, assistantReply)
      .run();

    await replyTextMessage(env, replyToken, assistantReply);
  } catch (err) {
    await logErrorToDb(env, "line_webhook_text", err, { event });
    try {
      await replyTextMessage(
        env,
        replyToken,
        "小咪這邊有點忙碌，等等再和你聊聊好嗎？"
      );
    } catch {
      // ignore
    }
  }
}

async function handleImageMessage(
  event: any,
  env: any,
  replyToken: string,
  lineUserId: string
) {
  const messageId: string | undefined = event.message?.id;

  if (!messageId) {
    await logErrorToDb(env, "line_webhook_image_no_message_id", undefined, {
      event,
    });
    try {
      await replyTextMessage(
        env,
        replyToken,
        "小咪收到一張圖片，但是取得不到圖片內容 QQ\n可能是 LINE 測試事件或格式不符合，小咪再試一次喔～"
      );
    } catch {
      // ignore
    }
    return;
  }

  try {
    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "before_fetch",
      messageId,
      lineUserId,
    });

    const contentResp = await fetch(
      `${LINE_CONTENT_ENDPOINT}/${encodeURIComponent(messageId)}/content`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );

    if (!contentResp.ok) {
      await logErrorToDb(
        env,
        "line_webhook_image_fetch_failed",
        undefined,
        {
          status: contentResp.status,
          statusText: contentResp.statusText,
          messageId,
        }
      );

      try {
        await replyTextMessage(
          env,
          replyToken,
          "小咪剛剛在跟 LINE 拿照片的時候遇到一點小問題 QQ\n等等再請你重新傳一次照片給小咪好嗎？"
        );
      } catch {
        // ignore
      }
      return;
    }

    const imageArrayBuffer = await contentResp.arrayBuffer();
    const imageBytes = new Uint8Array(imageArrayBuffer);

    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "after_fetch",
      messageId,
      byteLength: imageBytes.byteLength,
    });

    // 1) 取得/建立 user
    const userId = await getOrCreateUser(env, lineUserId);

    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "after_getOrCreateUser",
      userId,
      lineUserId,
    });

    // 2) EULA 檢查
    const { agreed, latestEula } = await hasUserAgreedLatestEula(env, userId);
    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "after_eula_check",
      userId,
      agreed,
      latestEula_id: latestEula?.id ?? null,
    });

    if (!agreed && latestEula) {
      const eulaText =
        "嗨～歡迎使用 AI 小咪！因為是第一次使用，小咪要先請你閱讀並同意「使用者條款」，小咪會好好保護你的個人資料，請放心喔！\n\n" +
        latestEula.url;
      await replyTextMessage(env, replyToken, eulaText);
      return;
    }

    // 3) 丟給 OpenAI 分析餐點
    const analysis = await analyzeMealFromImage(env, imageBytes);

    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "after_openai",
      analysis,
    });

    if (!analysis) {
      await replyTextMessage(
        env,
        replyToken,
        "小咪剛剛看這張照片的時候有點看不清楚 QQ\n可以再傳一張清楚一點的餐點照片給小咪嗎？"
      );
      return;
    }

    const nowIso = new Date().toISOString();

    // 4) 寫入 meal_logs
    await env.DB.prepare(
      `INSERT INTO meal_logs
        (user_id, eaten_at, meal_type, food_name, description,
         carb_g, sugar_g, protein_g, fat_g,
         veggies_servings, fruits_servings, calories_kcal,
         photo_url, source, metadata, created_at, updated_at)
       VALUES
        (?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9,
         ?10, ?11, ?12,
         ?13, ?14, ?15, ?16, ?17)`
    )
      .bind(
        userId,
        nowIso,
        analysis.meal_type || null,
        analysis.food_name || null,
        analysis.description || null,
        analysis.carb_g,
        analysis.sugar_g,
        analysis.protein_g,
        analysis.fat_g,
        analysis.veggies_servings,
        analysis.fruits_servings,
        analysis.calories_kcal,
        null,
        "line_image",
        JSON.stringify(analysis.raw_json ?? {}),
        nowIso,
        nowIso
      )
      .run();

    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "after_insert_meal_logs",
      userId,
      nowIso,
    });

    // 5) 回覆使用者分析結果
    const replyMessage =
      analysis.reply_text ??
      "小咪已經幫你記錄這餐囉～之後會慢慢幫你整理一週的飲食狀況！";

    await replyTextMessage(env, replyToken, replyMessage);

    await logErrorToDb(env, "line_image_debug", undefined, {
      step: "after_replyTextMessage",
    });
  } catch (err) {
    await logErrorToDb(env, "line_webhook_image", err, {
      event,
    });

    try {
      await replyTextMessage(
        env,
        replyToken,
        "小咪剛剛在看這張照片的時候遇到一點小問題 QQ\n可以先用文字跟小咪說你吃了什麼，小咪一樣可以幫你估熱量喔！"
      );
    } catch {
      // ignore
    }
  }
}
