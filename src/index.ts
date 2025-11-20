export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

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

        // ---- 1. 寫入 user prompt 進 D1 ----
        await env.DB.prepare(
          `INSERT INTO chat_logs (line_id, role, content, created_at)
           VALUES (?1, 'user', ?2, datetime('now'))`
        )
          .bind(lineId, userPrompt)
          .run();

        // ---- 2. AI 回覆 - 暫時是 stub, 之後可以串 LLM ----
        const assistantReply = `收到你的訊息：「${userPrompt}」`;

        // ---- 3. 寫入 assistant 回應 ----
        await env.DB.prepare(
          `INSERT INTO chat_logs (line_id, role, content, created_at)
           VALUES (?1, 'assistant', ?2, datetime('now'))`
        )
          .bind(lineId, assistantReply)
          .run();

        // ---- 4. 回傳給 Make.com ----
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

    // ---------------------------
    // Default Response
    // ---------------------------
    return new Response(
      JSON.stringify({
        success: true,
        message: "AI小咪後端運作正常",
      }),
      { headers: { "content-type": "application/json" } }
    );
  },
} satisfies ExportedHandler<Env>;
