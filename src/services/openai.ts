export type ChatResult = {
  reply: string;
  category: "diet" | "emotion" | "health" | "general";
};

const VALID_CATEGORIES = ["diet", "emotion", "health", "general"] as const;

export async function chatWithClassification(
  env: any,
  messages: any[]
): Promise<ChatResult> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const openaiResponse = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
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

  let reply = "";
  let category: ChatResult["category"] = "general";

  try {
    const parsed = JSON.parse(rawContent);
    reply = parsed.reply ?? "";
    category = parsed.category ?? "general";

    if (!VALID_CATEGORIES.includes(category)) {
      category = "general";
    }
  } catch {
    reply =
      typeof rawContent === "string" && rawContent.trim().length > 0
        ? rawContent
        : "小咪這邊有點忙碌，等等再和你聊聊好嗎？";
    category = "general";
  }

  return { reply, category };
}

// src/services/openai.ts

export type MealAnalysisResult = {
  meal_type: string;          // breakfast / lunch / dinner / snack …（英文或中文都可以）
  food_name: string;          // 主餐名，如「牛肉麵」
  description: string;        // 比較完整的說明
  carb_g: number | null;
  sugar_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  veggies_servings: number | null;
  fruits_servings: number | null;
  calories_kcal: number | null;
  raw_json: any;              // 原始 JSON 結果，方便存 metadata
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa 在 Workers 環境是可用的
  return btoa(binary);
}

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
      model: "gpt-5-mini",
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
      max_tokens: 400,
      temperature: 0.4,
    }),
  });

  const json = await res.json();
  if (!json.choices?.[0]?.message?.content) {
    throw new Error("Invalid OpenAI image response: " + JSON.stringify(json));
  }

  const content: string = json.choices[0].message.content;

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("Failed to parse meal JSON: " + content);
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

