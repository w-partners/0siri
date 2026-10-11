// 도구를 불러 놓고 종료 사유를 stop 으로 주는 백엔드 — 도구가 실행되도록 tool_calls 로 바로잡는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolCallsFinish } from "../apps/server/src/engine/tanstack-agent.ts";

const fake = (chunks: object[]) => ({
  async *chatStream() {
    yield* chunks;
  },
});
const finish = async (chunks: object[]) => {
  const out: { type?: string; finishReason?: string }[] = [];
  for await (const c of toolCallsFinish(fake(chunks)).chatStream()) out.push(c);
  return out.at(-1)?.finishReason;
};

test("도구 호출 뒤 stop/null → tool_calls, 도구 없거나 length 면 그대로", async () => {
  const call = { type: "TOOL_CALL_END", toolCallId: "c1" };
  assert.equal(await finish([call, { type: "RUN_FINISHED", finishReason: "stop" }]), "tool_calls");
  assert.equal(await finish([call, { type: "RUN_FINISHED" }]), "tool_calls");
  assert.equal(await finish([call, { type: "RUN_FINISHED", finishReason: "length" }]), "length");
  assert.equal(await finish([{ type: "RUN_FINISHED", finishReason: "stop" }]), "stop");
});
