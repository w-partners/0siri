// 기기 임베딩 — 웹: transformers.js (WebGPU → WASM 폴백), EmbeddingGemma 2 q8 텍스트 전용 (0SIRI-SPEC §2.3 · §11.2).
// 모델은 앱에 넣지 않고 첫 호출 때 HF 허브에서 받아 브라우저 캐시에 둔다. 실패하면 throw — 호출자(tier0.ts)가 서버로 넘기고 배지를 붙인다.
import type { DeviceBackend, DeviceReport } from "./device-embed.types";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const DTYPE = "q8";
type Vec = number[];
type Embedder = {
  embed: (texts: string[]) => Promise<Vec[]>;
  backend: DeviceBackend;
  loadMs: number;
};
let loader: Promise<Embedder> | undefined;

// ponytail: Metro 는 onnxruntime-web 의 비리터럴 import() 를 번들하지 못한다 → 런타임에 CDN ESM 으로 받는다 (브라우저가 캐시).
// 버전은 package.json 의 @huggingface/transformers 와 같은 메이저로 고정. 타입만 패키지에서 가져온다.
const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
const importUrl = new Function("u", "return import(u)") as (
  u: string,
) => Promise<typeof import("@huggingface/transformers")>;

async function load(): Promise<Embedder> {
  const started = performance.now();
  const tf = await importUrl(CDN);
  const config = await tf.AutoConfig.from_pretrained(MODEL);
  // 서버와 동일: 비전·오디오 가중치는 받지 않는다 (embeddings.ts 참조)
  (config as unknown as { vision_config: null; audio_config: null }).vision_config = null;
  (config as unknown as { vision_config: null; audio_config: null }).audio_config = null;
  const tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL);
  const backend: DeviceBackend = "gpu" in navigator ? "webgpu" : "wasm";
  const model = await tf.AutoModel.from_pretrained(MODEL, {
    config,
    dtype: DTYPE,
    device: backend,
  });
  const embed = async (texts: string[]) => {
    const inputs = tokenizer(texts, { padding: true, truncation: true });
    const output = (await model(inputs)) as { sentence_embedding?: { tolist(): Vec[] } };
    const rows = output.sentence_embedding?.tolist();
    if (!rows) throw new Error("모델 출력에 sentence_embedding 이 없습니다");
    return rows.map((v) => {
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  };
  return { embed, backend, loadMs: Math.round(performance.now() - started) };
}

export function deviceAvailable() {
  return typeof WebAssembly !== "undefined";
}
export async function embedOnDevice(texts: string[], kind: "query" | "document"): Promise<Vec[]> {
  if (!deviceAvailable()) throw new Error("web: WebAssembly 미지원 브라우저");
  loader ??= load().catch((e) => {
    loader = undefined; // 다음 호출에 다시 시도
    throw e;
  });
  const { embed } = await loader;
  const prefix = kind === "query" ? "task: search result | query: " : "title: none | text: ";
  return embed(texts.map((t) => prefix + t));
}

/** 9단계 실측: 로드 시간·문장당 지연·메모리·한국어 샘플 top-1. 실패도 리포트로 남긴다. */
export async function measureDevice(): Promise<DeviceReport> {
  const measuredAt = new Date().toISOString();
  if (!deviceAvailable())
    return {
      available: false,
      backend: "none",
      model: MODEL,
      dtype: DTYPE,
      reason: "WebAssembly 미지원",
      measuredAt,
    };
  try {
    loader ??= load();
    const { backend, loadMs } = await loader;
    const docs = SAMPLE.map((p) => p.doc);
    const started = performance.now();
    const docVecs = await embedOnDevice(docs, "document");
    const queryVecs = await embedOnDevice(
      SAMPLE.map((p) => p.query),
      "query",
    );
    const embedMsPer = Math.round((performance.now() - started) / (docs.length * 2));
    let hits = 0;
    queryVecs.forEach((q, i) => {
      const best = docVecs
        .map((d) => dot(q, d))
        .reduce((bi, s, j, arr) => (s > arr[bi] ? j : bi), 0);
      if (best === i) hits++;
    });
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      available: true,
      backend,
      model: MODEL,
      dtype: DTYPE,
      loadMs,
      embedMsPer,
      dim: docVecs[0]?.length,
      memoryMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : undefined,
      top1: { hits, total: SAMPLE.length },
      measuredAt,
    };
  } catch (e) {
    return {
      available: false,
      backend: "none",
      model: MODEL,
      dtype: DTYPE,
      reason: e instanceof Error ? e.message : String(e),
      measuredAt,
    };
  }
}

export function dot(a: Vec, b: Vec) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
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
