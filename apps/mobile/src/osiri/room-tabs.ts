// 팀 방 탭 순서 — 기본 탭(BUILTIN_ROOM_TABS) + 운영자 탭(x:<id>)을 사용자가 저장한 순서(room.tabOrder)로 편다.
import { BUILTIN_ROOM_TABS, type TeamTab } from "../../../../packages/domain/src/osiri";

export const customTabId = (tab: TeamTab) => `x:${tab.id}`;

/** 저장된 순서를 앞에, 순서에 없는 새 탭은 기본 순서대로 뒤에 붙인다. 없어진 탭은 버린다. */
export function orderTabs(custom: TeamTab[], saved: string[] = []): string[] {
  const all = [...BUILTIN_ROOM_TABS, ...custom.map(customTabId)];
  const known = saved.filter((id, i) => all.includes(id) && saved.indexOf(id) === i);
  return [...known, ...all.filter((id) => !known.includes(id))];
}

/** id 를 한 칸 앞(-1)·뒤(+1)로. 끝이면 그대로. */
export function moveTab(order: string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
