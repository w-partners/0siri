import assert from "node:assert/strict";
import test from "node:test";
import { DEVICE_ANSWER_LABEL } from "../../../packages/domain/src/osiri.ts";
import {
  DEVICE_SYSTEM_PROMPT,
  deviceAnswerLabel,
  deviceAnswerMetadata,
  deviceChatMessages,
  downloadGate,
  withContent,
} from "../src/osiri/device-chat-logic.ts";

test("큰 층 받기: Wi-Fi 만 묻지 않고 받고, 모바일 데이터·모름은 확인, 연결 없음은 막는다", () => {
  assert.equal(downloadGate("wifi"), "start");
  assert.equal(downloadGate("metered"), "confirm");
  assert.equal(downloadGate("unknown"), "confirm");
  assert.equal(downloadGate("offline"), "offline");
});

test("기기 입력: 시스템 문장 + 사용자·답변 글만, 도구 메시지와 빈 말풍선은 뺀다", () => {
  const messages = deviceChatMessages([
    { id: "1", role: "user", content: "안녕" },
    { id: "2", role: "tool", content: "{}" },
    { id: "3", role: "assistant", content: "반가워요" },
    { id: "4", role: "user", content: [{ type: "text", text: "날씨" }, { type: "binary" }] },
    { id: "5", role: "assistant", content: "" },
  ]);
  assert.deepEqual(messages, [
    { role: "system", content: DEVICE_SYSTEM_PROMPT },
    { role: "user", content: "안녕" },
    { role: "assistant", content: "반가워요" },
    { role: "user", content: "날씨" },
  ]);
});

test("기기 입력: 예산을 넘으면 오래된 것부터 버리고, 답변으로 시작하지 않는다", () => {
  const messages = deviceChatMessages(
    [
      { id: "1", role: "user", content: "a".repeat(50) },
      { id: "2", role: "assistant", content: "b".repeat(50) },
      { id: "3", role: "user", content: "c".repeat(50) },
    ],
    120,
  );
  assert.deepEqual(
    messages.slice(1).map((m) => m.role),
    ["user"],
  );
  // 방금 보낸 말은 예산보다 길어도 넣는다
  const long = deviceChatMessages([{ id: "1", role: "user", content: "x".repeat(500) }], 10);
  assert.equal(long.at(-1)?.content.length, 500);
});

test("기기 답변 표시: metadata 가 있으면 «기기에서 답함 · Gemma 4 E2B», 아니면 없음", () => {
  assert.equal(
    deviceAnswerLabel({ id: "a", role: "assistant", metadata: deviceAnswerMetadata() }),
    DEVICE_ANSWER_LABEL,
  );
  assert.equal(DEVICE_ANSWER_LABEL, "기기에서 답함 · Gemma 4 E2B");
  assert.equal(deviceAnswerLabel({ id: "b", role: "assistant", content: "서버 답" }), undefined);
});

test("흘러나오는 답: 같은 id 의 내용만 바꾸고 나머지·metadata 는 그대로", () => {
  const before = [
    { id: "u", role: "user", content: "질문" },
    { id: "d", role: "assistant", content: "", metadata: deviceAnswerMetadata() },
  ];
  const after = withContent(before, "d", "답의 앞부분");
  assert.equal(after[1]?.content, "답의 앞부분");
  assert.deepEqual(after[1]?.metadata, deviceAnswerMetadata());
  assert.equal(after[0], before[0]);
  assert.equal(before[1]?.content, "");
});
