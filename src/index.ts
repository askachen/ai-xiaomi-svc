export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ---------------------------
    // 0. API Key 驗證
    // ---------------------------
    const apiKey = request.headers.get("x-api-key");

    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // ---------------------------
    // Make.com API
    // ---------------------------
    if (request.method === "POST" && pathname === "/api/external/make/chat") {
      try {
        const body = await request.json();

        const {
          lineId,
          userPrompt,
          source = "make",
          sessionId = crypto.randomUUID(),
          metadata = {},
        } = body;

        if (!lineId || !userPrompt) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Missing required fields: lineId or userPrompt",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        await env.DB.prepare(
          `INSERT INTO chat_logs (line_id, role, content, created_at)
           VALUES (?1, 'user', ?2, datetime('now'))`
        ).bind(lineId, userPrompt).run();

        const assistantReply = `收到你的訊息：「${userPrompt}」`;

        await env.DB.prepare(
          `INSERT INTO chat_logs (line_id, role, content, created_at)
           VALUES (?1, 'assistant', ?2, datetime('now'))`
        ).bind(lineId, assistantReply).run();

        return new Response(
          JSON.stringify({
            success: true,
            replyText: assistantReply,
            replyId: crypto.randomUUID(),
            sessionId,
            source,
            echo: { lineId, userPrompt, metadata },
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "AI小咪後端運作正常",
      }),
      { headers: { "content-type": "application/json" } }
    );
  },
} satisfies ExportedHandler<Env>;
