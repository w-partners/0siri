import { Platform } from "react-native";
import { readApiPayload } from "./api-response";
import { t } from "./strings";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");
// 0Siri: 서버 주소는 로그인 화면에서 바꿀 수 있다(도메인 미정·실기기 테스트). 빈 값이면 빌드 기본값.
let override = "";
export function apiBase() {
  return override || API_URL;
}
export function setApiBase(url: string) {
  override = url.trim().replace(/\/$/, "");
}

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${apiBase()}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await readApiPayload<T>(response);
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${apiBase()}${path}`;
  }
}

export async function createSession(
  accessKey?: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${apiBase()}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  const payload = await readApiPayload<{ token: string; mode: "sample" | "live" }>(
    response,
    t.app.api.openFailed,
  );
  return payload;
}
