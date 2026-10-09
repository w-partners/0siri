// 0Siri 서버 임베딩 — EmbeddingGemma 2 ONNX q8, 텍스트 전용 (0SIRI-SPEC §11 티어 0, §22-5 "서버 임베딩도 q8 확정").
// 모델 파일은 레포에 넣지 않는다. 첫 호출 때 HF 허브에서 내려받아 EMBED_CACHE_DIR 에 캐시한다.
import { homedir } from "node:os";
import { join } from "node:path";
import { AutoConfig, AutoModel, AutoTokenizer, env } from "@huggingface/transformers";
import {
  EMBED_DTYPE as DEFAULT_EMBED_DTYPE,
  EMBED_MODEL_ID,
  embedDocumentText,
  embedQueryText,
} from "../../../../packages/domain/src/osiri.ts";

export const EMBED_MODEL = process.env.EMBED_MODEL ?? EMBED_MODEL_ID;
export const EMBED_DTYPE = process.env.EMBED_DTYPE ?? DEFAULT_EMBED_DTYPE;
/** MRL 잘라내기 차원 (128/256/512/768). 기본 768 = 원본. 바꾸면 기존 기억 벡터와 호환되지 않는다 — 테이블 생성 시 고정된다. */
export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 768);
/** 서버·테스트가 같은 캐시를 쓴다 — 테스트마다 299MB 를 다시 받지 않게. */
env.cacheDir = process.env.EMBED_CACHE_DIR ?? join(homedir(), ".cache", "osiri-models");

export const asQuery = embedQueryText;
export const asDocument = embedDocumentText;

type Loaded = {
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
};
let loading: Promise<Loaded> | undefined;
function load(): Promise<Loaded> {
  loading ??= (async () => {
    const config = await AutoConfig.from_pretrained(EMBED_MODEL);
    // 텍스트 전용: 비전·오디오 인코더를 내려받지 않는다 (850MB → 299MB)
    (config as { vision_config?: unknown }).vision_config = null;
    (config as { audio_config?: unknown }).audio_config = null;
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(EMBED_MODEL),
      AutoModel.from_pretrained(EMBED_MODEL, { config, dtype: EMBED_DTYPE as "q8" }),
    ]);
    return { tokenizer, model };
  })().catch((error) => {
    // 실패한 적재를 붙들고 있지 않는다 — 다음 호출이 다시 시도한다 (네트워크 일시 장애로 영구 고장 방지)
    loading = undefined;
    throw error;
  });
  return loading;
}

/** 정규화된 벡터(단위 길이)를 돌려준다 — 내적 = 코사인 유사도. 이미 접두어(`asQuery`/`asDocument`)가 붙은 텍스트를 받는다. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { tokenizer, model } = await load();
  const inputs = await tokenizer(texts, { padding: true, truncation: true });
  const output = (await model(inputs)) as {
    sentence_embedding: { dims: number[]; data: Float32Array };
  };
  const [rows, dim] = output.sentence_embedding.dims as [number, number];
  const data = output.sentence_embedding.data;
  const vectors: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const slice = Array.from(data.subarray(r * dim, r * dim + EMBED_DIM));
    // MRL: 잘라낸 뒤 재정규화 (768 이면 norm≈1 이라 무해)
    const norm = Math.sqrt(slice.reduce((s, v) => s + v * v, 0)) || 1;
    vectors.push(slice.map((v) => v / norm));
  }
  return vectors;
}

/** 서버 기동 시 미리 내려받아 첫 검색이 느리지 않게 한다. 실패는 호출자가 로그로 남긴다 — 조용히 삼키지 않는다. */
export const warmUp = () => load().then(() => undefined);
