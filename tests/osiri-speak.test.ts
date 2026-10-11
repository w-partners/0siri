// 음성 답: 받는 중에는 끝난 문장까지만 읽고(«3.5» 를 자르지 않는다), 마크다운·주소는 읽지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sentenceEnd, speakable } from "../apps/mobile/src/osiri/speak-text.ts";

test("받는 중에는 끝난 문장까지, 다 받으면 끝까지", () => {
  const text = "오늘은 3.5도예요. 비가 와요! 우산";
  const end = sentenceEnd(text, 0, false);
  assert.equal(text.slice(0, end), "오늘은 3.5도예요. 비가 와요! ");
  assert.equal(sentenceEnd(text, end, false), end);
  assert.equal(sentenceEnd(text, end, true), text.length);
  assert.equal(sentenceEnd("첫 줄\n둘", 0, false), 4);
});

test("코드·주소·기호는 읽지 않는다", () => {
  assert.equal(
    speakable("**날씨**: [기상청](https://x.kr) 참고\n```js\nx()\n``` 끝 https://a.b/c"),
    "날씨: 기상청 참고 끝",
  );
});
