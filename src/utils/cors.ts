export const EULA_CORS_HEADERS: Record<string, string> = {
  // 如果要更嚴謹，可以改成指定 origin，例如 'https://liff.line.me'
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
