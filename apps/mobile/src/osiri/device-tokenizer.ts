// 기기 토크나이저 — tokenizer.json 을 Hermes 에서 읽는다.
// 왜 따로 있나: Hermes 객체는 속성을 약 19만 6천 개까지만 담는다. JSON.parse 가 어휘 262,144개짜리 객체를 만들면
// 뒤쪽(id ≈ 196,607 이상) 토큰이 오류 없이 빠지고 — ':'·'▁'·한글 낱글자가 여기 있다 — 토크나이저가 그것들을 바이트로 쪼갠다.
// 그러면 벡터가 서버와 어긋난다(Flip 실측 코사인 0.59~0.89). 그래서 어휘만 문자열에서 직접 읽어 Map 으로 넘긴다.
import { Tokenizer } from "@huggingface/tokenizers";

const VOCAB_KEY = '"vocab"';

/** `"vocab": { "tok": 0, ... }` 를 직접 읽는다 — 값이 0,1,2… 순서인지 확인하고, 아니면 멈춘다 */
function readVocab(text: string, from: number): { keys: string[]; start: number; end: number } {
  const start = text.indexOf("{", from);
  if (start < 0) throw new Error("tokenizer.json: vocab 객체가 없습니다");
  const keys: string[] = [];
  const space = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;
  let i = start + 1;
  for (;;) {
    while (space(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i) === 125 /* } */) return { keys, start, end: i };
    if (text.charCodeAt(i) !== 34 /* " */)
      throw new Error(`tokenizer.json: vocab ${keys.length}번째 키가 문자열이 아닙니다`);
    // 닫는 따옴표: 앞의 역슬래시가 짝수 개인 따옴표
    let close = text.indexOf('"', i + 1);
    for (;;) {
      let slashes = 0;
      while (text.charCodeAt(close - 1 - slashes) === 92 /* \ */) slashes++;
      if (slashes % 2 === 0) break;
      close = text.indexOf('"', close + 1);
    }
    const raw = text.slice(i + 1, close);
    const key = raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw;
    i = close + 1;
    while (space(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i++) !== 58 /* : */)
      throw new Error(`tokenizer.json: vocab "${key}" 뒤에 ':' 가 없습니다`);
    while (space(text.charCodeAt(i))) i++;
    let id = 0;
    for (let c = text.charCodeAt(i); c >= 48 && c <= 57; c = text.charCodeAt(++i))
      id = id * 10 + c - 48;
    if (id !== keys.length)
      throw new Error(
        `tokenizer.json: vocab id 가 순서대로가 아닙니다 (${keys.length}번째가 ${id})`,
      );
    keys.push(key);
    while (space(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i) === 44 /* , */) i++;
  }
}

export function loadTokenizer(tokenizerJson: string, tokenizerConfigJson: string) {
  const at = tokenizerJson.indexOf(VOCAB_KEY, tokenizerJson.indexOf('"model"'));
  if (at < 0) throw new Error("tokenizer.json: model.vocab 가 없습니다");
  const { keys, start, end } = readVocab(tokenizerJson, at + VOCAB_KEY.length);
  const tokenizer = JSON.parse(
    `${tokenizerJson.slice(0, start)}{}${tokenizerJson.slice(end + 1)}`,
  ) as { model: { vocab: unknown } };
  // 라이브러리는 vocab 을 Object.entries 로 Map 에 옮긴다 — 큰 객체 대신 같은 항목을 돌려주는 Proxy 를 준다
  const ids = new Map(keys.map((key, id) => [key, id]));
  tokenizer.model.vocab = new Proxy(
    {},
    {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === "string" && ids.has(key)
          ? { value: ids.get(key), enumerable: true, configurable: true, writable: false }
          : undefined,
      get: (_target, key) => (typeof key === "string" ? ids.get(key) : undefined),
      has: (_target, key) => typeof key === "string" && ids.has(key),
    },
  );
  return {
    tokenizer: new Tokenizer(tokenizer, JSON.parse(tokenizerConfigJson)),
    vocabSize: keys.length,
  };
}
