// 0Siri 방 목록(화면 2)·팀 채팅방(화면 3)·SSE 스트림 — «0Siri 종합 기획» §03, 계약은 docs/0siri-api-contract.md.
// 타입은 서버 정의를 type-import, 라벨·목록은 packages/domain/src/osiri.ts 에서만 가져온다(여기서 다시 적지 않는다).
import { fetch as streamFetch } from "expo/fetch";
import {
  ArrowLeft,
  BellOff,
  ChevronDown,
  ChevronUp,
  Images,
  Lightbulb,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Sparkles,
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
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  type AnsweredByView,
  APPROVAL_STATUS_LABELS,
  type ApprovalKind,
  ARCHIVED_ROOM_NOTICE,
  CHARACTER_STATE_OF,
  type CharacterState,
  ESCALATION_LABEL,
  GOAL_LEVEL_LABELS,
  GOAL_METRIC_LABELS,
  GOAL_UNBLOCK_LABEL,
  isHomeRoom,
  PERSONAL_ROOM_TITLE,
  PRESENCE_LABELS,
  PRESENCE_STATES,
  PROPOSAL_DECISION_LABELS,
  PROPOSAL_STATUS_LABELS,
  type PresenceState,
  REJECT_REASON_KINDS,
  REJECT_REASON_LABELS,
  REPORT_METRIC_KEYS,
  type RejectReasonKind,
  ROOM_TITLE_MAX,
  SKILL_STATUS_LABELS,
  STAGE_LABELS,
  THIRD_PARTY_LABEL,
  VISIBLE_STAGES,
} from "../../../../packages/domain/src/osiri";
import type { Approval } from "../../../server/src/osiri/approvals.ts";
import type {
  Activity,
  RoomBoard,
  RoomCard,
  RoomMessage,
  Rooms,
  TaskStage,
  TeamGoal,
} from "../../../server/src/osiri/rooms.ts";
import type { Skill } from "../../../server/src/osiri/skills.ts";
import appJson from "../../app.json";
import { apiBase } from "../api";
import { ApiError } from "../api-response";
import { ChatScreen } from "../chat";
import {
  Badge,
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
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
import { SkillsScreen } from "./skills";
import { Choice, LoadState, useAction, useLoad } from "./store";
import { type GoalProposal, LoadError, TeamGoalsScreen } from "./team-goals";

export type { PresenceState, RoomBoard, RoomMessage, TaskStage, TeamGoal };
/** GET /rooms 항목 — 서버 RoomCard 가 정본 */
export type Room = RoomCard;
/** 방을 열 때 어디를 보일지: 그 메시지, 또는 지금 결정할 승인 카드. */
export interface RoomFocus {
  messageId?: string;
  approval?: boolean;
}
const isPresence = (v: string): v is PresenceState =>
  (PRESENCE_STATES as readonly string[]).includes(v);
/**
 * GET /inbox 의 pending 항목 (tokenHash 제외 + roomTitle).
 * kind "skill" 은 승인 요청이 아니라 스킬 초안이다 — skillId 로 `/skills/:id/decide` 에 결정한다.
 */
export type PendingApproval = Omit<Approval, "tokenHash" | "kind"> & {
  roomTitle: string;
  kind: ApprovalKind;
  skillId?: string;
};
export type RejectKind = RejectReasonKind;
type Board = RoomBoard;
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
  answers?: Record<string, AnsweredByView>;
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
  newRoom: "새 대화방",
  newRoomPlaceholder: "예: 이사 준비, 이번 달 블로그",
  createRoom: "만들기",
  roomSettings: "방 설정",
  roomName: "방 이름",
  saveName: "이름 저장",
  teamRoomNote: "팀 방 — 이름은 팀이 정합니다. 구독 해지는 스토어 › 내 팀에서.",
  homeRoomNote: "영시리 기본 방 — 지울 수 없어요.",
  pinRow: "맨 위에 고정",
  notify: "알림",
  on: "켬",
  off: "끔",
  roomSkills: "이 방에 장착된 스킬",
  deleteRoom: "이 대화방 삭제",
  digestTitle: "결재 요약",
  openInbox: "결재함 열기",
  goRoom: "방으로 이동",
  noPending: "대기 없음",
  goApproval: (title: string, n: number) => `${title} 승인 대기 ${n}건 — 승인 카드로 이동`,
  thirdParty: `(${THIRD_PARTY_LABEL})`,
  waitingCount: (n: number) => `승인 ${n}건 대기 중`,
  offline: "연결 대기",
  streamStopped: "실시간 연결이 끊겼어요",
  streamSkipped: (event: string) =>
    `실시간 알림(${event}) 하나를 읽지 못했어요. 화면이 늦을 수 있어요`,
  hashMissing:
    "이 승인 카드에 동결 해시가 없어 결정을 보낼 수 없어요. 새로 고친 뒤 다시 시도해 주세요",
  skillIdMissing: "이 스킬 초안의 id 를 받지 못해 결정을 보낼 수 없어요",
  focusMissing: "가리킨 메시지를 이 방에서 찾지 못했어요",
  boardMissing: "현황판을 받지 못해 팀 상태를 알 수 없어요",
  skills: "스킬",
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
  approve: "승인",
  reject: "반려",
  rejectWhy: "반려 사유를 골라 주세요",
  rejectNote: "덧붙일 말 (선택)",
  rejectSend: "반려 보내기",
  cancel: "취소",
  evidence: "근거",
  viewInRoom: "방에서 보기",
  report: "주간 보고",
  reportDetail: "상세는 목표 탭",
  nextWeek: "다음 주 계획",
  digest: "부재 중 진척",
  noMessages: "아직 기록이 없어요. 아래에 목표를 말하면 팀장이 쪼개서 시작해요.",
  composer: "메시지 입력 — 목표를 말하면 팀이 쪼개서 실행합니다",
  fromMemory: "기억에서 찾음",
  resumed: "멈춘 목표를 풀었습니다 — 팀이 이어서 작업합니다.",
  tabs: { chat: "채팅", goals: "목표", feed: "피드", ideas: "아이디어", files: "파일" },
  feedPending: "승인 대기",
  feedActivity: "활동",
  feedEmpty: { title: "아직 활동이 없어요", detail: "팀이 일하면 여기에 쌓여요." },
  ideasEmpty: {
    title: "아직 제안이 없어요",
    detail: "팀이 다음 주제·목표를 제안하면 여기에 와요.",
  },
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
  // skipped = 읽지 못해 건너뛴 이벤트가 있다 — 연결은 살아 있어도 화면이 낡았을 수 있으니 부르는 쪽이 보이고 다시 읽는다
  const [status, setStatus] = useState<{ state: StreamState; error: string; skipped: string }>({
    state: "connecting",
    error: "",
    skipped: "",
  });
  const clearSkipped = useCallback(() => setStatus((prev) => ({ ...prev, skipped: "" })), []);
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
        setStatus((prev) => ({ ...prev, skipped: text.streamSkipped(event) }));
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
            const error = `${text.streamStopped} (${res.status})`;
            setStatus((prev) => ({ ...prev, state: "stopped", error }));
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          delay = 1000;
          setStatus((prev) => ({ ...prev, state: "live", error: "" }));
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
        setStatus((prev) => ({ ...prev, state: "waiting", error: why }));
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
  return { ...status, clearSkipped };
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
  return useEventStream("/api/stream", (event, payload) => {
    if (event === "rooms" || event === "inbox") void refreshRooms(api);
    for (const l of userEventListeners) l(event, payload);
  });
}
/**
 * 사용자 스트림 상태 칩 (셸이 사이드바·탭 위에 둔다). 끊겨 있으면 «연결 대기» — 배지·진척이 낡았을 수 있다는 뜻이다.
 * 읽지 못해 건너뛴 이벤트가 있으면 사유와 [다시 시도]. 정상일 때는 아무것도 그리지 않는다.
 */
export function LiveChip({ live }: { live: ReturnType<typeof useEventStream> }) {
  const { api } = useWorkspace();
  const offline = live.state === "waiting" || live.state === "stopped";
  if (!offline && !live.skipped) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[s.row, { gap: 8, flexWrap: "wrap", justifyContent: "center", paddingVertical: 6 }]}
    >
      {offline && <Chip tint={colors.warnBg}>{text.offline}</Chip>}
      {live.state === "stopped" && <Text style={[s.small, { flexShrink: 1 }]}>{live.error}</Text>}
      {!!live.skipped && (
        <>
          <Text style={[s.small, { flexShrink: 1 }]}>{live.skipped}</Text>
          <Button
            small
            onPress={() => {
              live.clearSkipped();
              void refreshRooms(api);
            }}
          >
            {text.retry}
          </Button>
        </>
      )}
    </View>
  );
}
// 사용자 스트림(`/api/stream`)은 앱에 하나뿐이다 — 결재함·목표 화면은 연결을 또 열지 않고 여기서 이벤트만 듣는다.
const userEventListeners = new Set<(event: string, payload: unknown) => void>();
/** 사용자 스트림의 `rooms {roomId}` · `inbox` 이벤트를 듣는다. 연결은 `useRoomsLive` 가 쥐고 있다. */
export function useUserEvent(
  event: "rooms" | "inbox",
  onEvent: (payload: { roomId?: string }) => void,
) {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => {
    const listener = (name: string, payload: unknown) => {
      if (name === event) latest.current((payload ?? {}) as { roomId?: string });
    };
    userEventListeners.add(listener);
    return () => {
      userEventListeners.delete(listener);
    };
  }, [event]);
}

const roomTitle = (room: Room) =>
  isHomeRoom(room) ? `${PERSONAL_ROOM_TITLE} · ${text.personalRole}` : room.title;

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

// ponytail: 웹은 진짜 블러(backdrop-filter) + 아래로 사라지는 마스크, 앱은 배경색 그라데이션(RN 0.81 new arch).
// 앱도 블러가 필요하면 expo-blur 를 붙인다(네이티브 모듈 추가 → APK 재빌드).
const fadeBehind = (bg: string): object =>
  Platform.OS === "web"
    ? {
        backdropFilter: "blur(10px)",
        backgroundColor: `${bg}cc`,
        maskImage: "linear-gradient(to bottom, #000 72%, transparent)",
      }
    : { experimental_backgroundImage: `linear-gradient(to bottom, ${bg} 72%, ${bg}00)` };

/**
 * 홈(영시리 대화) 위 대화방 줄 — 팀을 붙일 때마다 방이 늘므로 목록이 늘 보이게 (마스터 2026-10-10).
 * 영시리 방은 지금 보고 있으므로 빼고, 팀 방을 동그란 얼굴로 가로로 나열한다. 결재 대기는 배지.
 * 전체 목록·새 대화방·스토어는 왼쪽 위 ≡ 메뉴 한 곳에만 둔다(마스터 2026-10-10 «전체 부분의 버튼이 두개야???»).
 * 팀 방이 없으면 줄 자체를 그리지 않는다 — Muse 처럼 머리는 얼굴 하나만.
 */
function RoomStrip({ onOpen }: { onOpen: (room: Room) => void }) {
  const { rooms } = useRooms();
  const teams = (rooms ?? []).filter((r) => !isHomeRoom(r) && !r.archived);
  if (!teams.length) return null;
  const cell = (key: string, label: string, onPress: () => void, face: ReactNode, badge = 0) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label} · 승인 대기 ${badge}건` : label}
      onPress={onPress}
      style={{ width: 62, alignItems: "center", gap: 3 }}
    >
      <View
        style={{
          width: 46,
          height: 46,
          borderRadius: 23,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.line,
        }}
      >
        {face}
      </View>
      {badge > 0 && <Badge count={badge} style={{ position: "absolute", top: -2, right: 4 }} />}
      <Text numberOfLines={1} style={[s.small, { maxWidth: 60 }]}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, alignSelf: "stretch" }}
      contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 6, gap: 4 }}
    >
      {teams.map((r) =>
        cell(
          r.id,
          r.title,
          () => onOpen(r),
          <CharacterAvatar character={r.character} size={40} />,
          r.pendingApprovals,
        ),
      )}
    </ScrollView>
  );
}

/** 새 대화방(주제방): 이름 하나로 영시리와 따로 이야기할 방을 연다 (마스터 2026-10-10 «대화방을 추가하는 것도 없고»). */
export function NewRoomForm({ onCreated }: { onCreated: (room: Room) => void }) {
  const { api } = useWorkspace();
  const act = useAction();
  const [title, setTitle] = useState("");
  return (
    <View style={{ gap: 8, paddingBottom: 8 }}>
      <Field
        label={text.newRoom}
        placeholder={text.newRoomPlaceholder}
        value={title}
        maxLength={ROOM_TITLE_MAX}
        onChangeText={setTitle}
      />
      <Button
        small
        primary
        icon={MessageSquarePlus}
        busy={act.busy}
        disabled={!title.trim()}
        onPress={() =>
          act.run(async () => {
            const room = await api.request<Room>("/api/rooms", { title: title.trim() });
            const list = await refreshRooms(api);
            setTitle("");
            onCreated(list?.find((r) => r.id === room.id) ?? room);
          })
        }
      >
        {text.createRoom}
      </Button>
      <ErrorNotice error={act.error} />
    </View>
  );
}

/** 방별 설정 (마스터 2026-10-10 «방별 설정이 있어야 하지 않아?»): 이름(내가 만든 방) · 고정 · 알림 · 이 방 스킬 · 삭제(내가 만든 방). */
function RoomSettings({
  room,
  onChanged,
  onSkills,
  onDeleted,
}: {
  room: Room;
  onChanged: (room: Room) => void;
  onSkills: () => void;
  onDeleted: () => void;
}) {
  const { api } = useWorkspace();
  const act = useAction();
  const [title, setTitle] = useState(room.title);
  const save = (fn: () => Promise<unknown>) =>
    act.run(async () => {
      await fn();
      const list = await refreshRooms(api);
      const next = list?.find((r) => r.id === room.id);
      if (next) onChanged(next);
    });
  const toggle = (label: string, on: boolean, path: "pin" | "mute", key: "pinned" | "muted") => (
    <View style={[s.row, { gap: 8, alignItems: "center" }]}>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
      <Choice
        label={text.on}
        selected={on}
        disabled={act.busy}
        onPress={() => save(() => api.request(`/api/rooms/${room.id}/${path}`, { [key]: true }))}
      />
      <Choice
        label={text.off}
        selected={!on}
        disabled={act.busy}
        onPress={() => save(() => api.request(`/api/rooms/${room.id}/${path}`, { [key]: false }))}
      />
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      {room.topic ? (
        <View style={{ gap: 8 }}>
          <Field
            label={text.roomName}
            value={title}
            maxLength={ROOM_TITLE_MAX}
            onChangeText={setTitle}
          />
          <Button
            small
            disabled={act.busy || !title.trim() || title.trim() === room.title}
            onPress={() =>
              save(() => api.request(`/api/rooms/${room.id}`, { title: title.trim() }, "PATCH"))
            }
          >
            {text.saveName}
          </Button>
        </View>
      ) : (
        <Text style={s.muted}>{room.packageId ? text.teamRoomNote : text.homeRoomNote}</Text>
      )}
      {toggle(text.pinRow, !!room.pinned, "pin", "pinned")}
      {toggle(text.notify, !room.muted, "mute", "muted")}
      <Button small icon={Sparkles} onPress={onSkills}>
        {text.roomSkills}
      </Button>
      {room.topic && (
        <Button
          small
          danger
          disabled={act.busy}
          onPress={() =>
            act.run(async () => {
              await api.request(`/api/rooms/${room.id}`, undefined, "DELETE");
              await refreshRooms(api);
              onDeleted();
            })
          }
        >
          {text.deleteRoom}
        </Button>
      )}
      <ErrorNotice error={act.error} />
    </View>
  );
}

export function RoomList({
  onOpen,
  activeId,
}: {
  onOpen: (room: Room, focus?: RoomFocus) => void;
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
        const personal = isHomeRoom(room);
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
                {room.thirdParty && <Text style={s.small}>{text.thirdParty}</Text>}
                {room.pendingApprovals > 0 && (
                  // 배지를 누르면 같은 방의 승인 카드 위치로 간다 (기획 화면 2)
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={text.goApproval(roomTitle(room), room.pendingApprovals)}
                    hitSlop={8}
                    onPress={() => onOpen(room, { approval: true })}
                  >
                    <Badge count={room.pendingApprovals} />
                  </Pressable>
                )}
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

/**
 * 결재 요약 카드 (화면 2 우측) — 승인을 기다리는 방과 [방으로 이동], 다 처리했으면 «대기 없음». 카드를 누르면 결재함(화면 4).
 * 그 아래 «부재 중 진척»: 마지막으로 본 뒤 팀마다 있었던 일 한 줄(서버 RoomCard.digest).
 */
export function ApprovalDigest({
  onOpenRoom,
  currentId,
}: {
  onOpenRoom: (room: Room, focus?: RoomFocus) => void;
  /** 지금 열려 있는 방 — 그 방의 부재 중 진척은 타임라인 머리에 이미 있다 */
  currentId?: string;
}) {
  const { api, navigate } = useWorkspace();
  const { rooms, error } = useRooms();
  // 모바일 홈에는 방 목록이 떠 있지 않다 — 목록을 못 읽었으면 여기서 사유와 [다시 시도] 를 보인다
  if (!rooms)
    return error ? (
      <View style={{ gap: 8 }}>
        <ErrorNotice error={`${text.loadFailed}: ${error}`} />
        <Button small onPress={() => void refreshRooms(api)}>
          {text.retry}
        </Button>
      </View>
    ) : (
      <Skeleton rows={1} height={58} />
    );
  const waiting = rooms.filter((r) => r.pendingApprovals > 0);
  const away = rooms.filter((r) => !!r.digest && r.id !== currentId);
  return (
    <View style={{ gap: 10 }}>
      <Card style={{ gap: 8, padding: 14 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text.openInbox}
          onPress={() => navigate("inbox")}
          style={[s.between, { gap: 8 }]}
        >
          <Text style={s.label}>{text.digestTitle}</Text>
          <Text style={s.small}>{text.openInbox} ›</Text>
        </Pressable>
        {waiting.length === 0 && <Text style={s.muted}>{text.noPending}</Text>}
        {waiting.map((room) => (
          <View key={room.id} style={[s.between, { gap: 8 }]}>
            <Text style={[s.text, { flex: 1 }]} numberOfLines={1}>
              {roomTitle(room)} {text.pendingLine(room.pendingApprovals)}
            </Text>
            <Button small onPress={() => onOpenRoom(room, { approval: true })}>
              {text.goRoom}
            </Button>
          </View>
        ))}
      </Card>
      {away.length > 0 && (
        <Card style={{ gap: 6, padding: 14, backgroundColor: colors.sunk }}>
          <Text style={s.label}>{text.digest}</Text>
          {away.map((room) => (
            <Pressable
              key={room.id}
              accessibilityRole="button"
              accessibilityLabel={`${roomTitle(room)} — ${text.goRoom}`}
              onPress={() => onOpenRoom(room)}
            >
              <Text style={s.text}>
                {roomTitle(room)} — {room.digest}
              </Text>
            </Pressable>
          ))}
        </Card>
      )}
    </View>
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
            <Text style={[s.small, { width: 28 }]}>{GOAL_LEVEL_LABELS[g.level]}</Text>
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
/**
 * 승인 결정. frozenHash = 그 카드가 화면에 그려질 때 받은 inputHash — 사용자가 본 것을 승인한다.
 * 누르는 순간 다시 읽어 맞추지 않는다(그러면 그 사이 내용이 바뀌어도 통과한다). 해시가 없으면 보내지 않고 사유를 보인다.
 * 내용이 바뀌었거나 이미 처리된 건은 서버가 409 로 막는다 — 부르는 쪽이 그 문장을 보이고 카드를 다시 읽는다.
 */
export async function decideApproval(
  api: Api,
  approvalId: string,
  decision: Decision,
  frozenHash: unknown,
  reason?: RejectReason,
) {
  if (typeof frozenHash !== "string" || !frozenHash) throw new Error(text.hashMissing);
  return api.request<{ status: string }>(`/api/approvals/${approvalId}/decide`, {
    decision,
    frozenHash,
    reasonKind: reason?.kind,
    reason: reason?.note,
  });
}
/**
 * 결재함 항목 하나를 결정한다 (결재함·방 피드 공용). 스킬 초안(kind "skill")은 `/skills/:id/decide` 로 간다.
 * label 은 결과 칩에 쓸 이름 — 승인 요청은 status 로 찾으므로 비운다.
 */
export async function decidePending(
  api: Api,
  item: PendingApproval,
  decision: Decision,
  reason?: RejectReason,
): Promise<{ status: string; label?: string }> {
  if (item.kind !== "skill") return decideApproval(api, item.id, decision, item.inputHash, reason);
  if (!item.skillId) throw new Error(text.skillIdMissing);
  // 스킬 반려 사유는 한 문장이다 — 고른 종류(톤·사실·주제)와 덧붙인 말을 이어 보낸다
  const why =
    reason && [REJECT_REASON_LABELS[reason.kind], reason.note].filter(Boolean).join(" — ");
  const skill = await api.request<Skill>(`/api/skills/${item.skillId}/decide`, {
    decision,
    reason: why,
  });
  return { status: skill.status, label: SKILL_STATUS_LABELS[skill.status] };
}
/** 409 = 내용이 바뀌었거나 이미 처리됨. 문장은 서버 것을 그대로 보이고, 화면은 카드를 다시 읽어야 한다. */
export const isConflict = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409;
/** 승인 카드. [승인]=채움 [반려]=외곽선, 반려는 사유(톤·사실·주제)를 고른 뒤에만 보낸다. 결정되면 그 상태로 잠긴다. */
export function ApprovalCard({
  title,
  summary,
  evidence,
  status,
  statusLabel,
  character,
  onDecide,
  onOpenRoom,
}: {
  title: string;
  summary: string;
  evidence?: string;
  status: string;
  /** 승인 상태가 아닌 결과(스킬 초안의 «장착됨» 등)의 이름 — 서버가 준 status 의 라벨 */
  statusLabel?: string;
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
  const good = status === "approved" || status === "consumed" || status === "active";
  const tone = pending
    ? { fg: colors.warn, bg: colors.warnBg, border: colors.warn }
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
            {statusLabel ?? (APPROVAL_STATUS_LABELS as Record<string, string>)[status] ?? status}
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
  assetId,
  state,
  pending,
  mood,
  label,
  onPress,
}: {
  /** 서버 현황판의 `character.assetId` — 어떤 그림인지는 eve.tsx 가 정한다 */
  assetId: string;
  /** 서버 현황판의 `character.state` — 여기서 다시 계산하지 않는다 */
  state: CharacterState;
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
    // 승인 대기는 사용자 쪽을 보고 멈춘다. 완료 보고는 한 번 기울고 멈춘다 — 서버가 곧 idle 을 보낸다.
    if (state === "awaiting_approval") return;
    const loop =
      state === "reporting" ? seq(220) : Animated.loop(seq(state === "working" ? 420 : 1800));
    loop.start();
    return () => loop.stop();
  }, [anim, state, still]);
  const transform =
    state === "working"
      ? [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, 3] }) }] // 작게 끄덕임
      : state === "reporting"
        ? [{ rotate: anim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "8deg"] }) }] // 보고 카드 쪽으로 기울임
        : [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] }) }]; // 느린 호흡
  // 스스로 움직이는 캐릭터(영시리)는 기분을 넘기고, 아니면 상태 애니메이션을 여기서 입힌다
  const own = selfAnimated(assetId);
  const ownMood: Mood =
    pending > 0
      ? "alert"
      : mood !== "idle"
        ? mood
        : state === "working"
          ? "thinking"
          : state === "reporting"
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
        {/* 동그란 프로필 칸 하나만 차지한다 — 캐릭터는 그 안에서만 움직인다 */}
        <View
          style={{
            width: 60,
            height: 60,
            borderRadius: 30,
            overflow: "hidden",
            alignItems: "center",
            // 영시리는 몸 전체(높이 1.08배)가 원 위쪽에 들어가게 — 아래는 이름 알약이 살짝 덮는다
            justifyContent: own ? "flex-start" : "center",
            paddingTop: own ? 3 : 0,
            backgroundColor: colors.surface,
          }}
        >
          <CharacterAvatar character={assetId} size={own ? 46 : 60} mood={ownMood} />
        </View>
      </Animated.View>
      <Badge count={pending} style={{ position: "absolute", top: 0, right: -6 }} />
    </Pressable>
  );
}

// --- 방 탭: 피드 · 아이디어 · 파일 ---
/** 피드 = 그 방의 결재함(화면 4): 위에 지금 결정할 승인 대기, 아래에 활동. tick 은 방 스트림의 승인 이벤트마다 오른다. */
function FeedTab({
  roomId,
  tick,
  onFocus,
}: {
  roomId: string;
  tick: number;
  onFocus: (focus: RoomFocus) => void;
}) {
  const { api } = useWorkspace();
  const key = `${roomId}|${tick}`;
  const feed = useLoad(
    () => api.request<(Activity & { label: string })[]>(`/api/rooms/${roomId}/feed`),
    key,
  );
  const inbox = useLoad(
    () =>
      api.request<{ pending: PendingApproval[] }>(
        `/api/inbox?room_id=${encodeURIComponent(roomId)}`,
      ),
    key,
  );
  const [conflict, setConflict] = useState("");
  const decide = async (a: PendingApproval, decision: Decision, reason?: RejectReason) => {
    setConflict("");
    try {
      await decidePending(api, a, decision, reason);
    } catch (e) {
      if (!isConflict(e)) throw e;
      setConflict(e.message); // 카드는 다시 읽으면 사라지므로 사유를 탭 머리에 남긴다
    }
    inbox.retry();
    feed.retry();
    void refreshRooms(api); // 목록·탭 배지
  };
  const pending = inbox.data?.pending ?? [];
  return (
    <View style={{ gap: 10 }}>
      <ErrorNotice error={conflict} />
      {inbox.error ? <LoadError error={inbox.error} onRetry={inbox.retry} /> : null}
      {pending.length > 0 && (
        <Text style={s.label}>
          {text.feedPending} {pending.length}
        </Text>
      )}
      {pending.map((a) => (
        <ApprovalCard
          key={a.id}
          title={a.title}
          summary={a.summary}
          evidence={a.evidence}
          status="pending"
          onDecide={(decision, reason) => decide(a, decision, reason)}
          onOpenRoom={() => onFocus(a.messageId ? { messageId: a.messageId } : { approval: true })}
        />
      ))}
      <Text style={s.label}>{text.feedActivity}</Text>
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
    </View>
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
    <LoadState
      {...ideas}
      empty={ideas.data?.length === 0 && { ...text.ideasEmpty, icon: Lightbulb }}
    >
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
                {PROPOSAL_DECISION_LABELS.accept}
              </Button>
              <Button small disabled={busy === p.id} onPress={() => void decide(p.id, "hold")}>
                {PROPOSAL_DECISION_LABELS.hold}
              </Button>
            </View>
          ) : (
            <Text style={s.small}>{PROPOSAL_STATUS_LABELS[p.status]}</Text>
          )}
        </Card>
      ))}
    </LoadState>
  );
}
/** `GET /rooms/:id/files` — 서버 `Rooms.files()` 가 만든다. 목표 화면(team-goals.tsx)도 이 타입을 쓴다 */
export type RoomFiles = Awaited<ReturnType<Rooms["files"]>>;
function FilesTab({ roomId }: { roomId: string }) {
  const { api } = useWorkspace();
  const files = useLoad(() => api.request<RoomFiles>(`/api/rooms/${roomId}/files`), roomId);
  const none = !!files.data && !files.data.approved.length && !files.data.audit.length;
  return (
    <LoadState {...files} empty={none && { ...text.filesEmpty, icon: Images }}>
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

/**
 * 하단 «아이디어»·«미디어» 탭 (Muse 하단처럼). 방마다 있는 아이디어·파일 탭을 방 밖에서 연다 —
 * 위에서 방을 고르고(기본 = 영시리 개인 방), 아래는 방 안의 그 탭과 같은 화면이다.
 */
export function RoomScopedScreen({ kind }: { kind: "ideas" | "media" }) {
  const { api } = useWorkspace();
  const state = useRooms();
  const [picked, setPicked] = useState("");
  if (!state.rooms)
    return (
      <LoadState loading={!state.error} error={state.error} retry={() => void refreshRooms(api)}>
        {null}
      </LoadState>
    );
  const list = [...state.rooms].sort((a, b) => Number(isHomeRoom(b)) - Number(isHomeRoom(a)));
  const room = list.find((r) => r.id === picked) ?? list[0];
  if (!room) return <Text style={s.muted}>{text.noMessages}</Text>;
  return (
    <View style={{ gap: 12 }}>
      {list.length > 1 && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {list.map((r) => (
            <Choice
              key={r.id}
              label={r.title}
              selected={r.id === room.id}
              onPress={() => setPicked(r.id)}
            />
          ))}
        </View>
      )}
      {kind === "ideas" ? (
        <IdeasTab key={room.id} roomId={room.id} />
      ) : (
        <FilesTab key={room.id} roomId={room.id} />
      )}
    </View>
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
  focus,
}: {
  room: Room;
  onBack: () => void;
  /** 기본 채팅(홈): 앱을 열면 바로 영시리와 대화. 뒤로 대신 팀 방 목록 버튼, 버전 표시 */
  home?: boolean;
  onOpenRoom?: (room: Room, focus?: RoomFocus) => void;
  /** 열자마자 보일 곳 — 목록 배지·결재함 [방에서 보기]·활동 항목이 넘긴다 */
  focus?: RoomFocus;
}) {
  const { api } = useWorkspace();
  const desktop = useWindowDimensions().width >= 900;
  const [tab, setTab] = useState<RoomTab>("chat");
  const [boardOpen, setBoardOpen] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const [headHeight, setHeadHeight] = useState(0);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 영시리와 이야기하는 방(홈·주제방): 팀 탭·현황판·팀 입력 안내 없이 대화만
  const plain = home || !!room.topic;
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<Summary | null | "loading" | { error: string }>(null);
  // 방 스트림 이벤트 수 — 목표·피드 탭이 이 값이 오르면 다시 읽는다
  const [tick, setTick] = useState({ goal: 0, approval: 0 });
  // 보일 곳: 밖에서 온 것(focus)과 방 안 탭(피드·목표)에서 고른 것이 같은 길을 탄다
  const [target, setTarget] = useState(focus);
  const [anchor, setAnchor] = useState<{ y: number | "end" }>();
  const [focusNote, setFocusNote] = useState("");
  const scrolled = useRef<RoomFocus | undefined>(undefined);
  const ys = useRef(new Map<string, number>());
  const show = useCallback((next: RoomFocus) => {
    setTarget(next);
    setTab("chat");
  }, []);
  useEffect(() => {
    if (focus) show(focus);
  }, [focus, show]);
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
  // 캐릭터 상태는 서버 현황판(board.character)이 정본이다 — 여기서 타이머로 다시 계산하지 않는다(쉼으로 돌리는 것도 서버가 한다).
  // room.presence 이벤트는 같은 값을 먼저 알려 줄 뿐이라, 현황판의 그 칸만 서버 대응표(CHARACTER_STATE_OF)로 옮겨 적는다.
  const onPresence = useCallback(
    (p: Presence) =>
      setBoard(
        (b) =>
          b && {
            ...b,
            presence: p.state,
            character: { ...b.character, state: CHARACTER_STATE_OF[p.state], summary: p.label },
          },
      ),
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
    onApproval: ({ approvalId, status }) => {
      setCardStatus(approvalId, status);
      setTick((t) => ({ ...t, approval: t.approval + 1 }));
    },
    onGoal: () => setTick((t) => ({ ...t, goal: t.goal + 1 })),
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
    let result: { status: string };
    try {
      // 카드가 그려질 때 받은 해시를 그대로 보낸다 — 사용자가 본 것을 승인한다
      result = await decideApproval(api, approvalId, decision, m.payload?.inputHash, reason);
    } catch (e) {
      // 내용이 바뀌었거나 이미 처리됨: 서버 문장은 카드가 보이고(다시 던진다), 카드는 최신으로 다시 읽는다
      if (isConflict(e)) void load();
      throw e;
    }
    setCardStatus(approvalId, result.status);
    void refreshRooms(api); // 목록·탭 배지
    try {
      setBoard(await api.request<Board>(`/api/rooms/${room.id}/board`));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const pending = board?.pendingApprovals ?? room.pendingApprovals;
  const title = isHomeRoom(room) ? PERSONAL_ROOM_TITLE : room.title;
  // 현황판이 오기 전에는 방 목록 항목(서버 값)의 상태를 같은 대응표로 읽는다
  const character = board?.character ?? {
    assetId: room.character,
    state: CHARACTER_STATE_OF[room.presence],
    summary: PRESENCE_LABELS[room.presence],
  };
  // 끊겨 있으면 «쉬는 중» 이 아니라 «연결 대기» 로 구분한다
  const offline = stream.state === "waiting" || stream.state === "stopped";
  const statusLine = offline
    ? text.offline
    : pending > 0
      ? text.waitingCount(pending)
      : (text.mood[mood] ?? character.summary);
  const isPendingCard = (m: RoomMessage) =>
    m.kind === "card" && m.payload?.card === "approval" && m.payload?.status === "pending";
  const render = (m: RoomMessage) => {
    const focused = m.id === target?.messageId;
    return (
      <View
        key={m.id}
        onLayout={(e) => {
          const y = e.nativeEvent.layout.y;
          ys.current.set(m.id, y);
          if (focused && scrolled.current !== target && !isPendingCard(m)) {
            scrolled.current = target;
            setAnchor({ y });
          }
        }}
        style={[
          { paddingHorizontal: 16 },
          focused && { borderLeftWidth: 3, borderLeftColor: colors.accent },
        ]}
      >
        <Message message={m} onDecide={(d, r) => decide(m, d, r)} onGoals={() => setTab("goals")} />
      </View>
    );
  };
  // 가리킨 곳으로: 지금 결정할 승인 카드는 대화 끝(footer)에 있고, 지난 메시지는 머리(header) 안의 제 자리에 있다
  useEffect(() => {
    if (!target || !messages || tab !== "chat" || scrolled.current === target) return;
    setFocusNote("");
    const m = target.messageId ? messages.find((x) => x.id === target.messageId) : undefined;
    if (target.messageId && !m) {
      scrolled.current = target;
      setFocusNote(text.focusMissing);
      return;
    }
    const pendingCard =
      !!m && m.kind === "card" && m.payload?.card === "approval" && m.payload?.status === "pending";
    const y = !m || pendingCard ? "end" : ys.current.get(m.id);
    if (y === undefined) return; // 아직 자리가 안 잡혔다 — 잡히면 onLayout 이 보낸다
    scrolled.current = target;
    setAnchor({ y });
  }, [target, messages, tab]);
  const answerLabel = (id: string) => {
    const a = timeline?.answers?.[id];
    return a ? answerLine(a) : undefined;
  };
  // 한 흐름: 지난 기록(부재 중 진척 → 보고·결정된 카드) → 대화 → 지금 결정할 승인 카드
  const header: ReactNode = (
    <View style={{ gap: 10 }}>
      {(home || desktop) && onOpenRoom && (
        <View style={{ paddingHorizontal: 16 }}>
          <ApprovalDigest onOpenRoom={onOpenRoom} currentId={room.id} />
        </View>
      )}
      {!!stream.error && stream.state === "stopped" && (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorNotice error={stream.error} />
        </View>
      )}
      {!!stream.skipped && (
        <View style={{ gap: 8, paddingHorizontal: 16 }}>
          <ErrorNotice error={stream.skipped} />
          <Button
            small
            onPress={() => {
              stream.clearSkipped();
              void load();
            }}
          >
            {text.retry}
          </Button>
        </View>
      )}
      {!!focusNote && (
        <View style={{ paddingHorizontal: 16 }}>
          <ErrorNotice error={focusNote} />
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
          {!plain && timeline.messages.length === 0 && !timeline.digest && (
            <Text style={[s.muted, { paddingHorizontal: 16 }]}>{text.noMessages}</Text>
          )}
          {timeline.messages.filter((m) => !isPendingCard(m)).map(render)}
        </>
      )}
    </View>
  );
  const waiting = messages?.filter(isPendingCard) ?? [];

  // Muse 처럼 머리가 대화 위에 떠 있고, 대화가 그 밑으로 지나가며 흐려진다 (마스터 2026-10-10 «대화가 넘가면 블러 처리되는 것도 없고»).
  // 팀 방은 탭 줄·현황판이 머리 아래 붙어 있어 지금처럼 쌓는다.
  const float = plain && !desktop;
  return (
    <View style={{ flex: 1 }}>
      {/* Muse 처럼: 위 가운데 작은 동그란 프로필 + 그 아래 이름·상태 알약. 양옆 버튼은 같은 줄 */}
      <View
        pointerEvents="box-none"
        onLayout={(e) => setHeadHeight(e.nativeEvent.layout.height)}
        style={[
          { alignItems: "center", paddingTop: 4, paddingBottom: 6 },
          float && {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 2,
            paddingBottom: 22,
            ...fadeBehind(colors.bg),
          },
        ]}
      >
        {!home && !desktop && (
          <View style={{ position: "absolute", left: 8, top: 4 }}>
            <IconButton icon={ArrowLeft} label={text.back} onPress={onBack} />
          </View>
        )}
        <View style={{ position: "absolute", right: 8, top: 4 }}>
          <IconButton
            icon={SlidersHorizontal}
            label={text.roomSettings}
            onPress={() => setSettingsOpen(true)}
          />
        </View>
        <Character
          assetId={character.assetId}
          state={character.state}
          pending={pending}
          mood={mood}
          label={`${title} · ${statusLine}`}
          onPress={() => void openSummary()}
        />
        <View
          style={{
            marginTop: -6,
            paddingHorizontal: 14,
            paddingVertical: 4,
            borderRadius: 999,
            backgroundColor: colors.surface,
            alignItems: "center",
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          <View style={[s.row, { gap: 6 }]}>
            <Text style={[s.text, { fontWeight: "700" }]}>{title}</Text>
            {room.thirdParty && <Text style={s.small}>{text.thirdParty}</Text>}
          </View>
          <Text style={s.small}>
            {statusLine}
            {/* 버전 표시는 여기 한 곳만 (app.json 이 정본) */}
            {home && <Text style={mono}> · 0Siri v{appJson.expo.version}</Text>}
          </Text>
        </View>
        {home && !desktop && <RoomStrip onOpen={(next) => onOpenRoom?.(next)} />}
      </View>
      {!plain && (
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
          {board && !plain && (
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
              header={
                float ? (
                  <>
                    <View style={{ height: Math.max(0, headHeight - 22) }} />
                    {header}
                  </>
                ) : (
                  header
                )
              }
              footer={
                waiting.length ? <View style={{ gap: 10 }}>{waiting.map(render)}</View> : null
              }
              placeholder={plain ? undefined : text.composer}
              welcome={home}
              answerLabel={answerLabel}
              anchor={anchor}
              online={!offline}
              readOnly={room.archived ? ARCHIVED_ROOM_NOTICE : undefined}
            />
          </View>
        </>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
          {tab === "goals" && (
            <TeamGoalsScreen
              roomId={room.id}
              tick={tick.goal}
              onOpenRoom={(_id, next) => show(next ?? {})}
              onChat={() => setTab("chat")}
            />
          )}
          {tab === "feed" && <FeedTab roomId={room.id} tick={tick.approval} onFocus={show} />}
          {tab === "ideas" && <IdeasTab roomId={room.id} />}
          {tab === "files" && <FilesTab roomId={room.id} />}
        </ScrollView>
      )}
      {settingsOpen && (
        <Sheet title={text.roomSettings} subtitle={title} onClose={() => setSettingsOpen(false)}>
          <RoomSettings
            room={room}
            onChanged={(next) => onOpenRoom?.(next)}
            onSkills={() => {
              setSettingsOpen(false);
              setSkillsOpen(true);
            }}
            onDeleted={() => {
              setSettingsOpen(false);
              onBack();
            }}
          />
        </Sheet>
      )}
      {skillsOpen && (
        <Sheet title={text.skills} subtitle={title} wide onClose={() => setSkillsOpen(false)}>
          <SkillsScreen roomId={room.id} />
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
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                {!home && (
                  <>
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
                  </>
                )}
                {/* 스킬(화면 9)은 팀 방과 결재함에서 들어간다 — 이 방의 스킬만 보인다 */}
                <Button
                  small
                  onPress={() => {
                    setSummary(null);
                    setSkillsOpen(true);
                  }}
                >
                  {text.skills}
                </Button>
              </View>
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}

/**
 * 답변 아래 «누가 답했는지» 한 줄 — 채팅 답변(timeline.answers)과 워커 메시지(payload.answeredBy)가 같은 문장을 쓴다.
 * 기기에서 답했으면 모델 이름을, 기억을 썼으면 «기억에서 찾음 · 날짜» 를, 서버로 넘어간 사유(reason)가 있으면 그것도 붙인다.
 */
const answerLine = (a: AnsweredByView) =>
  [
    a.label,
    a.source === "device" ? a.model : "",
    a.memoryRefs?.[0] ? `${text.fromMemory} · ${dateLabel(a.memoryRefs[0].at)}` : "",
    a.reason ?? "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * 검수 반려가 되풀이돼 팀이 사람에게 올린 건 — [확인 필요] 칩으로 구분한다.
 * [다시 진행] 은 멈춘 목표를 푼다(`POST /goals/:id/unblock`). 이미 풀린 목표면 서버가 409 로 사유를 말하고 그 문장을 그대로 보인다.
 */
function EscalationCard({ message: m }: { message: RoomMessage }) {
  const { api } = useWorkspace();
  const act = useAction();
  const [resumed, setResumed] = useState(false);
  const p = m.payload ?? {};
  const goalId = typeof p.goalId === "string" ? p.goalId : "";
  return (
    <Card style={{ gap: 8, padding: 14, borderColor: colors.warn }}>
      <View style={[s.row, { gap: 8 }]}>
        <Chip tint={colors.warnBg}>{ESCALATION_LABEL}</Chip>
        {typeof p.title === "string" && (
          <Text style={[s.heading, { flex: 1, fontSize: 15 }]}>{p.title}</Text>
        )}
      </View>
      {!!m.text && <Text style={s.text}>{m.text}</Text>}
      {typeof p.summary === "string" && <Text style={s.muted}>{p.summary}</Text>}
      <ErrorNotice error={act.error} />
      {resumed ? (
        <Text style={s.small}>{text.resumed}</Text>
      ) : goalId ? (
        <Button
          small
          style={{ alignSelf: "flex-start" }}
          busy={act.busy}
          onPress={() =>
            void act.run(async () => {
              await api.request(`/api/goals/${goalId}/unblock`, {});
              setResumed(true);
            })
          }
        >
          {GOAL_UNBLOCK_LABEL}
        </Button>
      ) : null}
      <Text style={[s.small, mono]}>{relativeDate(m.createdAt)}</Text>
    </Card>
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
  if (m.kind === "card" && p.card === "escalation") return <EscalationCard message={m} />;
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
          {REPORT_METRIC_KEYS.map((k) => (
            <View key={k} style={{ alignItems: "center", flex: 1 }}>
              {/* 값이 없으면 0 이 아니라 «—» — 아직 재지 않은 것과 0 건은 다르다 */}
              <Text style={[s.heading, mono, { fontSize: 18 }]}>
                {typeof metrics[k] === "number" ? String(metrics[k]) : "—"}
              </Text>
              <Text style={s.small}>{GOAL_METRIC_LABELS[k]}</Text>
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
  const by = p.answeredBy as AnsweredByView | undefined;
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
        {by ? `${answerLine(by)} · ` : ""}
        {relativeDate(m.createdAt)}
      </Text>
    </View>
  );
}
