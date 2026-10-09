export type DeviceBackend = "webgpu" | "wasm" | "none";
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
