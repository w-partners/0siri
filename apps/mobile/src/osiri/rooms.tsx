// 0Siri 방 목록(S2)·팀 채팅방(S3)·SSE 스트림 — 0SIRI-SPEC §4.2·§4.3·§5.
// 타입은 서버 정의를 type-import 한다(단일 소스; 런타임 의존 없음. mobile tsc 로 검증됨).
import { fetch as streamFetch } from "expo/fetch";
import { ArrowLeft, ChevronDown, ChevronUp, Pin, PinOff, Users } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, AppState, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { Approval } from "../../../server/src/osiri/approvals.ts";
import type { PresenceState } from "../../../server/src/osiri/events.ts";
import type {
  RoomBoard,
  RoomMessage,
  Room as RoomRecord,
  TaskStage,
  TeamGoal,
} from "../../../server/src/osiri/rooms.ts";
import appJson from "../../app.json";
import { apiBase } from "../api";
import { ChatScreen } from "../chat";
import {
  Button,
  Card,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  IconButton,
  relativeDate,
  Sheet,
  s,
  timeLabel,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar, type Mood, selfAnimated } from "./eve";

export type { PresenceState, RoomBoard, RoomMessage, TaskStage, TeamGoal };
/** GET /rooms 항목 = 서버 Room 레코드 + list() 가 board 에서 얹는 배지. 레코드 정의는 서버가 정본. */
export type Room = RoomRecord & { pendingApprovals: number; progress: number; presence: string };
const asPresence = (v: string): PresenceState =>
  v === "working" || v === "waiting" || v === "done" ? v : "idle";
/** GET /inbox 의 pending 항목 (tokenHash 제외 + roomTitle). */
export type PendingApproval = Omit<Approval, "tokenHash"> & { roomTitle: string };
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
}

const text = {
  emptyTitle: "아직 고용한 팀이 없어요",
  emptyDetail: "스토어에서 팀을 고용하면 여기에 채팅방이 생겨요.",
  goStore: "스토어 가기",
  retry: "다시 시도",
  loadFailed: "불러오지 못했어요",
  pending: (n: number) => `승인 대기 ${n}`,
  progress: (n: number) => `진척 ${n}%`,
  pin: "고정",
  unpin: "고정 해제",
  back: "뒤로",
  personal: "영시리",
  presence: {
    working: "작업 중",
    waiting: "승인 대기 중",
    done: "완료",
    idle: "휴식 중",
  } as Record<string, string>,
  waitingCount: (n: number) => `승인 ${n}건 대기 중`,
  summaryTitle: "팀 상태 요약",
  stage: "현재 흐름 단계",
  pendingList: "대기 중 승인",
  none: "없음",
  today: (n: number) => `오늘 진척: 완료 ${n}건`,
  nextReport: "다음 보고",
  noReport: "예정 없음",
  stages: {
    detect: "감지",
    draft: "초안",
    review: "검수",
    approval: "승인 대기",
    publish: "발행",
  } as Record<string, string>,
  board: "현황판",
  agents: "에이전트",
  done: "완료",
  errors: "오류",
  goals: "목표 진척",
  levels: { long: "장기", mid: "중기", short: "단기" } as Record<string, string>,
  approve: "승인",
  reject: "반려",
  revise: "수정 요청",
  reviseHint: "어떻게 고칠지 적어 주세요",
  send: "보내기",
  evidence: "근거",
  status: {
    approved: "승인됨",
    rejected: "반려됨",
    expired: "만료됨",
    consumed: "처리됨",
  } as Record<string, string>,
  approvalGone: "이 승인은 더 이상 대기 중이 아니에요",
  report: "주간 보고",
  metrics: { completed_tasks: "완료 작업", pending_approvals: "승인 대기", published: "발행" },
  nextWeek: "다음 주 계획",
  digest: "부재 중 진척",
  timeline: "타임라인",
  noMessages: "아직 기록이 없어요. 아래 채팅으로 팀장과 대화해 보세요.",
  teams: "팀 방",
  // 채팅 기분 → 상태줄 (쉼은 presence 문구를 그대로 쓴다)
  mood: { listening: "듣는 중", thinking: "작업 중", speaking: "답하는 중" } as Record<
    string,
    string
  >,
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- SSE ---
export interface StreamHandlers {
  onBoard?: (board: RoomBoard) => void;
  onPresence?: (presence: Presence) => void;
  onApproval?: (event: { approvalId: string; status: string }) => void;
  onMessage?: (event: { messageId: string }) => void;
  onGoal?: (event: { goalId: string }) => void;
}
/**
 * GET /rooms/:id/stream 구독. 서버가 ?token= 을 받지 않아 EventSource 를 못 쓴다 →
 * expo/fetch(웹=global fetch, 네이티브=스트리밍 응답)로 Authorization 헤더를 붙여 직접 파싱한다.
 * 끊기면 1s→30s 지수 백오프로 재접속, 언마운트 시 중단.
 */
export function useRoomStream(roomId: string, handlers: StreamHandlers) {
  const { api } = useWorkspace();
  const latest = useRef(handlers);
  latest.current = handlers;
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
      let payload: unknown;
      try {
        payload = JSON.parse(data.join("\n"));
      } catch {
        return;
      }
      const h = latest.current;
      // biome-ignore lint/suspicious/noExplicitAny: 서버 이벤트 페이로드는 이벤트 이름으로 분기한다
      const p = payload as any;
      if (event === "board") h.onBoard?.(p);
      else if (event === "room.presence") h.onPresence?.({ state: p.state, label: p.label });
      else if (event === "approval") h.onApproval?.(p);
      else if (event === "message") h.onMessage?.(p);
      else if (event === "goal") h.onGoal?.(p);
    };
    const connect = async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          const res = await streamFetch(`${apiBase()}/api/rooms/${roomId}/stream`, {
            headers: { Authorization: `Bearer ${api.token}`, Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          delay = 1000;
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
        } catch {
          // 끊김 → 아래 백오프 후 재접속
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [roomId, api]);
}

// --- S2 방 목록 ---
function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View style={{ gap: 12 }} accessibilityLabel="불러오는 중">
      {["a", "b", "c"].slice(0, rows).map((k) => (
        <View key={k} style={[s.card, { height: 96, backgroundColor: colors.line }]} />
      ))}
    </View>
  );
}
export function RoomList({ onOpen }: { onOpen: (room: Room) => void }) {
  const { api, navigate } = useWorkspace();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setRooms(await api.request<Room[]>("/api/rooms"));
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
    const sub = AppState.addEventListener("change", (st) => st === "active" && void load());
    return () => sub.remove();
  }, [load]);
  const togglePin = async (room: Room) => {
    try {
      await api.request(`/api/rooms/${room.id}/pin`, { pinned: !room.pinned });
      await load(); // 정렬은 서버가 한다(고정 > 승인 대기 > 최근)
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (error && !rooms)
    return (
      <View style={{ gap: 12 }}>
        <ErrorNotice error={`${text.loadFailed}: ${error}`} />
        <Button onPress={() => void load()}>{text.retry}</Button>
      </View>
    );
  if (!rooms) return <Skeleton />;
  const hired = rooms.some((r) => r.packageId !== null);
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={error} />
      {rooms.map((room) => (
        <Pressable
          key={room.id}
          accessibilityRole="button"
          accessibilityLabel={`${room.title} · ${room.pendingApprovals ? text.waitingCount(room.pendingApprovals) : (text.presence[room.presence] ?? room.presence)}`}
          onPress={() => onOpen(room)}
          onLongPress={() => void togglePin(room)}
          style={({ pressed }) => [s.card, { gap: 10 }, pressed && { opacity: 0.85 }]}
        >
          <View style={[s.row, { gap: 14 }]}>
            <CharacterAvatar character={room.character} size={46} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.heading} numberOfLines={1}>
                {room.packageId === null ? text.personal : room.title}
              </Text>
              <Text style={s.muted} numberOfLines={1}>
                {room.lastReport ?? text.presence[room.presence] ?? room.presence}
              </Text>
            </View>
            <IconButton
              icon={room.pinned ? PinOff : Pin}
              label={room.pinned ? text.unpin : text.pin}
              onPress={() => void togglePin(room)}
            />
          </View>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {room.pendingApprovals > 0 && (
              <Chip tint={colors.orange}>{text.pending(room.pendingApprovals)}</Chip>
            )}
            <Chip tint={colors.green}>{text.progress(room.progress)}</Chip>
            <Text style={s.small}>{relativeDate(room.lastActivityAt)}</Text>
          </View>
        </Pressable>
      ))}
      {!hired && (
        <Card>
          <Empty icon={Users} title={text.emptyTitle} detail={text.emptyDetail}>
            <Button primary onPress={() => navigate("store")}>
              {text.goStore}
            </Button>
          </Empty>
        </Card>
      )}
    </View>
  );
}

// --- 현황판 위젯 (고정 + 인라인 공용) ---
function Bar({ value }: { value: number }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" }}>
      <View
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          height: 6,
          backgroundColor: colors.blueDark,
        }}
      />
    </View>
  );
}
// 결정: 흐름은 스펙 §4.3 의 5단계만 보인다(geo·done 은 서버 flow 에 있지만 화면 단계가 아니다).
const FLOW: TaskStage[] = ["detect", "draft", "review", "approval", "publish"];
export function BoardWidget({ board }: { board: RoomBoard }) {
  return (
    <Card style={{ gap: 12, padding: 16 }}>
      <Text style={s.label}>{text.board}</Text>
      <View style={[s.between, { gap: 4 }]}>
        {FLOW.map((stage) => (
          <View key={stage} style={{ alignItems: "center", flex: 1 }}>
            <Text style={[s.heading, { fontSize: 18 }]}>{board.flow[stage] ?? 0}</Text>
            <Text style={s.small}>{text.stages[stage]}</Text>
          </View>
        ))}
      </View>
      {board.agents.length > 0 && (
        <View style={{ gap: 2 }}>
          <Text style={s.label}>{text.agents}</Text>
          {board.agents.map((a) => (
            <Text key={a.actor} style={s.muted}>
              {a.actor} · {text.done} {a.done} · {text.errors} {a.errors}
            </Text>
          ))}
        </View>
      )}
      <View style={{ gap: 6 }}>
        <Text style={s.label}>{text.goals}</Text>
        {board.goals.map((g) => (
          <View key={g.level} style={[s.row, { gap: 10 }]}>
            <Text style={[s.small, { width: 28 }]}>{text.levels[g.level]}</Text>
            <View style={{ flex: 1 }}>
              <Bar value={g.progress} />
            </View>
            <Text style={[s.small, { width: 36, textAlign: "right" }]}>{g.progress}%</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

// --- 승인 카드 ---
type Decision = "approve" | "reject";
/** 승인 결정. frozenHash 는 결재함(/inbox)의 inputHash 로 동결한다 — 카드 payload 에는 해시가 없다. */
export async function decideApproval(
  api: { request<T>(path: string, body?: unknown, method?: string): Promise<T> },
  approvalId: string,
  decision: Decision,
  frozenHash: string | undefined,
  reason?: string,
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
    reason,
  });
}
/** 승인 카드. 누가·어떤 해시로 결정하는지는 onDecide 를 만든 쪽이 닫아 둔다. */
export function ApprovalCard({
  title,
  summary,
  evidence,
  status,
  onDecide,
}: {
  title: string;
  summary: string;
  evidence?: string;
  status: string;
  onDecide: (decision: Decision, reason?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [revising, setRevising] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState("");
  const decide = async (decision: Decision, why?: string) => {
    setBusy(decision);
    setError("");
    try {
      await onDecide(decision, why);
      setRevising(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card style={{ gap: 10, padding: 16, borderWidth: 1, borderColor: colors.orange }}>
      <View style={[s.between, { gap: 8 }]}>
        <Text style={[s.heading, { flex: 1 }]}>{title}</Text>
        <Chip tint={status === "pending" ? colors.orange : colors.green}>
          {status === "pending" ? text.presence.waiting : (text.status[status] ?? status)}
        </Chip>
      </View>
      <Text style={s.text}>{summary}</Text>
      {evidence ? (
        <View style={{ gap: 6 }}>
          <Pressable
            accessibilityRole="button"
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
      {status === "pending" && (
        <View style={{ gap: 8 }}>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button small primary busy={busy === "approve"} onPress={() => void decide("approve")}>
              {text.approve}
            </Button>
            <Button small danger busy={busy === "reject"} onPress={() => void decide("reject")}>
              {text.reject}
            </Button>
            <Button small onPress={() => setRevising((v) => !v)}>
              {text.revise}
            </Button>
          </View>
          {revising && (
            <View style={{ gap: 8 }}>
              <TextInput
                style={s.input}
                placeholder={text.reviseHint}
                placeholderTextColor={colors.muted}
                value={reason}
                onChangeText={setReason}
                accessibilityLabel={text.revise}
              />
              <Button
                small
                disabled={!reason.trim()}
                busy={busy === "reject"}
                onPress={() => void decide("reject", `${text.revise}: ${reason.trim()}`)}
              >
                {text.send}
              </Button>
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

// --- 캐릭터 (§5) ---
function Character({
  room,
  presence,
  pending,
  mood,
  onPress,
}: {
  room: Room;
  presence: Presence;
  pending: number;
  mood: Mood;
  onPress: () => void;
}) {
  const label = `${room.title} · ${pending > 0 ? text.waitingCount(pending) : presence.label}`;
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    anim.setValue(0);
    const seq = (ms: number) =>
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: ms, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: ms, useNativeDriver: true }),
      ]);
    // done 은 한 번 튀고 멈춘다 — 서버가 4초 뒤 idle 을 보내면 호흡으로 넘어간다
    const loop =
      presence.state === "done"
        ? seq(180)
        : Animated.loop(seq(presence.state === "working" ? 160 : 1400));
    loop.start();
    return () => loop.stop();
  }, [anim, presence.state]);
  const transform =
    presence.state === "working"
      ? [{ rotate: anim.interpolate({ inputRange: [0, 1], outputRange: ["-4deg", "4deg"] }) }]
      : presence.state === "done"
        ? [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) }]
        : [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }];
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ alignItems: "center" }}
    >
      <Animated.View style={own ? undefined : { transform }}>
        <CharacterAvatar character={room.character} size={own ? 132 : 88} mood={ownMood} />
      </Animated.View>
      {presence.state === "waiting" && (
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            right: "32%",
            minWidth: 22,
            height: 22,
            borderRadius: 11,
            paddingHorizontal: 6,
            backgroundColor: colors.danger,
            alignItems: "center",
            justifyContent: "center",
            opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }),
          }}
        >
          <Text style={{ color: "#FFF", fontSize: 12, fontWeight: "700" }}>{pending || "!"}</Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

// --- S3 팀 채팅방 ---
export function RoomScreen({
  room,
  onBack,
  home = false,
  onOpenRoom,
}: {
  room: Room;
  onBack: () => void;
  /** 기본 채팅(홈): 뒤로 대신 팀 방 목록 버튼, 버전 표시 — Muse 처럼 앱을 열면 바로 영시리와 대화 */
  home?: boolean;
  onOpenRoom?: (room: Room) => void;
}) {
  const { api } = useWorkspace();
  const [mood, setMood] = useState<Mood>("idle");
  const [teams, setTeams] = useState(false);
  const [messages, setMessages] = useState<RoomMessage[] | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [board, setBoard] = useState<RoomBoard | null>(null);
  const [error, setError] = useState("");
  const [presence, setPresence] = useState<Presence>({
    state: asPresence(room.presence),
    label: text.presence[room.presence] ?? room.presence,
  });
  const [summary, setSummary] = useState<Summary | null | "loading" | "error">(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(0);

  const load = useCallback(async () => {
    setError("");
    try {
      const t = await api.request<{
        digest: string | null;
        messages: RoomMessage[];
        board: RoomBoard;
      }>(`/api/rooms/${room.id}/timeline`);
      setDigest(t.digest);
      setMessages(t.messages);
      setBoard(t.board);
      lastSeq.current = t.messages.at(-1)?.seq ?? 0;
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, room.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const refetchBoard = useCallback(async () => {
    try {
      setBoard(await api.request<RoomBoard>(`/api/rooms/${room.id}/board`));
    } catch {
      // 현황판은 SSE board 이벤트로도 온다 — 조용히 넘기지 않고 다음 이벤트에 맡긴다
    }
  }, [api, room.id]);
  // 결정: 캐릭터 상태는 room.presence 이벤트 한 곳에서만 바뀐다(§5). 30초 무이벤트 → 휴식은
  // working/done 에만 적용한다 — waiting 은 승인이 남아 있는 한 서버가 유지하는 상태다.
  const onPresence = useCallback((p: Presence) => {
    setPresence(p);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (p.state === "working" || p.state === "done")
      idleTimer.current = setTimeout(
        () => setPresence({ state: "idle", label: text.presence.idle }),
        30_000,
      );
  }, []);
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );
  useRoomStream(room.id, {
    onBoard: setBoard,
    onPresence,
    onApproval: ({ approvalId, status }) =>
      setMessages((list) =>
        list
          ? list.map((m) =>
              m.kind === "card" && m.payload?.approvalId === approvalId
                ? { ...m, payload: { ...m.payload, status } }
                : m,
            )
          : list,
      ),
    onMessage: async () => {
      try {
        const t = await api.request<{ messages: RoomMessage[] }>(
          `/api/rooms/${room.id}/timeline?after=${lastSeq.current}`,
        );
        if (!t.messages.length) return;
        lastSeq.current = t.messages.at(-1)?.seq ?? lastSeq.current;
        setMessages((list) => [...(list ?? []), ...t.messages]);
      } catch {
        // 다음 message 이벤트에서 after= 로 다시 따라잡는다
      }
    },
  });
  const openSummary = async () => {
    setSummary("loading");
    try {
      setSummary(await api.request<Summary>(`/api/rooms/${room.id}/summary`));
    } catch {
      setSummary("error");
    }
  };
  const pending = board?.pendingApprovals ?? room.pendingApprovals;
  const title = room.packageId === null ? text.personal : room.title;
  const statusLine = pending > 0 ? text.waitingCount(pending) : (text.mood[mood] ?? presence.label);
  // 홈은 채팅이 주인공 — 타임라인은 쌓인 게 있을 때만
  const showTimeline = !home || !!digest || !!messages?.length || !!error;

  return (
    <View style={{ flex: 1 }}>
      <View
        style={[s.row, { paddingHorizontal: 8, paddingTop: 4, justifyContent: "space-between" }]}
      >
        {home ? <View /> : <IconButton icon={ArrowLeft} label={text.back} onPress={onBack} />}
        {home && <IconButton icon={Users} label={text.teams} onPress={() => setTeams(true)} />}
      </View>
      <View style={{ alignItems: "center", gap: 4, paddingBottom: 8 }}>
        <Character
          room={{ ...room, title }}
          presence={presence}
          pending={pending}
          mood={mood}
          onPress={() => void openSummary()}
        />
        <Text style={s.title}>{title}</Text>
        <Text style={s.muted}>{statusLine}</Text>
        {/* 버전 표시는 여기 한 곳만 (app.json 이 정본) */}
        {home && <Text style={s.small}>0Siri v{appJson.expo.version}</Text>}
      </View>
      {board && !home && (
        <View style={{ paddingHorizontal: 16 }}>
          <BoardWidget board={board} />
        </View>
      )}
      {showTimeline && (
        <ScrollView
          style={{ flex: 1, minHeight: 120 }}
          contentContainerStyle={{ padding: 16, gap: 10 }}
        >
          {error ? (
            <View style={{ gap: 8 }}>
              <ErrorNotice error={`${text.loadFailed}: ${error}`} />
              <Button onPress={() => void load()}>{text.retry}</Button>
            </View>
          ) : !messages ? (
            <Skeleton rows={2} />
          ) : (
            <>
              {digest && (
                <Card style={{ padding: 14, backgroundColor: colors.lavender }}>
                  <Text style={s.label}>{text.digest}</Text>
                  <Text style={s.text}>{digest}</Text>
                </Card>
              )}
              {messages.length === 0 && !digest && <Text style={s.muted}>{text.noMessages}</Text>}
              {messages.map((m) => (
                <Message
                  key={m.id}
                  message={m}
                  onDecide={async (decision, reason) => {
                    const approvalId = String(m.payload?.approvalId ?? "");
                    const result = await decideApproval(
                      api,
                      approvalId,
                      decision,
                      undefined,
                      reason,
                    );
                    setMessages((list) =>
                      list
                        ? list.map((x) =>
                            x.id === m.id
                              ? { ...x, payload: { ...x.payload, status: result.status } }
                              : x,
                          )
                        : list,
                    );
                    await refetchBoard();
                  }}
                />
              ))}
            </>
          )}
        </ScrollView>
      )}
      <View
        style={{
          flex: showTimeline ? 1.2 : 1,
          borderTopWidth: showTimeline ? 1 : 0,
          borderTopColor: colors.line,
        }}
      >
        <ChatScreen roomId={room.id} active onMood={setMood} />
      </View>
      {teams && (
        <Sheet title={text.teams} onClose={() => setTeams(false)}>
          <RoomList
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
          ) : summary === "error" ? (
            <View style={{ gap: 8 }}>
              <ErrorNotice error={text.loadFailed} />
              <Button onPress={() => void openSummary()}>{text.retry}</Button>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <Text style={s.heading}>{summary.label}</Text>
              <View style={{ gap: 4 }}>
                <Text style={s.label}>{text.stage}</Text>
                <Text style={s.text}>
                  {FLOW.map((st) => `${text.stages[st]} ${summary.flow[st] ?? 0}`).join(" · ")}
                </Text>
              </View>
              <View style={{ gap: 4 }}>
                <Text style={s.label}>{text.pendingList}</Text>
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
              <Text style={s.text}>
                {text.today(summary.doneToday)} · {text.progress(summary.progress)}
              </Text>
              <Text style={s.muted}>
                {text.nextReport}:{" "}
                {summary.nextReportAt ? timeLabel(summary.nextReportAt) : text.noReport}
              </Text>
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
}: {
  message: RoomMessage;
  onDecide: (decision: Decision, reason?: string) => Promise<void>;
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
    return (
      <BoardWidget
        board={{
          roomId: m.roomId,
          flow: p.flow as RoomBoard["flow"],
          pendingApprovals: Number(p.pendingApprovals ?? 0),
          agents: Array.isArray(p.agents) ? (p.agents as RoomBoard["agents"]) : [],
          goals: Array.isArray(p.goals) ? (p.goals as RoomBoard["goals"]) : [],
          progress: Number(p.progress ?? 0),
          presence: String(p.presence ?? "idle"),
        }}
      />
    );
  if (m.kind === "report") {
    const metrics = (p.metrics ?? {}) as Record<string, unknown>;
    const plan = Array.isArray(metrics.next_week_plan) ? (metrics.next_week_plan as string[]) : [];
    return (
      <Card style={{ gap: 10, padding: 16, backgroundColor: colors.sky }}>
        <Text style={s.label}>{text.report}</Text>
        {m.text ? <Text style={s.text}>{m.text}</Text> : null}
        <View style={[s.between, { gap: 6 }]}>
          {(Object.keys(text.metrics) as (keyof typeof text.metrics)[]).map((k) => (
            <View key={k} style={{ alignItems: "center", flex: 1 }}>
              <Text style={[s.heading, { fontSize: 18 }]}>{String(metrics[k] ?? 0)}</Text>
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
      </Card>
    );
  }
  if (m.kind === "digest")
    return (
      <Card style={{ padding: 14, backgroundColor: colors.lavender }}>
        <Text style={s.label}>{text.digest}</Text>
        <Text style={s.text}>{m.text}</Text>
      </Card>
    );
  const mine = m.role === "user";
  return (
    <View
      style={{
        alignSelf: mine ? "flex-end" : "flex-start",
        maxWidth: "85%",
        backgroundColor: mine ? colors.blue : m.role === "system" ? "transparent" : colors.card,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingVertical: 8,
      }}
    >
      <Text style={m.role === "system" ? s.small : s.text}>{m.text}</Text>
      <Text style={[s.small, { marginTop: 2 }]}>{relativeDate(m.createdAt)}</Text>
    </View>
  );
}
