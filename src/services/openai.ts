// src/services/openai.ts
// 統一管理所有跟 OpenAI 有關的東西：
// - chatWithClassification：文字聊天 + 意圖分類（使用 gpt-5-mini + JSON mode）
// - analyzeMealFromImage：圖片 → 飲食分析（使用 gpt-4.1-mini + JSON mode）

export type ChatResult = {
  reply: string;
  category: "diet" | "emotion" | "health" | "general";
};

const VALID_CATEGORIES = ["diet", "emotion", "health", "general"] as const;

// 文字聊天用：gpt-5-mini（便宜＋快）
// 注意：gpt-5-mini 不支援 max_tokens / temperature，所以我們只用 max_completion_tokens。
const CHAT_MODEL = "gpt-4.1-mini";

// 圖片分析用：用 4.x 支援 vision 的模型會比較安全（5-mini 未必有 vision）
// 你之後如果確認 5 系列支援 vision，再改這個常數就好。
const VISION_MODEL = "gpt-4.1-mini";

// ======================== 共用小工具 ========================

function ensureStringContent(content: any): string {
  // OpenAI 在 JSON mode 下通常會回傳 content 是「字串形式的 JSON」
  if (typeof content === "string") {
    return content;
  }
  // 如果是 array 結構（某些情況會回 content parts），我們把它串起來
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

// Cloudflare Workers 環境有 btoa，可以直接用
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
      messages,
      // gpt-5-mini：要用 max_completion_tokens，不能用 max_tokens
      max_tokens: 400,
      temperature: 0.7,
      response_format: { type: "json_object" }, // 強制回傳合法 JSON 字串
    }),
  });

  const json = await res.json();

  if (!json.choices || !json.choices[0] || !json.choices[0].message) {
    console.error("OpenAI invalid response for chat:", JSON.stringify(json));
    throw new Error("Invalid OpenAI response: " + JSON.stringify(json));
  }

  let reply = "";
  let category: ChatResult["category"] = "general";

  try {
    const contentRaw = json.choices[0].message.content;
    const contentStr = ensureStringContent(contentRaw);

    // JSON mode：contentStr 會是類似：
    // {"reply": "...", "category": "diet"}
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
    console.error("chatWithClassification parse error:", err);
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

/**
 * 將 LINE 傳來的 image buffer 丟給 OpenAI 做飲食判讀 + 營養估算
 * 回傳結構化結果，方便直接寫入 meal_logs。
 */
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
你是一位專業的營養師助手，請根據照片判斷餐點內容，並以 JSON 格式回傳。

請盡量用「數值」估算營養，不確定可以合理估計，不要留空。

JSON 欄位說明：

{
  "meal_type": "breakfast / lunch / dinner / snack 之類的餐別（用英文或中文皆可）",
  "food_name": "主餐名稱，例如：牛肉麵、雞腿便當",
  "description": "用 1-3 句描述餐點內容與主要食材",
  "carb_g":  碳水化合物克數（number）,
  "sugar_g": 糖分克數（number）,
  "protein_g": 蛋白質克數（number）,
  "fat_g": 脂肪克數（number）,
  "veggies_servings": 蔬菜份數（number）,
  "fruits_servings": 水果份數（number）,
  "calories_kcal": 熱量（大卡，number）
}

請「只」回傳 JSON，不要多加文字說明。
  `.trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
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
              },
            },
          ],
        } as any,
      ],
      max_completion_tokens: 400,
      response_format: { type: "json_object" },
      // 這裡不設定 temperature，讓模型自行決定（也避免未來參數限制問題）
    }),
  });

  const json = await res.json();

  if (!json.choices || !json.choices[0] || !json.choices[0].message) {
    console.error("OpenAI invalid response for meal image:", JSON.stringify(json));
    throw new Error("Invalid OpenAI image response: " + JSON.stringify(json));
  }

  const contentStr = ensureStringContent(json.choices[0].message.content);

  let parsed: any;
  try {
    parsed = JSON.parse(contentStr);
  } catch (e) {
    console.error("analyzeMealFromImage parse error:", e, "content:", contentStr);
    throw new Error("Failed to parse meal JSON: " + contentStr);
  }

  return {
    meal_type: parsed.meal_type ?? "",
    food_name: parsed.food_name ?? "",
    description: parsed.description ?? "",
    carb_g: safeNumber(parsed.carb_g),
    sugar_g: safeNumber(parsed.sugar_g),
    protein_g: safeNumber(parsed.protein_g),
    fat_g: safeNumber(parsed.fat_g),
    veggies_servings: safeNumber(parsed.veggies_servings),
    fruits_servings: safeNumber(parsed.fruits_servings),
    calories_kcal: safeNumber(parsed.calories_kcal),
    raw_json: parsed,
  };
}
