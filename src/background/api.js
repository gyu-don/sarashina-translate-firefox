// Sarashina Translate API クライアント
// https://docs.sarashina.ai/api-reference/translate

export const ENDPOINT = "https://api.sarashina.ai/v1/translate";
const TIMEOUT_MS = 90_000;

export class ApiError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message);
    this.name = "ApiError";
    this.status = status; // 0 はネットワークエラー
    this.retryAfter = retryAfter;
  }

  /** 時間をおけば成功しうるか */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const STATUS_MESSAGES = {
  400: "リクエストが不正です",
  401: "APIキーが無効です。設定画面で確認してください",
  404: "APIのエンドポイントが見つかりません",
  413: "リクエストが大きすぎます",
  429: "レート制限に達しました",
  500: "Sarashina API でサーバーエラーが発生しました",
  503: "Sarashina API が一時的に利用できません",
};

export async function translate({ apiKey, text, source, target, fetchFn = fetch }) {
  if (!apiKey) throw new ApiError(401, "APIキーが設定されていません");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, source_lang: source, target_lang: target }),
      signal: controller.signal,
      credentials: "omit",
    });
  } catch (e) {
    throw new ApiError(0, `Sarashina API に接続できません (${e.name === "AbortError" ? "タイムアウト" : e.message})`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body && typeof body.message === "string") detail = body.message;
    } catch {
      // ボディが JSON でなければ無視
    }
    const base = STATUS_MESSAGES[res.status] || `HTTP ${res.status}`;
    const retryAfter = res.headers.get("Retry-After");
    throw new ApiError(res.status, detail ? `${base} (${detail})` : base, retryAfter);
  }

  const body = await res.json();
  if (!body || typeof body.translated_text !== "string") {
    throw new ApiError(500, "Sarashina API から想定外の応答が返りました");
  }
  return body.translated_text;
}
