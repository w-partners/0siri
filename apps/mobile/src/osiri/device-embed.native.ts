// 기기 임베딩 — Android/iOS 스텁 (0SIRI-SPEC §2.3 · §11, 마스터 2026-10-09 "기기 모델 실패시 서버로 넘길 것").
// LiteRT-LM/onnx 런타임은 아직 번들하지 않았다 → 티어 0/1 을 건너뛰고 서버로 간다. 조용히 넘기지 않는다:
// 호출자는 `available=false` 와 reason 을 받아 "서버에서 답함" 배지를 붙인다.
import type { DeviceReport } from "./device-embed.types";

export const DEVICE_REASON = "android: on-device runtime not bundled (LiteRT-LM 미착수)";

export function deviceAvailable() {
  return false;
}
export async function embedOnDevice(_texts: string[], _kind: "query" | "document") {
  throw new Error(DEVICE_REASON);
  // biome-ignore lint/correctness/noUnreachable: 타입 때문에 남긴 반환
  return [] as number[][];
}
export async function measureDevice(): Promise<DeviceReport> {
  return {
    available: false,
    backend: "none",
    model: "-",
    dtype: "-",
    reason: DEVICE_REASON,
    measuredAt: new Date().toISOString(),
  };
}
