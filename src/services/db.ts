export async function getOrCreateUser(env: any, lineId: string): Promise<number> {
  // 1. 先找 user
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first();

  if (existing && (existing as any).id) {
    return (existing as any).id as number;
  }

  // 2. 沒有就建立一個新的
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (line_user_id, created_at, updated_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind(lineId, now, now)
    .run();

  // 3. 再查一次拿 id
  const created = await env.DB.prepare(
    `SELECT id FROM users WHERE line_user_id = ?1`
  )
    .bind(lineId)
    .first();

  if (!created || !(created as any).id) {
    throw new Error("Failed to create user");
  }

  return (created as any).id as number;
}

export async function logErrorToDb(
  env: any,
  source: string,
  error?: unknown,
  payload?: any
): Promise<void> {
  try {
    let message: string | null = null;
    let stack: string | null = null;

    if (error) {
      const err = error as any;

      if (typeof err?.message === "string") {
        message = err.message;
      } else if (typeof error === "string") {
        message = error as string;
      } else {
        message = JSON.stringify(error);
      }

      if (typeof err?.stack === "string") {
        stack = err.stack;
      }
    }

    const payloadJson =
      payload === undefined ? null : JSON.stringify(payload ?? null);

    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO error_logs (source, message, stack, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(
        source ?? "unknown",   // 保底不要是 undefined
        message,
        stack,
        payloadJson,
        nowIso
      )
      .run();

    // 同時在 console 印一下
    console.error("[ERROR]", source, message, payload);
  } catch (logErr) {
    // logging 自己壞掉也不能讓主流程炸掉
    console.error("[ERROR][logErrorToDb failed]", logErr);
  }
}
