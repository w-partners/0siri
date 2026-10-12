import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverTimes } from "../apps/server/src/osiri/message-times.ts";

const NOW = Date.parse("2026-10-12T00:00:00Z");
const askedAt = Date.parse("2026-10-11T12:14:09.973Z");

test("옛 메시지 시각 — 저장값 > id 의 ms > 10분 안 색인 시각, 나머지는 근사", () => {
  const messages = [
    { id: "a0" }, // 앞 시각이 없다 → 아무것도 없다
    { id: `user-${askedAt}-4gag8y` },
    { id: "answer-fast" }, // 질문 6초 뒤 색인 → 정확
    { id: "tool-call" }, // 색인 안 됨 → 근사
    { id: `user-${askedAt + 60_000}-x` },
    { id: "answer-backfill" }, // 하루 뒤 일괄 색인 → 믿지 않고 근사
    { id: "saved" },
    { id: `user-${NOW + 60_000}-future` }, // 미래 ms 는 거짓 → 근사
  ];
  const indexed = new Map([
    ["answer-fast", new Date(askedAt + 6_000)],
    ["answer-backfill", new Date(askedAt + 86_400_000)],
  ]);
  const { times, approx } = recoverTimes(
    messages,
    { saved: "2026-10-11T13:00:00.000Z" },
    indexed,
    NOW,
  );
  assert.deepEqual(times, {
    [`user-${askedAt}-4gag8y`]: new Date(askedAt).toISOString(),
    "answer-fast": new Date(askedAt + 6_000).toISOString(),
    [`user-${askedAt + 60_000}-x`]: new Date(askedAt + 60_000).toISOString(),
    saved: "2026-10-11T13:00:00.000Z",
  });
  assert.deepEqual(approx, {
    "tool-call": new Date(askedAt + 6_000).toISOString(),
    "answer-backfill": new Date(askedAt + 60_000).toISOString(),
    [`user-${NOW + 60_000}-future`]: "2026-10-11T13:00:00.000Z",
  });
});
