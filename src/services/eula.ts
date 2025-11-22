export type EulaVersion = {
  id: number;
  version: string;
  url: string;
};

export async function getLatestEula(env: any): Promise<EulaVersion | null> {
  const row = await env.DB.prepare(
    `SELECT id, version, url
     FROM eula_versions
     ORDER BY
       COALESCE(effective_from, created_at) DESC,
       id DESC
     LIMIT 1`
  ).first();

  if (!row) return null;

  return {
    id: (row as any).id as number,
    version: (row as any).version as string,
    url: (row as any).url as string,
  };
}

export async function hasUserAgreedLatestEula(
  env: any,
  userId: number
): Promise<{
  agreed: boolean;
  latestEula: EulaVersion | null;
}> {
  const latestEula = await getLatestEula(env);
  if (!latestEula) {
    // 系統尚未設定任何 EULA，視為不檢查
    return { agreed: true, latestEula: null };
  }

  const consent = await env.DB.prepare(
    `SELECT 1
       FROM eula_consents
      WHERE user_id = ?1
        AND eula_version_id = ?2
      LIMIT 1`
  )
    .bind(userId, latestEula.id)
    .first();

  return {
    agreed: !!consent,
    latestEula,
  };
}
