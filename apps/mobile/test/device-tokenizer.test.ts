// 기기 토크나이저가 어휘를 직접 읽어도 라이브러리 기본 적재와 같은 토큰 id 를 내는지 (Hermes 우회가 결과를 바꾸지 않는지).
// 서버가 받아 둔 EmbeddingGemma 토크나이저가 없으면 건너뛴다 — 모델을 받으려고 테스트가 네트워크를 쓰지 않는다.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Tokenizer } from "@huggingface/tokenizers";
import { loadTokenizer } from "../src/osiri/device-tokenizer.ts";

const dir = join(
  process.env.EMBED_CACHE_DIR ?? join(homedir(), ".cache", "osiri-models"),
  "onnx-community/embeddinggemma-2-ONNX",
);
const present = existsSync(join(dir, "tokenizer.json"));

test("직접 읽은 어휘 = 기본 적재 어휘 (토큰 id 동일)", {
  skip: !present && "토크나이저 캐시 없음",
}, () => {
  const json = readFileSync(join(dir, "tokenizer.json"), "utf8");
  const config = readFileSync(join(dir, "tokenizer_config.json"), "utf8");
  const { tokenizer, vocabSize } = loadTokenizer(json, config);
  const reference = new Tokenizer(JSON.parse(json), JSON.parse(config));
  assert.equal(vocabSize, 262_144);
  for (const text of [
    "task: search result | query: 상속 판례 요약",
    'title: none | text: 이번 주 보도자료를 블로그 글로 써줘 :) ▁"quoted" \\ back',
    "가 나 다 — 한글 낱글자, emoji 🎉, tabs\tand\nnewlines",
  ])
    assert.deepEqual(tokenizer.encode(text).ids, reference.encode(text).ids, text);
});
