// src/services/line.ts

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

export async function replyTextMessage(
  env: any,
  replyToken: string,
  text: string
): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }

  const res = await fetch(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LINE reply error ${res.status}: ${body}`);
  }
}
