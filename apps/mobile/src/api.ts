import { Platform } from "react-native";
import { readApiPayload } from "./api-response";
import { track } from "./osiri/diag";
import { t } from "./strings";

// 0Siri: 서버가 웹 빌드를 같은 포트에서 내므로(WEB_DIST) 웹은 자기 origin 이 곧 API 다 — expo 개발서버(8081)만 예외.
const sameOrigin =
  Platform.OS === "web" && typeof location !== "undefined" && location.port !== "8081"
    ? location.origin
    : "";
export const API_URL = (
  sameOrigin ||
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");
// 0Siri: 서버 주소는 빌드가 정한다 — 앱에서 바꾸는 화면은 없다(마스터 2026-10-10).
export function apiBase() {
  return API_URL;
}

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const verb = method ?? (body === undefined ? "GET" : "POST");
    const t0 = Date.now();
    // 오류 보고에 실을 요청 기록 — 경로·상태·시간만(본문은 싣지 않는다)
    const done = (status: number | string, error?: string) =>
      track("api", {
        verb,
        path: path.split("?")[0],
        status,
        ms: Date.now() - t0,
        ...(error && { error }),
      });
    const response = await fetch(`${apiBase()}${path}`, {
      method: verb,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    }).catch((e) => {
      done("network", String(e));
      throw e;
    });
    try {
      const payload = await readApiPayload<T>(response);
      done(response.status);
      return payload;
    } catch (e) {
      done(response.status, e instanceof Error ? e.message : String(e));
      throw e;
    }
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
