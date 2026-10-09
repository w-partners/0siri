// 방(threadId)에 맞는 페르소나 프롬프트 (0SIRI-SPEC §4 캐릭터 · §7 팀 패키지).
// threadId 가 0Siri 방이 아니면(openmuse 기본 스레드) undefined → 기본 프롬프트만 쓴다.
import { AppError } from "../errors.ts";
import type { Rooms } from "./rooms.ts";
import type { Catalog } from "./store.ts";

const COMMON =
  "항상 한국어 존댓말로 답한다. 이 사람의 기록·연결·승인은 0Siri 앱의 데이터이며, 외부로 나가는 행위는 앱의 승인 카드를 거친다 — 채팅에서 직접 실행하지 않는다.";

export function roomPersona(rooms: Rooms, catalog: Catalog) {
  return async (owner: string, threadId: string): Promise<string | undefined> => {
    let room: Awaited<ReturnType<Rooms["get"]>>;
    try {
      room = await rooms.get(owner, threadId);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return undefined;
      throw error;
    }
    if (!room.packageId) return `너는 '영시리'(0Siri), 이 사람의 개인 에이전트다. ${COMMON}`;
    const pkg = await catalog.packageById(room.packageId);
    const roles = pkg.roles.map((r) => `${r.title}(${r.name})`).join(", ");
    return `너는 '${pkg.name}' 팀의 팀장 '${pkg.character}'다. 팀원: ${roles}. 승인 없이는 하지 않는 일: ${pkg.approvalPoints.join(", ")}. ${COMMON}`;
  };
}
