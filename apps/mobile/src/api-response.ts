import { t } from "./strings";

/** 실패한 요청. 문장만으로는 못 가르는 분기(409 이미 처리됨 · 403 권한 · 오류 kind)를 화면이 직접 본다. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 서버가 준 오류 본문 그대로 (예: { error, kind } · { error, status }) */
    readonly body: unknown,
  ) {
    super(message);
  }
}

/**
 * Read an API response without assuming every route answers with JSON.
 * Plain-text 404s, proxy HTML pages and empty bodies must not surface as
 * "Unexpected token" parse errors in the UI.
 */
export async function readApiPayload<T>(response: Response, fallback?: string): Promise<T> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
    throw new ApiError(
      typeof error === "string" ? error : (fallback ?? t.app.api.requestFailed(response.status)),
      response.status,
      payload,
    );
  }
  if (payload === undefined) throw new Error(t.app.api.unreadable(response.status));
  return payload as T;
}
