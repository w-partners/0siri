export type DeviceBackend = "webgpu" | "wasm" | "cpu" | "none";
/** 9단계 기기 실측 리포트 (0SIRI-SPEC §22-9). 통과(품질·속도) 전에는 티어 1 플래그를 켜지 않는다. */
export interface DeviceReport {
  available: boolean;
  backend: DeviceBackend;
  model: string;
  dtype: string;
  loadMs?: number;
  embedMsPer?: number; // 문장 1개당 평균
  dim?: number;
  memoryMb?: number; // performance.memory 가 있는 브라우저만
  top1?: { hits: number; total: number }; // 한국어 샘플셋 top-1 적중
  reason?: string;
  measuredAt: string;
}

/** 모델을 올리고 문장 하나를 돌려 잰 값 — 설정 «기기» 카드가 준비됨 옆에 보인다 */
export interface DevicePrepared {
  loadMs: number;
  embedMs: number;
}
/** 기기에 모델 파일이 있는가. unknown = 이 환경에서는 조회할 수 없다, oom = 지난번에 올리다 앱이 꺼졌다 */
export interface DeviceModel {
  state: "ready" | "none" | "unknown" | "oom";
  reason?: string;
  prepared?: DevicePrepared;
}
export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
}
/** 메모리가 모자라 모델을 올리지 못했다 — 화면이 «메모리 부족» 상태로 가른다 */
export class DeviceMemoryError extends Error {
  override name = "DeviceMemoryError";
}
