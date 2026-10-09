// 0Siri 실시간 이벤트 버스 — 방 현황판·승인 카드·캐릭터 상태를 SSE 로 밀어낸다 (0SIRI-SPEC §4.3 "폴링으로 대체하지 않는다", §5).
// ponytail: 프로세스 내 EventEmitter. 서버 1대(파일럿 20명) 전제. 다중 인스턴스가 되면 Postgres LISTEN/NOTIFY 로 바꾼다.
import { EventEmitter } from "node:events";
import { PRESENCE_LABELS, type PresenceState } from "../../../../packages/domain/src/osiri.ts";

export type { PresenceState };
export type RoomEvent =
  | { type: "room.presence"; roomId: string; state: PresenceState; label: string }
  | { type: "approval"; roomId: string; approvalId: string; status: string }
  | { type: "board"; roomId: string }
  | { type: "message"; roomId: string; messageId: string }
  | { type: "goal"; roomId: string; goalId: string }
  | { type: "inbox" };

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly presence = new Map<string, { state: PresenceState; since: number }>();
  constructor() {
    this.emitter.setMaxListeners(1000);
  }
  publish(owner: string, event: RoomEvent) {
    this.emitter.emit(owner, event);
  }
  subscribe(owner: string, listener: (event: RoomEvent) => void): () => void {
    this.emitter.on(owner, listener);
    return () => this.emitter.off(owner, listener);
  }
  /** 캐릭터 상태는 한 곳에서만 구동한다 (§5 중복 구동 금지). "done" 은 짧게 보여주고 idle 로 돌아간다. */
  setPresence(owner: string, roomId: string, state: PresenceState, label: string) {
    const key = `${owner}:${roomId}`;
    const current = this.presence.get(key);
    if (current?.state === state) return;
    this.presence.set(key, { state, since: Date.now() });
    this.publish(owner, { type: "room.presence", roomId, state, label });
    if (state === "done") {
      const timer = setTimeout(() => {
        if (this.presence.get(key)?.state === "done")
          this.setPresence(owner, roomId, "idle", PRESENCE_LABELS.idle);
      }, 4000);
      timer.unref();
    }
  }
  getPresence(owner: string, roomId: string): PresenceState {
    return this.presence.get(`${owner}:${roomId}`)?.state ?? "idle";
  }
}
