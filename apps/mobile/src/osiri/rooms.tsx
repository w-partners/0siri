// 0Siri 방 목록(화면 2)·팀 채팅방(화면 3)·SSE 스트림 — «0Siri 종합 기획» §03, 계약은 docs/0siri-api-contract.md.
// 타입은 서버 정의를 type-import, 라벨·목록은 packages/domain/src/osiri.ts 에서만 가져온다(여기서 다시 적지 않는다).
import { fetch as streamFetch } from "expo/fetch";
import {
  ArrowLeft,
  BellOff,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Search,
  Users,
} from "lucide-react-native";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Animated,
  AppState,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  PERSONAL_ROOM_TITLE,
  PRESENCE_LABELS,
  PRESENCE_STATES,
  type PresenceState,
  REJECT_REASON_KINDS,
  REJECT_REASON_LABELS,
  type RejectReasonKind,
  STAGE_LABELS,
  VISIBLE_STAGES,
} from "../../../../packages/domain/src/osiri";
import type { Approval } from "../../../server/src/osiri/approvals.ts";
import type {
  Activity,
  RoomBoard,
  RoomCard,
  RoomMessage,
  TaskStage,
  TeamGoal,
} from "../../../server/src/osiri/rooms.ts";
import appJson from "../../app.json";
import { apiBase } from "../api";
import { ChatScreen } from "../chat";
import {
  Badge,
  Button,
  Card,
  colors,
  Empty,
  ErrorNotice,
  fonts,
  IconButton,
  relativeDate,
  Sheet,
  Skeleton,
  s,
  timeLabel,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar, type Mood, selfAnimated, useStill } from "./eve";
import { LoadState, useLoad } from "./store";
import { type GoalProposal, TeamGoalsScreen } from "./team-goals";

export type { PresenceState, RoomBoard, RoomMessage, TaskStage, TeamGoal };
/** GET /rooms 항목 — 서버 RoomCard 가 정본 */
export type Room = RoomCard;
const isPresence = (v: string): v is PresenceState =>
  (PRESENCE_STATES as readonly string[]).includes(v);
/** GET /inbox 의 pending 항목 (tokenHash 제외 + roomTitle). */
export type PendingApproval = Omit<Approval, "tokenHash"> & { roomTitle: string };
export type RejectKind = RejectReasonKind;
/** 계약 «방» — 누가 답했는지 */
export interface AnsweredBy {
  tier: number;
  label: string;
  model: string;
  source: "device" | "server" | "byok";
  reason?: string;
  memoryRefs?: { id: string; text: string; at: string }[];
}
type Board = RoomBoard & {
  recentDone?: string[];
  agents: (RoomBoard["agents"][number] & { role?: string; current?: string })[];
};
interface Presence {
  state: PresenceState;
  label: string;
}
interface Summary {
  presence: string;
  label: string;
  flow: Record<TaskStage, number>;
  pendingApprovals: { id: string; title: string }[];
  doneToday: number;
  progress: number;
  nextReportAt: string | null;
  recentDone?: string[];
}
interface Timeline {
  digest: string | null;
  messages: RoomMessage[];
  board: Board;
  /** 채팅 답변 id → 누가 답했는지 */
  answers?: Record<string, AnsweredBy>;
}

const text = {
  search: "방 검색",
  emptyTitle: "아직 고용한 팀이 없어요",
  emptyDetail: "스토어에서 팀을 고용하면 여기에 채팅방이 생겨요.",
  goStore: "스토어에서 첫 팀 고용하기",
  retry: "다시 시도",
  loadFailed: "불러오지 못했어요",
  cached: "마지막으로 받은 목록을 보여 드려요",
  personalRole: "개인 에이전트",
  progress: (n: number) => `진척 ${n}%`,
  pendingLine: (n: number) => (n > 0 ? `승인 대기 ${n}건` : "대기 없음"),
  stalled: "멈춘 팀",
  muted: "알림 꺼짐",
  more: "방 메뉴",
  pin: "방 고정",
  unpin: "고정 해제",
  mute: "알림 끄기",
  unmute: "알림 켜기",
  noMatch: "찾는 방이 없어요",
  back: "뒤로",
  teams: "팀 방",
  digestTitle: "결재 요약",
  goRoom: "방으로 이동",
  noPending: "대기 없음",
  waitingCount: (n: number) => `승인 ${n}건 대기 중`,
  offline: "연결 대기",
  streamStopped: "실시간 연결이 끊겼어요",
  summaryTitle: "팀 상태 요약",
  stage: "현재 단계",
  pendingList: "승인 대기",
  none: "없음",
  goalProgress: "목표 진척",
  recentDone: "최근 완료",
  today: (n: number) => `오늘 완료 ${n}건`,
  nextReport: "다음 보고",
  noReport: "예정 없음",
  openBoard: "현황판 보기",
  openGoals: "목표 보기",
  board: "현황판",
  boardLine: (pending: number, progress: number) =>
    `현황 요약 승인 대기 ${pending} · 진척 ${progress}%`,
  expand: "펼치면 현황판",
  agents: (n: number) => `에이전트 ${n}명`,
  agentDone: "완료",
  agentErrors: "오류",
  agentNow: "지금 하는 일",
  levels: { long: "장기", mid: "중기", short: "단기" } as Record<string, string>,
  approve: "승인",
  reject: "반려",
  rejectWhy: "반려 사유를 골라 주세요",
  rejectNote: "덧붙일 말 (선택)",
  rejectSend: "반려 보내기",
  cancel: "취소",
  evidence: "근거",
  viewInRoom: "방에서 보기",
  status: {
    pending: "승인 대기",
    approved: "승인됨",
    rejected: "반려됨",
    expired: "만료됨 — 새 승인 카드가 올 거예요",
    consumed: "발행됨",
  } as Record<string, string>,
  approvalGone: "이 승인은 더 이상 대기 중이 아니에요",
  report: "주간 보고",
  metrics: { published: "발행", indexed: "색인", ai_citations: "AI 인용" },
  reportDetail: "상세는 목표 탭",
  nextWeek: "다음 주 계획",
  digest: "부재 중 진척",
  noMessages: "아직 기록이 없어요. 아래에 목표를 말하면 팀장이 쪼개서 시작해요.",
  composer: "메시지 입력 — 목표를 말하면 팀이 쪼개서 실행합니다",
  fromMemory: "기억에서 찾음",
  tabs: { chat: "채팅", goals: "목표", feed: "피드", ideas: "아이디어", files: "파일" },
  feedEmpty: { title: "아직 활동이 없어요", detail: "팀이 일하면 여기에 쌓여요." },
  ideasEmpty: {
    title: "아직 제안이 없어요",
    detail: "팀이 다음 주제·목표를 제안하면 여기에 와요.",
  },
  accept: "채택",
  hold: "보류",
  proposalStatus: { accepted: "채택됨", held: "보류됨" } as Record<string, string>,
  filesApproved: "승인본",
  filesAudit: "감사 로그",
  filesEmpty: { title: "아직 문서가 없어요", detail: "승인한 발행본과 감사 기록이 여기에 남아요." },
  // 채팅 기분 → 상태줄 (쉼은 presence 문구를 그대로 쓴다)
  mood: { listening: "듣는 중", thinking: "작업 중", speaking: "답하는 중" } as Record<
    string,
    string
  >,
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mono = { fontFamily: fonts.mono } as const;

// --- SSE ---
export type StreamState = "connecting" | "live" | "waiting" | "stopped";
/**
 * SSE 구독. 서버가 ?token= 을 받지 않아 EventSource 를 못 쓴다 → expo/fetch 로 Authorization 헤더를 붙여 직접 파싱한다.
 * 네트워크 끊김·5xx 는 1s→30s 백오프로 다시 붙고 그동안 "waiting"(연결 대기),
 * 4xx(세션 만료·없는 방)는 다시 붙어도 안 되므로 "stopped" + 사유를 돌려준다 — 조용히 영원히 재시도하지 않는다.
 */
export function useEventStream(path: string, onEvent: (event: string, payload: unknown) => void) {
  const { api } = useWorkspace();
  const latest = useRef(onEvent);
  latest.current = onEvent;
  const [status, setStatus] = useState<{ state: StreamState; error: string }>({
    state: "connecting",
    error: "",
  });
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const dispatch = (block: string) => {
      let event = "message";
      const data: string[] = [];
      for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (event === "ping" || !data.length) return;
      try {
        latest.current(event, JSON.parse(data.join("\n")));
      } catch (e) {
        console.warn(`[0siri] ${path} 이벤트 ${event} 를 읽지 못해 건너뜀`, e);
      }
    };
    const connect = async () => {
      let delay = 1000;
      while (!stopped) {
        let why = "";
        try {
          const res = await streamFetch(`${apiBase()}${path}`, {
            headers: { Authorization: `Bearer ${api.token}`, Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (res.status >= 400 && res.status < 500) {
            setStatus({ state: "stopped", error: `${text.streamStopped} (${res.status})` });
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          delay = 1000;
          setStatus({ state: "live", error: "" });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let cut = buffer.indexOf("\n\n");
            while (cut >= 0) {
              dispatch(buffer.slice(0, cut));
              buffer = buffer.slice(cut + 2);
              cut = buffer.indexOf("\n\n");
            }
          }
        } catch (e) {
          why = errorText(e);
        }
        if (stopped) return;
        setStatus({ state: "waiting", error: why });
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [path, api]);
  return status;
}
export interface StreamHandlers {
  onBoard?: (board: RoomBoard) => void;
  onPresence?: (presence: Presence) => void;
  onApproval?: (event: { approvalId: string; status: string }) => void;
  onMessage?: (event: { messageId: string }) => void;
  onGoal?: (event: { goalId: string }) => void;
}
/** GET /rooms/:id/stream — 방 하나의 현황판·승인·메시지 이벤트. */
export function useRoomStream(roomId: string, handlers: StreamHandlers) {
  return useEventStream(`/api/rooms/${roomId}/stream`, (event, payload) => {
    // biome-ignore lint/suspicious/noExplicitAny: 서버 이벤트 페이로드는 이벤트 이름으로 분기한다
    const p = payload as any;
    if (event === "board") handlers.onBoard?.(p);
    else if (event === "room.presence") handlers.onPresence?.({ state: p.state, label: p.label });
    else if (event === "approval") handlers.onApproval?.(p);
    else if (event === "message") handlers.onMessage?.(p);
    else if (event === "goal") handlers.onGoal?.(p);
  });
}

// --- 방 목록: 앱 전체가 이 한 벌을 본다 (사이드바·목록 화면·탭 배지·결재 요약·딥링크) ---
type Api = { request<T>(path: string, body?: unknown, method?: string): Promise<T> };
let roomsState: { rooms: Room[] | null; error: string } = { rooms: null, error: "" };
const roomsListeners = new Set<() => void>();
const setRoomsState = (next: typeof roomsState) => {
  roomsState = next;
  for (const l of roomsListeners) l();
};
/** 목록을 다시 읽는다. 실패하면 마지막 성공본은 남기고 사유만 싣는다(기획: 캐시된 목록 + 다시 시도). */
export async function refreshRooms(api: Api) {
  try {
    const rooms = await api.request<Room[]>("/api/rooms");
    setRoomsState({ rooms, error: "" });
    return rooms;
  } catch (e) {
    setRoomsState({ rooms: roomsState.rooms, error: errorText(e) });
    return null;
  }
}
/** 로그아웃 — 다음 사용자가 앞 사람의 목록을 보지 않게 */
export const resetRooms = () => setRoomsState({ rooms: null, error: "" });
export const useRooms = () =>
  useSyncExternalStore(
    (l) => {
      roomsListeners.add(l);
      return () => roomsListeners.delete(l);
    },
    () => roomsState,
  );
/** 로그인해 있는 동안 한 번만 건다: 첫 조회 + 사용자 스트림(`rooms` 이벤트) + 앱 복귀 때 다시 읽기. */
export function useRoomsLive() {
  const { api } = useWorkspace();
  useEffect(() => {
    void refreshRooms(api);
    const sub = AppState.addEventListener(
      "change",
      (st) => st === "active" && void refreshRooms(api),
    );
    return () => sub.remove();
  }, [api]);
  return useEventStream("/api/stream", (event) => {
    if (event === "rooms" || event === "inbox") void refreshRooms(api);
  });
}

const roomTitle = (room: Room) =>
  room.packageId === null ? `${PERSONAL_ROOM_TITLE} · ${text.personalRole}` : room.title;

/** 작업 중인 방의 작은 움직임 표시 (기획 «캐릭터 표시 규칙» 화면 2) */
function WorkingDot() {
  const still = useStill();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (still) return pulse.setValue(1);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, still]);
  return (
    <Animated.View
      accessibilityLabel={PRESENCE_LABELS.working}
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: 10,
        height: 10,
        borderRadius: 5,
        borderWidth: 2,
        borderColor: colors.card,
        backgroundColor: colors.ok,
        opacity: pulse,
      }}
    />
  );
}

export function RoomList({
  onOpen,
  activeId,
}: {
  onOpen: (room: Room) => void;
  activeId?: string;
}) {
  const { api, navigate } = useWorkspace();
  const { rooms, error } = useRooms();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<Room | null>(null);
  const [actionError, setActionError] = useState("");
  const change = async (room: Room, path: "pin" | "mute", body: object) => {
    setActionError("");
    setMenu(null);
    try {
      await api.request(`/api/rooms/${room.id}/${path}`, body);
      await refreshRooms(api); // 정렬은 서버가 한다
    } catch (e) {
      setActionError(errorText(e));
    }
  };
  const retry = (
    <Button small onPress={() => void refreshRooms(api)}>
      {text.retry}
    </Button>
  );
  if (!rooms)
    return error ? (
      <View style={{ gap: 10 }}>
        <ErrorNotice error={`${text.loadFailed}: ${error}`} />
        {retry}
      </View>
    ) : (
      <Skeleton rows={3} height={58} />
    );
  const q = query.trim().toLowerCase();
  const shown = q ? rooms.filter((r) => roomTitle(r).toLowerCase().includes(q)) : rooms;
  const hired = rooms.some((r) => r.packageId !== null);
  return (
    <View style={{ gap: 6 }}>
      <View
        style={[
          s.row,
          {
            gap: 8,
            paddingHorizontal: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.card,
          },
        ]}
      >
        <Search size={16} color={colors.muted} />
        <TextInput
          style={{ flex: 1, paddingVertical: 9, color: colors.text, fontFamily: fonts.body }}
          placeholder={text.search}
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          accessibilityLabel={text.search}
        />
      </View>
      {!!error && (
        <View style={{ gap: 6 }}>
          <ErrorNotice error={`${text.loadFailed}: ${error} — ${text.cached}`} />
          {retry}
        </View>
      )}
      <ErrorNotice error={actionError} />
      {shown.map((room) => {
        const active = room.id === activeId;
        const personal = room.packageId === null;
        const status =
          room.lastReport ?? (isPresence(room.presence) ? PRESENCE_LABELS[room.presence] : "");
        return (
          <Pressable
            key={room.id}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${roomTitle(room)} · ${text.pendingLine(room.pendingApprovals)}`}
            onPress={() => onOpen(room)}
            onLongPress={() => setMenu(room)}
            // 웹 우클릭 = 앱 길게 누르기 (react-native-web 이 넘겨준다)
            {...({
              onContextMenu: (e: { preventDefault(): void }) => {
                e.preventDefault();
                setMenu(room);
              },
            } as object)}
            style={({ pressed }) => [
              s.row,
              {
                gap: 12,
                padding: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: active ? colors.accent : "transparent",
                backgroundColor: active ? colors.accentSoft : "transparent",
                opacity: room.stalled ? 0.55 : pressed ? 0.8 : 1,
              },
            ]}
          >
            <View>
              <CharacterAvatar character={room.character} size={34} />
              {room.presence === "working" && !room.stalled && <WorkingDot />}
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <View style={[s.row, { gap: 6 }]}>
                <Text style={[s.heading, { fontSize: 15, flexShrink: 1 }]} numberOfLines={1}>
                  {roomTitle(room)}
                </Text>
                <Badge count={room.pendingApprovals} />
                {room.muted && (
                  <BellOff size={13} color={colors.muted} accessibilityLabel={text.muted} />
                )}
              </View>
              {personal ? (
                !!room.tierLabel && <Text style={s.small}>{room.tierLabel}</Text>
              ) : (
                <>
                  {!!status && (
                    <Text style={s.small} numberOfLines={1}>
                      {status}
                    </Text>
                  )}
                  <Text style={[s.small, mono]} numberOfLines={1}>
                    {room.stalled ? `${text.stalled} · ` : ""}
                    {text.progress(room.progress)} · {text.pendingLine(room.pendingApprovals)}
                  </Text>
                </>
              )}
            </View>
            <IconButton icon={MoreHorizontal} label={text.more} onPress={() => setMenu(room)} />
          </Pressable>
        );
      })}
      {!!q && shown.length === 0 && <Text style={s.muted}>{text.noMatch}</Text>}
      {!hired && !q && (
        <Card>
          <Empty icon={Users} title={text.emptyTitle} detail={text.emptyDetail}>
            <Button primary onPress={() => navigate("store")}>
              {text.goStore}
            </Button>
          </Empty>
        </Card>
      )}
      {menu && (
        <Sheet title={roomTitle(menu)} onClose={() => setMenu(null)}>
          <View style={{ gap: 8 }}>
            <Button onPress={() => void change(menu, "pin", { pinned: !menu.pinned })}>
              {menu.pinned ? text.unpin : text.pin}
            </Button>
            <Button onPress={() => void change(menu, "mute", { muted: !menu.muted })}>
              {menu.muted ? text.unmute : text.mute}
            </Button>
          </View>
        </Sheet>
      )}
    </View>
  );
}

/** 결재 요약 카드 (화면 2 우측) — 승인을 기다리는 방과 [방으로 이동], 다 처리했으면 «대기 없음». */
export function ApprovalDigest({ onOpenRoom }: { onOpenRoom: (room: Room) => void }) {
  const { rooms } = useRooms();
  if (!rooms) return null; // 목록의 로딩·오류는 RoomList 가 보인다
  const waiting = rooms.filter((r) => r.pendingApprovals > 0);
  return (
    <Card style={{ gap: 8, padding: 14 }}>
      <Text style={s.label}>{text.digestTitle}</Text>
      {waiting.length === 0 && <Text style={s.muted}>{text.noPending}</Text>}
      {waiting.map((room) => (
        <View key={room.id} style={[s.between, { gap: 8 }]}>
          <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
            {roomTitle(room)} {text.pendingLine(room.pendingApprovals)}
          </Text>
          <Button small onPress={() => onOpenRoom(room)}>
            {text.goRoom}
          </Button>
        </View>
      ))}
    </Card>
  );
}

// --- 현황판 위젯 (방 상단 고정 + 스트림 안 위젯 공용) ---
function Bar({ value }: { value: number }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.sunk, overflow: "hidden" }}>
      <View
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          height: 6,
          backgroundColor: colors.accent,
        }}
      />
    </View>
  );
}
const FLOW = VISIBLE_STAGES; // 화면에 보이는 흐름 5단계 (서버 flow 의 geo·done 은 화면 단계가 아니다)
/** 흐름 5단계: 지난 단계 ✓ · 지금 단계 강조 · 사이를 선으로 잇는다 */
function Flow({ flow }: { flow: Record<TaskStage, number> }) {
  // 지금 단계 = 일이 걸려 있는 가장 뒤 단계
  const current = FLOW.reduce((at, stage, i) => ((flow[stage] ?? 0) > 0 ? i : at), -1);
  return (
    <View style={[s.row, { alignItems: "flex-start" }]}>
      {FLOW.map((stage, i) => {
        const count = flow[stage] ?? 0;
        const passed = i < current;
        const now = i === current;
        return (
          <View key={stage} style={{ flex: 1, alignItems: "center", gap: 4 }}>
            <View style={[s.row, { alignSelf: "stretch" }]}>
              <View
                style={{ flex: 1, height: 1, backgroundColor: i ? colors.line : "transparent" }}
              />
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: now ? colors.accent : passed ? colors.ok : colors.line,
                  backgroundColor: now ? colors.accent : passed ? colors.okBg : colors.card,
                }}
              >
                <Text
                  style={[
                    mono,
                    {
                      fontSize: 11,
                      fontWeight: "700",
                      color: now ? colors.onAccent : passed ? colors.ok : colors.muted,
                    },
                  ]}
                >
                  {passed && !count ? "✓" : count}
                </Text>
              </View>
              <View
                style={{
                  flex: 1,
                  height: 1,
                  backgroundColor: i < FLOW.length - 1 ? colors.line : "transparent",
                }}
              />
            </View>
            <Text style={[s.small, now && { color: colors.accent, fontWeight: "700" }]}>
              {STAGE_LABELS[stage]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
export function BoardWidget({ board }: { board: Board }) {
  const [agent, setAgent] = useState<Board["agents"][number] | null>(null);
  return (
    <Card style={{ gap: 12, padding: 14 }}>
      <Text style={s.label}>{text.board}</Text>
      <Flow flow={board.flow} />
      <View style={{ gap: 6 }}>
        {board.goals.map((g) => (
          <View key={g.level} style={[s.row, { gap: 10 }]}>
            <Text style={[s.small, { width: 28 }]}>{text.levels[g.level]}</Text>
            <View style={{ flex: 1 }}>
              <Bar value={g.progress} />
            </View>
            <Text style={[s.small, mono, { width: 40, textAlign: "right" }]}>{g.progress}%</Text>
          </View>
        ))}
      </View>
      {board.agents.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={s.small}>{text.agents(board.agents.length)}</Text>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {board.agents.map((a) => (
              <Pressable
                key={a.actor}
                accessibilityRole="button"
                accessibilityLabel={a.actor}
                onPress={() => setAgent(a)}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: a.errors ? colors.miss : colors.line,
                  backgroundColor: colors.sunk,
                }}
              >
                <Text style={[s.small, { color: colors.text }]}>{a.actor}</Text>
                <Text style={[s.small, mono]}>
                  {a.done}
                  {a.errors ? ` · !${a.errors}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {agent && (
        <Sheet title={agent.actor} subtitle={agent.role} onClose={() => setAgent(null)}>
          <View style={{ gap: 8 }}>
            {!!agent.current && (
              <Text style={s.text}>
                {text.agentNow}: {agent.current}
              </Text>
            )}
            <Text style={[s.text, mono]}>
              {text.agentDone} {agent.done} · {text.agentErrors} {agent.errors}
            </Text>
          </View>
        </Sheet>
      )}
    </Card>
  );
}

// --- 승인 카드 (화면 3·4 공용) ---
type Decision = "approve" | "reject";
export type RejectReason = { kind: RejectKind; note?: string };
/** 승인 결정. frozenHash 는 결재함(/inbox)의 inputHash 로 동결한다 — 카드 payload 에는 해시가 없다. 이미 처리된 건은 서버가 409 로 막는다. */
export async function decideApproval(
  api: Api,
  approvalId: string,
  decision: Decision,
  frozenHash: string | undefined,
  reason?: RejectReason,
) {
  const hash =
    frozenHash ??
    (await api.request<{ pending: PendingApproval[] }>("/api/inbox")).pending.find(
      (a) => a.id === approvalId,
    )?.inputHash;
  if (!hash) throw new Error(text.approvalGone);
  return api.request<{ status: string }>(`/api/approvals/${approvalId}/decide`, {
    decision,
    frozenHash: hash,
    reasonKind: reason?.kind,
    reason: reason?.note,
  });
}
/** 승인 카드. [승인]=채움 [반려]=외곽선, 반려는 사유(톤·사실·주제)를 고른 뒤에만 보낸다. 결정되면 그 상태로 잠긴다. */
export function ApprovalCard({
  title,
  summary,
  evidence,
  status,
  character,
  onDecide,
  onOpenRoom,
}: {
  title: string;
  summary: string;
  evidence?: string;
  status: string;
  /** 어느 팀의 요청인지 — 결재함에서 방 캐릭터를 같이 보인다 */
  character?: string;
  onDecide: (decision: Decision, reason?: RejectReason) => Promise<void>;
  onOpenRoom?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [kind, setKind] = useState<RejectKind | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState("");
  const decide = async (decision: Decision, why?: RejectReason) => {
    setBusy(decision);
    setError("");
    try {
      await onDecide(decision, why);
      setRejecting(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const pending = status === "pending";
  const good = status === "approved" || status === "consumed";
  const tone = pending
    ? { fg: colors.warn, bg: colors.warnBg, border: colors.brass }
    : good
      ? { fg: colors.ok, bg: colors.okBg, border: colors.ok }
      : { fg: colors.miss, bg: colors.missBg, border: colors.miss };
  return (
    <Card style={{ gap: 10, padding: 14, borderColor: tone.border }}>
      <View style={[s.row, { gap: 8 }]}>
        {!!character && <CharacterAvatar character={character} size={26} />}
        <Text style={[s.heading, { flex: 1, fontSize: 15 }]}>{title}</Text>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 6,
            backgroundColor: tone.bg,
          }}
        >
          <Text style={{ color: tone.fg, fontSize: 12, fontWeight: "700" }}>
            {text.status[status] ?? status}
          </Text>
        </View>
      </View>
      <Text style={s.text}>{summary}</Text>
      {evidence ? (
        <View style={{ gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((v) => !v)}
            style={[s.row, { gap: 4 }]}
          >
            {open ? (
              <ChevronUp size={14} color={colors.muted} />
            ) : (
              <ChevronDown size={14} color={colors.muted} />
            )}
            <Text style={s.small}>{text.evidence}</Text>
          </Pressable>
          {open && <Text style={s.muted}>{evidence}</Text>}
        </View>
      ) : null}
      <ErrorNotice error={error} />
      {pending && !rejecting && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button small primary busy={busy === "approve"} onPress={() => void decide("approve")}>
            {text.approve}
          </Button>
          <Button small disabled={busy !== null} onPress={() => setRejecting(true)}>
            {text.reject}
          </Button>
          {onOpenRoom && (
            <Button small onPress={onOpenRoom}>
              {text.viewInRoom}
            </Button>
          )}
        </View>
      )}
      {pending && rejecting && (
        <View style={{ gap: 8 }}>
          <Text style={s.small}>{text.rejectWhy}</Text>
          <View style={[s.row, { gap: 8 }]}>
            {REJECT_REASON_KINDS.map((id) => ({ id, label: REJECT_REASON_LABELS[id] })).map((k) => (
              <Pressable
                key={k.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === k.id }}
                onPress={() => setKind(k.id)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: kind === k.id ? colors.accent : colors.line,
                  backgroundColor: kind === k.id ? colors.accentSoft : "transparent",
                }}
              >
                <Text style={[s.text, kind === k.id && { color: colors.accent }]}>{k.label}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={s.input}
            placeholder={text.rejectNote}
            placeholderTextColor={colors.muted}
            value={note}
            onChangeText={setNote}
            accessibilityLabel={text.rejectNote}
          />
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              disabled={!kind}
              busy={busy === "reject"}
              onPress={() =>
                kind && void decide("reject", { kind, note: note.trim() || undefined })
              }
            >
              {text.rejectSend}
            </Button>
            <Button small onPress={() => setRejecting(false)}>
              {text.cancel}
            </Button>
          </View>
        </View>
      )}
      {!pending && onOpenRoom && (
        <Button small style={{ alignSelf: "flex-start" }} onPress={onOpenRoom}>
          {text.viewInRoom}
        </Button>
      )}
    </Card>
  );
}

// --- 캐릭터 (화면 3 상단 중앙) ---
function Character({
  room,
  presence,
  pending,
  mood,
  label,
  onPress,
}: {
  room: Room;
  presence: Presence;
  pending: number;
  mood: Mood;
  label: string;
  onPress: () => void;
}) {
  const still = useStill();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    anim.setValue(0);
    if (still) return; // 동작 줄이기: 움직이지 않고 표정·문구로만
    const seq = (ms: number) =>
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: ms, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: ms, useNativeDriver: true }),
      ]);
    // 승인 대기는 사용자 쪽을 보고 멈춘다. done 은 한 번 기울고 멈춘다 — 서버가 곧 idle 을 보낸다.
    if (presence.state === "waiting") return;
    const loop =
      presence.state === "done"
        ? seq(220)
        : Animated.loop(seq(presence.state === "working" ? 420 : 1800));
    loop.start();
    return () => loop.stop();
  }, [anim, presence.state, still]);
  const transform =
    presence.state === "working"
      ? [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, 3] }) }] // 작게 끄덕임
      : presence.state === "done"
        ? [{ rotate: anim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "8deg"] }) }] // 보고 카드 쪽으로 기울임
        : [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] }) }]; // 느린 호흡
  // 스스로 움직이는 캐릭터(영시리)는 기분을 넘기고, 아니면 presence 애니메이션을 여기서 입힌다
  const own = selfAnimated(room.character);
  const ownMood: Mood =
    pending > 0
      ? "alert"
      : mood !== "idle"
        ? mood
        : presence.state === "working"
          ? "thinking"
          : presence.state === "done"
            ? "happy"
            : "idle";
  return (
    // 캐릭터는 상태 표시다 — 눌러도 요약만 뜨고 승인·발행은 실행하지 않는다
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={text.summaryTitle}
      onPress={onPress}
      style={{ alignItems: "center" }}
    >
      <Animated.View style={own ? undefined : { transform }}>
        <CharacterAvatar character={room.character} size={own ? 104 : 72} mood={ownMood} />
      </Animated.View>
      <Badge count={pending} style={{ position: "absolute", top: 0, right: -6 }} />
    </Pressable>
  );
}

// --- 방 탭: 피드 · 아이디어 · 파일 ---
function FeedTab({ roomId }: { roomId: string }) {
  const { api } = useWorkspace();
  const feed = useLoad(
    () => api.request<(Activity & { label: string })[]>(`/api/rooms/${roomId}/feed`),
    roomId,
  );
  return (
    <LoadState {...feed} empty={feed.data?.length === 0 && text.feedEmpty}>
      {feed.data?.map((a) => (
        <Card key={a.id} style={{ gap: 2, padding: 12 }}>
          <View style={[s.between, { gap: 8 }]}>
            <Text style={s.small}>
              {a.label} · {a.actor}
            </Text>
            <Text style={[s.small, mono]}>{relativeDate(a.createdAt)}</Text>
          </View>
          <Text style={s.text}>{a.title}</Text>
          {!!a.detail && <Text style={s.muted}>{a.detail}</Text>}
        </Card>
      ))}
    </LoadState>
  );
}
function IdeasTab({ roomId }: { roomId: string }) {
  const { api } = useWorkspace();
  const ideas = useLoad(() => api.request<GoalProposal[]>(`/api/rooms/${roomId}/ideas`), roomId);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const decide = async (id: string, decision: "accept" | "hold") => {
    setBusy(id);
    setError("");
    try {
      await api.request(`/api/goals/proposals/${id}/decide`, { decision });
      ideas.retry();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <LoadState {...ideas} empty={ideas.data?.length === 0 && text.ideasEmpty}>
      <ErrorNotice error={error} />
      {ideas.data?.map((p) => (
        <Card key={p.id} style={{ gap: 6, padding: 12 }}>
          <Text style={s.heading}>{p.title}</Text>
          {!!p.detail && <Text style={s.text}>{p.detail}</Text>}
          <Text style={s.small}>
            {p.proposedBy} · {relativeDate(p.createdAt)}
          </Text>
          {p.status === "pending" ? (
            <View style={[s.row, { gap: 8 }]}>
              <Button
                small
                primary
                busy={busy === p.id}
                onPress={() => void decide(p.id, "accept")}
              >
                {text.accept}
              </Button>
              <Button small disabled={busy === p.id} onPress={() => void decide(p.id, "hold")}>
                {text.hold}
              </Button>
            </View>
          ) : (
            <Text style={s.small}>{text.proposalStatus[p.status] ?? p.status}</Text>
          )}
        </Card>
      ))}
    </LoadState>
  );
}
interface RoomFiles {
  approved: { approvalId: string; title: string; summary: string; decidedAt: string }[];
  audit: { id: string; ts: string; action: string; actor: string; approvalId?: string }[];
}
function FilesTab({ roomId }: { roomId: string }) {
  const { api } = useWorkspace();
  const files = useLoad(() => api.request<RoomFiles>(`/api/rooms/${roomId}/files`), roomId);
  const none = !!files.data && !files.data.approved.length && !files.data.audit.length;
  return (
    <LoadState {...files} empty={none && text.filesEmpty}>
      <Text style={s.label}>{text.filesApproved}</Text>
      {files.data?.approved.map((f) => (
        <Card key={f.approvalId} style={{ gap: 2, padding: 12 }}>
          <Text style={s.heading}>{f.title}</Text>
          <Text style={s.muted}>{f.summary}</Text>
          <Text style={[s.small, mono]}>{timeLabel(f.decidedAt)}</Text>
        </Card>
      ))}
      <Text style={s.label}>{text.filesAudit}</Text>
      {files.data?.audit.map((a) => (
        <Text key={a.id} style={[s.small, mono]}>
          {timeLabel(a.ts)} · {a.actor} · {a.action}
          {a.approvalId ? ` · ${a.approvalId.slice(0, 8)}` : ""}
        </Text>
      ))}
    </LoadState>
  );
}

// --- 화면 3 팀 채팅방 ---
type RoomTab = keyof typeof text.tabs;
const ROOM_TABS = Object.keys(text.tabs) as RoomTab[];
export function RoomScreen({
  room,
  onBack,
  home = false,
  onOpenRoom,
}: {
  room: Room;
  onBack: () => void;
  /** 기본 채팅(홈): 앱을 열면 바로 영시리와 대화. 뒤로 대신 팀 방 목록 버튼, 버전 표시 */
  home?: boolean;
  onOpenRoom?: (room: Room) => void;
}) {
  const { api } = useWorkspace();
  const desktop = useWindowDimensions().width >= 900;
  const [tab, setTab] = useState<RoomTab>("chat");
  const [boardOpen, setBoardOpen] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const [teams, setTeams] = useState(false);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [presence, setPresence] = useState<Presence>({
    state: isPresence(room.presence) ? room.presence : "idle",
    label: isPresence(room.presence) ? PRESENCE_LABELS[room.presence] : room.presence,
  });
  const [summary, setSummary] = useState<Summary | null | "loading" | { error: string }>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(0);
  const messages = timeline?.messages;
  const patchMessages = (fn: (list: RoomMessage[]) => RoomMessage[]) =>
    setTimeline((t) => (t ? { ...t, messages: fn(t.messages) } : t));

  const load = useCallback(async () => {
    setError("");
    try {
      const t = await api.request<Timeline>(`/api/rooms/${room.id}/timeline`);
      setTimeline(t);
      setBoard(t.board);
      lastSeq.current = t.messages.at(-1)?.seq ?? 0;
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, room.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // 답이 끝나면 «누가 답했는지» 를 다시 받는다 (계약: timeline.answers)
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = mood === "thinking" || mood === "speaking";
    if (wasBusy.current && !busy) void load();
    wasBusy.current = busy;
  }, [mood, load]);
  // 결정: 캐릭터 상태는 room.presence 이벤트 한 곳에서만 바뀐다. 30초 무이벤트 → 휴식은
  // working/done 에만 적용한다 — waiting 은 승인이 남아 있는 한 서버가 유지하는 상태다.
  const onPresence = useCallback((p: Presence) => {
    setPresence(p);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (p.state === "working" || p.state === "done")
      idleTimer.current = setTimeout(
        () => setPresence({ state: "idle", label: PRESENCE_LABELS.idle }),
        30_000,
      );
  }, []);
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );
  const setCardStatus = (approvalId: string, status: string) =>
    patchMessages((list) =>
      list.map((m) =>
        m.kind === "card" && m.payload?.approvalId === approvalId
          ? { ...m, payload: { ...m.payload, status } }
          : m,
      ),
    );
  const stream = useRoomStream(room.id, {
    onBoard: (b) => setBoard(b as Board),
    onPresence,
    onApproval: ({ approvalId, status }) => setCardStatus(approvalId, status),
    onMessage: async () => {
      try {
        const t = await api.request<Timeline>(
          `/api/rooms/${room.id}/timeline?after=${lastSeq.current}`,
        );
        if (!t.messages.length) return;
        lastSeq.current = t.messages.at(-1)?.seq ?? lastSeq.current;
        patchMessages((list) => [...list, ...t.messages]);
      } catch (e) {
        setError(errorText(e)); // [다시 시도] 가 전체를 다시 읽는다
      }
    },
  });
  const openSummary = async () => {
    setSummary("loading");
    try {
      setSummary(await api.request<Summary>(`/api/rooms/${room.id}/summary`));
    } catch (e) {
      setSummary({ error: errorText(e) });
    }
  };
  const decide = async (m: RoomMessage, decision: Decision, reason?: RejectReason) => {
    const approvalId = String(m.payload?.approvalId ?? "");
    const result = await decideApproval(api, approvalId, decision, undefined, reason);
    setCardStatus(approvalId, result.status);
    void refreshRooms(api); // 목록·탭 배지
    try {
      setBoard(await api.request<Board>(`/api/rooms/${room.id}/board`));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const pending = board?.pendingApprovals ?? room.pendingApprovals;
  const title = room.packageId === null ? PERSONAL_ROOM_TITLE : room.title;
  // 끊겨 있으면 «쉬는 중» 이 아니라 «연결 대기» 로 구분한다
  const statusLine =
    stream.state === "waiting"
      ? text.offline
      : pending > 0
        ? text.waitingCount(pending)
        : (text.mood[mood] ?? presence.label);
  const isPendingCard = (m: RoomMessage) =>
    m.kind === "card" && m.payload?.card === "approval" && m.payload?.status === "pending";
  const render = (m: RoomMessage) => (
    <View key={m.id} style={{ paddingHorizontal: 16 }}>
      <Message message={m} onDecide={(d, r) => decide(m, d, r)} onGoals={() => setTab("goals")} />
    </View>
  );
  const answerLabel = (id: string) => {
    const a = timeline?.answers?.[id];
    if (!a) return undefined;
    return [
      a.label,
      a.source === "device" ? a.model : "",
      a.memoryRefs?.length ? text.fromMemory : "",
      a.reason ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  // 한 흐름: 지난 기록(부재 중 진척 → 보고·결정된 카드) → 대화 → 지금 결정할 승인 카드
  const header: ReactNode = (
    <View style={{ gap: 10 }}>
      {home && onOpenRoom && (
        <View style={{ paddingHorizontal: 16 }}>
          <ApprovalDigest onOpenRoom={onOpenRoom} />
        </View>
      )}
      {!!stream.error && stream.state === "stopped" && (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorNotice error={stream.error} />
        </View>
      )}
      {error ? (
        <View style={{ gap: 8, paddingHorizontal: 16 }}>
          <ErrorNotice error={`${text.loadFailed}: ${error}`} />
          <Button small onPress={() => void load()}>
            {text.retry}
          </Button>
        </View>
      ) : !timeline ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Skeleton rows={2} />
        </View>
      ) : (
        <>
          {!!timeline.digest && (
            <View style={{ paddingHorizontal: 16 }}>
              <Card style={{ padding: 14, backgroundColor: colors.sunk }}>
                <Text style={s.label}>{text.digest}</Text>
                <Text style={s.text}>{timeline.digest}</Text>
              </Card>
            </View>
          )}
          {!home && timeline.messages.length === 0 && !timeline.digest && (
            <Text style={[s.muted, { paddingHorizontal: 16 }]}>{text.noMessages}</Text>
          )}
          {timeline.messages.filter((m) => !isPendingCard(m)).map(render)}
        </>
      )}
    </View>
  );
  const waiting = messages?.filter(isPendingCard) ?? [];

  return (
    <View style={{ flex: 1 }}>
      <View
        style={[s.row, { paddingHorizontal: 8, paddingTop: 4, justifyContent: "space-between" }]}
      >
        {home || desktop ? (
          <View />
        ) : (
          <IconButton icon={ArrowLeft} label={text.back} onPress={onBack} />
        )}
        {home && !desktop && (
          <IconButton icon={Users} label={text.teams} onPress={() => setTeams(true)} />
        )}
      </View>
      <View style={{ alignItems: "center", gap: 2, paddingBottom: 8 }}>
        <Character
          room={room}
          presence={presence}
          pending={pending}
          mood={mood}
          label={`${title} · ${statusLine}`}
          onPress={() => void openSummary()}
        />
        <Text style={[s.title, { fontSize: 20 }]}>{title}</Text>
        <Text style={s.muted}>{statusLine}</Text>
        {/* 버전 표시는 여기 한 곳만 (app.json 이 정본) */}
        {home && <Text style={[s.small, mono]}>0Siri v{appJson.expo.version}</Text>}
      </View>
      {!home && (
        <View
          accessibilityRole="tablist"
          style={[s.row, { borderBottomWidth: 1, borderBottomColor: colors.line }]}
        >
          {ROOM_TABS.map((id) => (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === id }}
              onPress={() => setTab(id)}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: 10,
                borderBottomWidth: 2,
                borderBottomColor: tab === id ? colors.accent : "transparent",
              }}
            >
              <Text
                style={[
                  s.text,
                  { fontSize: 14 },
                  tab === id
                    ? { color: colors.accent, fontWeight: "700" }
                    : { color: colors.muted },
                ]}
              >
                {text.tabs[id]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {tab === "chat" ? (
        <>
          {board && !home && (
            <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
              {/* 웹은 현황판 고정, 앱은 요약 한 줄로 접고 누르면 펼친다 */}
              {!desktop && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: boardOpen }}
                  onPress={() => setBoardOpen((v) => !v)}
                  style={[
                    s.between,
                    {
                      gap: 8,
                      padding: 10,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: colors.line,
                      backgroundColor: colors.card,
                      marginBottom: boardOpen ? 8 : 0,
                    },
                  ]}
                >
                  <Text style={[s.small, mono, { color: colors.text }]}>
                    {text.boardLine(pending, board.progress)}
                  </Text>
                  <View style={[s.row, { gap: 2 }]}>
                    {!boardOpen && <Text style={s.small}>{text.expand}</Text>}
                    {boardOpen ? (
                      <ChevronUp size={14} color={colors.muted} />
                    ) : (
                      <ChevronDown size={14} color={colors.muted} />
                    )}
                  </View>
                </Pressable>
              )}
              {(desktop || boardOpen) && <BoardWidget board={board} />}
            </View>
          )}
          <View style={{ flex: 1 }}>
            <ChatScreen
              roomId={room.id}
              active
              onMood={setMood}
              header={header}
              footer={
                waiting.length ? <View style={{ gap: 10 }}>{waiting.map(render)}</View> : null
              }
              placeholder={home ? undefined : text.composer}
              answerLabel={answerLabel}
            />
          </View>
        </>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
          {tab === "goals" && <TeamGoalsScreen roomId={room.id} />}
          {tab === "feed" && <FeedTab roomId={room.id} />}
          {tab === "ideas" && <IdeasTab roomId={room.id} />}
          {tab === "files" && <FilesTab roomId={room.id} />}
        </ScrollView>
      )}
      {teams && (
        <Sheet title={text.teams} onClose={() => setTeams(false)}>
          <RoomList
            activeId={room.id}
            onOpen={(next) => {
              setTeams(false);
              onOpenRoom?.(next);
            }}
          />
        </Sheet>
      )}
      {summary !== null && (
        <Sheet title={text.summaryTitle} subtitle={title} onClose={() => setSummary(null)}>
          {summary === "loading" ? (
            <Skeleton rows={2} />
          ) : "error" in summary ? (
            <View style={{ gap: 8 }}>
              <ErrorNotice error={`${text.loadFailed}: ${summary.error}`} />
              <Button small onPress={() => void openSummary()}>
                {text.retry}
              </Button>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <Text style={s.heading}>{summary.label}</Text>
              <View style={{ gap: 6 }}>
                <Text style={s.label}>{text.stage}</Text>
                <Flow flow={summary.flow} />
              </View>
              <View style={{ gap: 4 }}>
                <Text style={s.label}>
                  {text.pendingList} {summary.pendingApprovals.length}
                </Text>
                {summary.pendingApprovals.length ? (
                  summary.pendingApprovals.map((a) => (
                    <Text key={a.id} style={s.text}>
                      · {a.title}
                    </Text>
                  ))
                ) : (
                  <Text style={s.muted}>{text.none}</Text>
                )}
              </View>
              <View style={{ gap: 4 }}>
                <Text style={s.label}>{text.goalProgress}</Text>
                <Bar value={summary.progress} />
                <Text style={[s.small, mono]}>
                  {text.progress(summary.progress)} · {text.today(summary.doneToday)}
                </Text>
              </View>
              {!!summary.recentDone?.length && (
                <View style={{ gap: 4 }}>
                  <Text style={s.label}>{text.recentDone}</Text>
                  {summary.recentDone.map((line) => (
                    <Text key={line} style={s.text}>
                      · {line}
                    </Text>
                  ))}
                </View>
              )}
              <Text style={s.muted}>
                {text.nextReport}:{" "}
                {summary.nextReportAt ? timeLabel(summary.nextReportAt) : text.noReport}
              </Text>
              {!home && (
                <View style={[s.row, { gap: 8 }]}>
                  <Button
                    small
                    onPress={() => {
                      setSummary(null);
                      setTab("chat");
                      setBoardOpen(true);
                    }}
                  >
                    {text.openBoard}
                  </Button>
                  <Button
                    small
                    onPress={() => {
                      setSummary(null);
                      setTab("goals");
                    }}
                  >
                    {text.openGoals}
                  </Button>
                </View>
              )}
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}

function Message({
  message: m,
  onDecide,
  onGoals,
}: {
  message: RoomMessage;
  onDecide: (decision: Decision, reason?: RejectReason) => Promise<void>;
  onGoals: () => void;
}) {
  const p = m.payload ?? {};
  if (m.kind === "card" && p.card === "approval")
    return (
      <ApprovalCard
        title={String(p.title ?? "")}
        summary={String(p.summary ?? "")}
        evidence={typeof p.evidence === "string" ? p.evidence : undefined}
        status={String(p.status ?? "pending")}
        onDecide={onDecide}
      />
    );
  // 결정: widget payload 가 현황판 모양(flow 가 있음)일 때만 위젯으로, 아니면 텍스트로 보인다.
  if (m.kind === "widget" && p.flow && typeof p.flow === "object")
    return <BoardWidget board={{ ...(p as unknown as Board), roomId: m.roomId }} />;
  if (m.kind === "report") {
    const metrics = (p.metrics ?? {}) as Record<string, unknown>;
    const plan = Array.isArray(metrics.next_week_plan) ? (metrics.next_week_plan as string[]) : [];
    return (
      <Card style={{ gap: 10, padding: 14, backgroundColor: colors.brassSoft }}>
        <Text style={[s.label, { color: colors.brass }]}>{text.report}</Text>
        {m.text ? <Text style={s.text}>{m.text}</Text> : null}
        <View style={[s.between, { gap: 6 }]}>
          {(Object.keys(text.metrics) as (keyof typeof text.metrics)[]).map((k) => (
            <View key={k} style={{ alignItems: "center", flex: 1 }}>
              {/* 값이 없으면 0 이 아니라 «—» — 아직 재지 않은 것과 0 건은 다르다 */}
              <Text style={[s.heading, mono, { fontSize: 18 }]}>
                {typeof metrics[k] === "number" ? String(metrics[k]) : "—"}
              </Text>
              <Text style={s.small}>{text.metrics[k]}</Text>
            </View>
          ))}
        </View>
        {plan.length > 0 && (
          <View style={{ gap: 2 }}>
            <Text style={s.label}>{text.nextWeek}</Text>
            {plan.map((line) => (
              <Text key={line} style={s.muted}>
                · {line}
              </Text>
            ))}
          </View>
        )}
        <Button small style={{ alignSelf: "flex-start" }} onPress={onGoals}>
          {text.reportDetail}
        </Button>
      </Card>
    );
  }
  if (m.kind === "digest")
    return (
      <Card style={{ padding: 14, backgroundColor: colors.sunk }}>
        <Text style={s.label}>{text.digest}</Text>
        <Text style={s.text}>{m.text}</Text>
      </Card>
    );
  const mine = m.role === "user";
  const by = p.answeredBy as AnsweredBy | undefined;
  return (
    <View style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "85%", gap: 2 }}>
      <View
        style={{
          backgroundColor: mine
            ? colors.accentSoft
            : m.role === "system"
              ? "transparent"
              : colors.card,
          borderRadius: 10,
          borderWidth: m.role === "assistant" ? 1 : 0,
          borderColor: colors.line,
          paddingHorizontal: 14,
          paddingVertical: 8,
        }}
      >
        <Text style={m.role === "system" ? s.small : s.text}>{m.text}</Text>
      </View>
      <Text style={[s.small, { marginHorizontal: 6 }]}>
        {by ? `${by.label} · ` : ""}
        {relativeDate(m.createdAt)}
      </Text>
    </View>
  );
}
