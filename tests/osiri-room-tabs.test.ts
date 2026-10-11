// 팀 방 탭 순서: 저장한 순서가 앞, 새 탭은 뒤, 사라진 탭·중복은 버린다. 한 칸 옮기기는 끝에서 멈춘다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveTab, orderTabs } from "../apps/mobile/src/osiri/room-tabs.ts";
import { BUILTIN_ROOM_TABS } from "../packages/domain/src/osiri.ts";

const guide = { id: "guide", title: "안내", markdown: "#" };

test("탭 순서", () => {
  assert.deepEqual(orderTabs([]), [...BUILTIN_ROOM_TABS]);
  const order = orderTabs([guide], ["x:guide", "goals", "gone", "goals"]);
  assert.deepEqual(order.slice(0, 2), ["x:guide", "goals"]);
  assert.equal(order.length, BUILTIN_ROOM_TABS.length + 1);
  assert.ok(!order.includes("gone"));
  assert.deepEqual(moveTab(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveTab(["a", "b"], "a", -1), ["a", "b"]);
  assert.deepEqual(moveTab(["a", "b"], "b", 1), ["a", "b"]);
});
