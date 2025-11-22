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
