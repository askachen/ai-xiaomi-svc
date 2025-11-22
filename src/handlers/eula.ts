// src/handlers/eula.ts
import { getOrCreateUser, logErrorToDb } from "../services/db";
import { getLatestEula } from "../services/eula";
import { EULA_CORS_HEADERS } from "../utils/cors";

export async function handleEulaConsent(
  request: Request,
  env: any,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      agreed,
      eulaVersion, // 前端送 "V2"，這裡以 DB 最新版為主
      agreedAt,
      lineUserId,
      displayName,
      liffContext,
    } = body as any;

    if (!lineUserId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing lineUserId",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...EULA_CORS_HEADERS,
          },
        }
      );
    }

    // 沒同意就不寫入，只回應一聲
    if (!agreed) {
      return new Response(
        JSON.stringify({
          success: true,
          agreed: false,
          message: "User declined EULA.",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...EULA_CORS_HEADERS,
          },
        }
      );
    }

    // 找 / 建 user
    const userId = await getOrCreateUser(env, lineUserId);

    // 取得最新 EULA
    const latestEula = await getLatestEula(env);
    if (!latestEula) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "No EULA version configured.",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...EULA_CORS_HEADERS,
          },
        }
      );
    }

    // 檢查是否已經同意過這個版本
    const existing = await env.DB.prepare(
      `SELECT id
         FROM eula_consents
        WHERE user_id = ?1
          AND eula_version_id = ?2
        LIMIT 1`
    )
      .bind(userId, latestEula.id)
      .first();

    const nowIso = new Date().toISOString();
    const acceptedAtValue = agreedAt || nowIso;

    // 從 header 抓一些環境資訊存進去（可當 audit 資料）
    const ipAddress =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("x-forwarded-for") ||
      null;
    const userAgent = request.headers.get("User-Agent") || null;
    const channel = "liff"; // 你也可以用 "line_liff_eula" 之類更具體的字

    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO eula_consents
           (user_id, eula_version_id, accepted_at, channel, ip_address, user_agent)
         VALUES (?1,       ?2,             ?3,          ?4,      ?5,         ?6)`
      )
        .bind(
          userId,
          latestEula.id,
          acceptedAtValue,
          channel,
          ipAddress,
          userAgent
        )
        .run();
    }

    return new Response(
      JSON.stringify({
        success: true,
        agreed: true,
        alreadyAgreed: !!existing,
        eulaVersion: latestEula.version,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...EULA_CORS_HEADERS,
        },
      }
    );
  } catch (err: any) {
    await logErrorToDb(env, "eula_consent", err, {
      path: "/api/external/line/eula/consent",
      method: "POST",
      // 小心不要存太多個資，這裡只放 lineUserId 就好
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: err?.message ?? String(err),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...EULA_CORS_HEADERS,
        },
      }
    );
  }
}
