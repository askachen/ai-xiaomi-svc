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

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: messages,
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
  advice_text: string;
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
你是一位專業且溫柔友善的營養師 AI 助手。

請你根據提供的餐點圖片，判斷食物種類並估算營養素，並「以單一 JSON」回覆。

⚠️ 請務必回傳以下格式（不可多不可少，不要有註解）：

{
  "meal": {
    "meal_type": "breakfast | lunch | dinner | snack",
    "food_name": "像：雞腿便當 / 牛肉麵 / 沙拉",
    "description": "一句描述主要成分",
    "carb_g": number | null,
    "sugar_g": number | null,
    "protein_g": number | null,
    "fat_g": number | null,
    "veggies_servings": number | null,
    "fruits_servings": number | null,
    "calories_kcal": number | null
  },
  "advice_text": "一段簡短的自然語言建議（繁體中文，1~3 行），內容請包含：1) 此餐的健康優點、2) 可改善的方向（若有）、3) 友善的提醒方式。不可以出現醫療診斷。"
}

請注意：
- 你回傳的 JSON 不可以多出其他欄位。
- 不可以在 JSON 外多加文字。
- 數值請盡量估算，不確定可以用 null。
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

  // 把原始回應存一份（只截前 2000 字免炸 DB）
  await logErrorToDb(env, "openai_image_raw", undefined, {
    status: res.status,
    ok: res.ok,
    raw: raw.slice(0, 2000),
  });

  if (!res.ok) {
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
  let contentStr = ensureStringContent(choice).trim();

  // 🔧 有些模型會包成 ```json ... ```，這裡把 fence 剝掉
  const fenceMatch = contentStr.match(/```[a-zA-Z0-9]*\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    contentStr = fenceMatch[1].trim();
  }

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

  const meal = parsed.meal ?? {};

  return {
    meal_type: meal.meal_type ?? "",
    food_name: meal.food_name ?? "",
    description: meal.description ?? "",
    carb_g: num(meal.carb_g),
    sugar_g: num(meal.sugar_g),
    protein_g: num(meal.protein_g),
    fat_g: num(meal.fat_g),
    veggies_servings: num(meal.veggies_servings),
    fruits_servings: num(meal.fruits_servings),
    calories_kcal: num(meal.calories_kcal),
    raw_json: meal,
    advice_text: parsed.advice_text ?? "",
  };
}
