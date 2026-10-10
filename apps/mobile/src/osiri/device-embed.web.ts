// 기기 임베딩 — 웹: transformers.js (WebGPU → WASM 폴백), EmbeddingGemma 2 q8 텍스트 전용 (0SIRI-SPEC §2.3 · §11.2).
// 모델은 앱에 넣지 않고 첫 호출 때 HF 허브에서 받아 브라우저 캐시에 둔다. 실패하면 throw — 호출자(tier0.ts)가 서버로 넘기고 배지를 붙인다.
import {
  EMBED_DTYPE as DTYPE,
  embedDocumentText,
  embedQueryText,
  EMBED_MODEL_ID as MODEL,
} from "../../../../packages/domain/src/osiri";
import type { DeviceBackend, DeviceModel, DeviceReport } from "./device-embed.types";
import { measureWith, normalize, unavailableReport, type Vec } from "./device-measure";

/** 웹은 첫 검색이 모델을 알아서 받는다 — 지우면 «기기 검색 끔» 을 함께 저장해야 다시 받지 않는다 (네이티브는 [받기] 를 눌러야만 받는다) */
export const DOWNLOADS_ON_FIRST_USE = true;

// 모델 id·양자화·접두어는 서버(embeddings.ts)와 같은 도메인 상수다 — 어긋나면 기기 벡터와 서버 벡터가 안 맞는다.
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
    return rows.map(normalize);
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
  return embed(texts.map((t) => (kind === "query" ? embedQueryText(t) : embedDocumentText(t))));
}

/** 9단계 실측: 로드 시간·문장당 지연·메모리·한국어 샘플 top-1. 실패도 리포트로 남긴다. */
export async function measureDevice(): Promise<DeviceReport> {
  if (!deviceAvailable()) return unavailableReport("WebAssembly 미지원");
  return measureWith(
    () => {
      loader ??= load();
      return loader;
    },
    embedOnDevice,
    () => {
      const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
      return memory ? Math.round(memory.usedJSHeapSize / 1048576) : undefined;
    },
  );
}

// ---- 설정 «기기» 카드가 쓰는 저장소 조작 ----
/** transformers.js 가 브라우저에 모델을 두는 캐시 이름 */
const MODEL_CACHE = "transformers-cache";
const modelCached = async (cache: Cache) =>
  (await cache.keys()).filter((request) => request.url.includes(MODEL));

export async function deviceModel(): Promise<DeviceModel> {
  if (typeof caches === "undefined") return { state: "unknown" };
  const files = await modelCached(await caches.open(MODEL_CACHE));
  return { state: files.length > 0 ? "ready" : "none" };
}
/** 첫 호출이 모델을 내려받아 올린다 (브라우저 캐시라 진행률은 받지 못한다) */
export async function prepareDevice(): Promise<undefined> {
  await embedOnDevice(["상태 확인"], "query");
}
export async function removeModel() {
  const cache = await caches.open(MODEL_CACHE);
  for (const request of await modelCached(cache)) await cache.delete(request);
}
