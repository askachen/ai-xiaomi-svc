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
  error: unknown,
  payload?: any
): Promise<void> {
  try {
    const err = error as any;
    const message =
      typeof err?.message === "string"
        ? err.message
        : typeof error === "string"
        ? error
        : JSON.stringify(error);
    const stack = typeof err?.stack === "string" ? err.stack : undefined;
    const payloadJson = payload !== undefined ? JSON.stringify(payload) : null;
    const nowIso = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO error_logs (source, message, stack, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(source, message, stack, payloadJson, nowIso)
      .run();

    console.error("[ERROR]", source, message);
  } catch (logErr) {
    // logging 本身也不能讓整個 worker 爆掉，所以要吃掉
    console.error("[ERROR][logErrorToDb failed]", logErr);
  }
}
