// 기기 임베딩 실측 — 웹·네이티브가 같은 샘플과 같은 계산을 쓴다 (0SIRI-SPEC §22-9).
import {
  EMBED_DTYPE as DTYPE,
  EMBED_MODEL_ID as MODEL,
} from "../../../../packages/domain/src/osiri";
import type { DeviceBackend, DeviceReport } from "./device-embed.types";

export type Vec = number[];

export function dot(a: Vec, b: Vec) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** 단위 길이로 맞춘다 — 내적 = 코사인 유사도 */
export function normalize(v: ArrayLike<number>): Vec {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] as number) ** 2;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(v, (x) => x / norm);
}

export const unavailableReport = (reason: string): DeviceReport => ({
  available: false,
  backend: "none",
  model: MODEL,
  dtype: DTYPE,
  reason,
  measuredAt: new Date().toISOString(),
});

/** 로드 시간·문장당 지연·메모리·한국어 샘플 top-1. 실패도 리포트로 남긴다. */
export async function measureWith(
  ready: () => Promise<{ backend: DeviceBackend; loadMs: number }>,
  embed: (texts: string[], kind: "query" | "document") => Promise<Vec[]>,
  memoryMb: () => number | undefined,
): Promise<DeviceReport> {
  try {
    const { backend, loadMs } = await ready();
    const docs = SAMPLE.map((p) => p.doc);
    const started = performance.now();
    const docVecs = await embed(docs, "document");
    const queryVecs = await embed(
      SAMPLE.map((p) => p.query),
      "query",
    );
    const embedMsPer = Math.round((performance.now() - started) / (docs.length * 2));
    let hits = 0;
    queryVecs.forEach((q, i) => {
      const best = docVecs
        .map((d) => dot(q, d))
        .reduce((bi, s, j, arr) => (s > (arr[bi] as number) ? j : bi), 0);
      if (best === i) hits++;
    });
    return {
      available: true,
      backend,
      model: MODEL,
      dtype: DTYPE,
      loadMs,
      embedMsPer,
      dim: docVecs[0]?.length,
      memoryMb: memoryMb(),
      top1: { hits, total: SAMPLE.length },
      measuredAt: new Date().toISOString(),
    };
  } catch (e) {
    return unavailableReport(e instanceof Error ? e.message : String(e));
  }
}

// 한국어 샘플셋 — 서버 실측(tests/osiri-memories.test.ts)과 같은 성격의 기억 6건
const SAMPLE = [
  { query: "커피 취향", doc: "아메리카노는 얼음 없이, 설탕은 넣지 않는다" },
  { query: "운동 시간", doc: "아침 6시에 한강에서 5km 달린다" },
  { query: "회의 자료 어디", doc: "주간 회의 슬라이드는 드라이브 '팀/주간' 폴더에 둔다" },
  { query: "가족 생일", doc: "어머니 생신은 음력 3월 12일" },
  { query: "자주 가는 식당", doc: "점심은 회사 앞 '봉추찜닭'을 자주 간다" },
  { query: "휴가 계획", doc: "11월 둘째 주에 제주도 3박 4일" },
];
