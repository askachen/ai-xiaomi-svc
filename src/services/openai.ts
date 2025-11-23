// src/services/openai.ts

import { logErrorToDb } from "../services/db";

export type ChatResult = {
  reply: string;
  category: "diet" | "emotion" | "health" | "general";
};

const VALID_CATEGORIES = ["diet", "emotion", "health", "general"] as const;

const CHAT_MODEL = "gpt-4.1-mini";

const VISION_MODEL = "gpt-4o"; // 先用大哥把 flow 打通

// ======================== 共用小工具 ========================

function ensureStringContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (typeof p?.content === "string") return p.content;
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return String(content);
}

function safeNumber(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function fetchWithTimeoutRace(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`OpenAI request timeout after ${timeoutMs} ms`));
    }, timeoutMs);

    fetch(url, options)
      .then((res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ======================== 1) 文字聊天 + 分類 ========================

export async function chatWithClassification(
  env: any,
  messages: any[]
): Promise<ChatResult> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  // 🧠 關鍵修正：
  // 為了能使用 response_format = json_object，
  // messages 裡面必須明確提到「json」這個字，
  // 並且清楚指定輸出格式。
  const jsonSystemMessage = {
    role: "system",
    content:
      '你是一個助理，接下來「所有回覆」都必須使用 JSON 格式回覆，並且只能回傳 JSON，不要有任何多餘文字或註解。' +
      '請回傳一個 json 物件，格式固定為：' +
      '{"reply": "給使用者的繁體中文回覆文字", "category": "diet | emotion | health | general"}。' +
      "其中 reply 請使用繁體中文，category 僅能是四種之一：diet（飲食 / 熱量 / 營養）、emotion（心情 / 情緒 / 動力）、health（睡眠 / 精神 / 身體狀況，但非飲食重點）、general（一般聊天或無法歸類）。" +
      "請務必輸出合法 JSON，不要加註解，不要加其他 key。",
  };

  const finalMessages = [jsonSystemMessage, ...messages];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: finalMessages,
      max_tokens: 400,
      temperature: 0.7,
      // 這裡保留 json_object，但現在 messages 已經包含 json 說明，不會再報錯
      response_format: { type: "json_object" },
    }),
  });

  const json = await res.json();

  if (!json.choices || !json.choices[0] || !json.choices[0].message) {
    await logErrorToDb(env, "openai_chat_invalid_response", undefined, {
      json,
    });
    throw new Error("Invalid OpenAI response: " + JSON.stringify(json));
  }

  let reply = "";
  let category: ChatResult["category"] = "general";

  try {
    const contentRaw = json.choices[0].message.content;
    const contentStr = ensureStringContent(contentRaw);
    const parsed = JSON.parse(contentStr);

    reply = parsed.reply ?? "";
    category = parsed.category ?? "general";

    if (!VALID_CATEGORIES.includes(category)) {
      category = "general";
    }

    if (!reply || typeof reply !== "string" || reply.trim().length === 0) {
      reply =
        contentStr ||
        "小咪在想該怎麼回你，先讓我整理一下思緒～";
    }
  } catch (err) {
    await logErrorToDb(env, "openai_chat_parse_error", err, {
      raw: json,
    });
    reply = "小咪這邊有點忙碌，等等再和你聊聊好嗎？";
    category = "general";
  }

  return { reply, category };
}

// ======================== 2) 圖片 → 飲食分析 ========================

export type MealAnalysisResult = {
  meal_type: string;
  food_name: string;
  description: string;
  carb_g: number | null;
  sugar_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  veggies_servings: number | null;
  fruits_servings: number | null;
  calories_kcal: number | null;
  raw_json: any;
};

export async function analyzeMealFromImage(
  env: any,
  imageBuffer: ArrayBuffer
): Promise<MealAnalysisResult> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const base64 = arrayBufferToBase64(imageBuffer);
  const imageUrl = `data:image/jpeg;base64,${base64}`;

  const prompt = `
你是一位專業營養師助手，請根據下列餐點照片，以「單一 JSON」回覆估算結果。

請盡量用數值估算營養，不確定可以合理估計，不要留空，用 null。

只允許以下欄位，不要多加其他東西，也不要加註解或文字：

{
  "meal_type": "breakfast | lunch | dinner | snack 等餐別",
  "food_name": "主餐名稱，例如：雞腿便當",
  "description": "1~3 句描述餐點內容與主要食材",
  "carb_g":  碳水化合物克數（number 或 null）,
  "sugar_g": 糖分克數（number 或 null）,
  "protein_g": 蛋白質克數（number 或 null）,
  "fat_g": 脂肪克數（number 或 null）,
  "veggies_servings": 蔬菜份數（number 或 null）,
  "fruits_servings": 水果份數（number 或 null）,
  "calories_kcal": 熱量（大卡，number 或 null）
}

請「只」回傳這個 JSON，前後不要出現任何多餘文字。
  `.trim();

  const body = JSON.stringify({
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: imageUrl,
              // 先用 detail: "low" 降一點負擔，有需要再調
              detail: "low",
            },
          },
        ],
      } as any,
    ],
    max_tokens: 400,
  });

  // debug：呼叫前
  await logErrorToDb(env, "openai_image_debug", undefined, {
    step: "before_openai_real",
    model: VISION_MODEL,
    image_bytes: imageBuffer.byteLength,
    body_length: body.length,
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body,
  });

  const raw = await res.text();

  // 不管成功失敗，先把 raw 壓一份到 log（砍到前 2000 chars）
  await logErrorToDb(env, "openai_image_raw", undefined, {
    status: res.status,
    ok: res.ok,
    raw: raw.slice(0, 2000),
  });

  if (!res.ok) {
    // 讓外層 catch，順便有 raw 可以看
    throw new Error(`OpenAI HTTP ${res.status}: ${raw.slice(0, 500)}`);
  }

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    await logErrorToDb(env, "openai_image_json_parse_error", e, {
      raw_sample: raw.slice(0, 2000),
    });
    throw new Error("Failed to parse OpenAI JSON response");
  }

  const choice = data.choices?.[0]?.message?.content;
  const contentStr = ensureStringContent(choice);

  let parsed: any;
  try {
    parsed = JSON.parse(contentStr);
  } catch (e) {
    await logErrorToDb(env, "openai_image_content_parse_error", e, {
      content_sample: contentStr.slice(0, 2000),
    });
    throw new Error("Failed to parse meal JSON content");
  }

  const num = (v: any): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    meal_type: parsed.meal_type ?? "",
    food_name: parsed.food_name ?? "",
    description: parsed.description ?? "",
    carb_g: num(parsed.carb_g),
    sugar_g: num(parsed.sugar_g),
    protein_g: num(parsed.protein_g),
    fat_g: num(parsed.fat_g),
    veggies_servings: num(parsed.veggies_servings),
    fruits_servings: num(parsed.fruits_servings),
    calories_kcal: num(parsed.calories_kcal),
    raw_json: parsed,
  };
}
