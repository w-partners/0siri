// 0Siri 목표(화면 5) — 장기→중기→단기 트리·진척·지표, 팀 제안 반영/보류, 장기 목표 승인, 단기 순서 변경(0SIRI-SPEC §4.5).
// roomId 를 주면 그 방의 «목표» 탭이다: 방 고르기가 없다.
import { ArrowDown, ArrowUp, Store, Target } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import {
  GOAL_METRIC_KEYS,
  type GoalMetricKey,
  METRIC_PERIODS,
  type MetricPeriod,
  type ProposalDecision,
  STAGE_LABELS,
} from "../../../../packages/domain/src/osiri";
import type {
  GoalMetrics,
  GoalProposal,
  RoomCard,
  TaskStage,
  TeamGoal,
} from "../../../server/src/osiri/rooms.ts";
import {
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  fonts,
  relativeDate,
  Sheet,
  Skeleton,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar } from "./eve";
import { Choice, useAction, useLoad } from "./store";

// rooms.tsx 가 제안 카드 타입을 여기서 가져간다 — 정의는 서버 rooms.ts 하나다.
export type { GoalProposal };

const text = {
  retry: "재시도",
  noRooms: "팀이 없어요",
  noRoomsDetail: "스토어에서 팀을 고용하면 목표가 생겨요.",
  goStore: "스토어 가기",
  roomMissing: "이 방을 찾지 못했어요",
  emptyTitle: "대화로 목표를 말해보세요",
  emptyDetail: "팀장에게 이루고 싶은 것을 한 줄로 말하면 장기 목표 초안이 여기에 올라와요.",
  examples: ["상속 분야에서 AI 답변에 먼저 인용되고 싶어", "이번 달 글 8건을 발행하고 싶어"],
  goChat: "대화하러 가기",
  levels: { long: "장기", mid: "중기", short: "단기", task: "작업" } satisfies Record<
    TeamGoal["level"],
    string
  >,
  status: {
    proposed: "제안",
    active: "진행",
    completed: "달성",
    paused: "일시정지",
    blocked: "막힘",
  } satisfies Record<TeamGoal["status"], string>,
  started: "시작",
  activate: "승인",
  activateHint: "장기 목표는 승인해야 시작돼요.",
  achievedHint: "달성했어요. 팀이 후속 목표 초안을 제안해요.",
  next: "다음 행동",
  up: "위로",
  down: "아래로",
  openLinked: "연결된 승인·발행 건 보기",
  stalled: "멈춘 팀",
  stalledDetail: "약속한 보고 주기를 넘겼어요. 방에서 팀 상태를 확인해 주세요.",
  openRoom: "방 열기",
  metricsHeading: "지표",
  period: { week: "주", month: "월", quarter: "분기" } satisfies Record<MetricPeriod, string>,
  metrics: {
    published: "발행",
    indexed: "색인",
    ai_citations: "인용",
    conversions: "전환",
  } satisfies Record<GoalMetricKey, string>,
  // 지표 칩을 누르면 보이는 측정 방법
  how: {
    published: "승인을 거쳐 실제로 발행된 글의 수예요. 발행 기록(감사 로그)에서 셉니다.",
    indexed:
      "발행한 글 가운데 검색엔진이 색인한 글의 수예요. 발행 뒤 색인 여부를 주기적으로 확인합니다.",
    ai_citations:
      "AI 답변이 우리 글을 출처로 든 횟수예요. 같은 질문을 주기적으로 다시 물어 인용 점유를 잽니다(동일 질문 재질문 방식).",
    conversions: "글을 보고 상담·문의로 이어진 건수예요. 유입 경로가 확인된 건만 셉니다.",
  } satisfies Record<GoalMetricKey, string>,
  howTitle: (label: string) => `${label} — 측정 방법`,
  collecting: "수집 중",
  notMeasured: "아직 측정 전이에요",
  measured: "측정",
  metricsFailed: "지표를 불러오지 못했어요",
  lastMeasured: "마지막 측정값",
  lastReported: "마지막 보고값",
  proposalsHeading: "팀 제안",
  noProposals: "팀이 낸 제안이 아직 없어요. 팀이 주간 보고에서 다음 목표를 제안해요.",
  accept: "목표에 반영",
  hold: "보류",
  proposalStatus: { pending: "대기", accepted: "반영됨", held: "보류됨" } satisfies Record<
    GoalProposal["status"],
    string
  >,
  tasksHeading: "작업 목록",
  count: (n: number) => `${n}건`,
  noTasks: "진행 중인 작업이 없어요.",
};

const statusTint: Record<TeamGoal["status"], string> = {
  proposed: colors.warnBg,
  active: colors.accentSoft,
  completed: colors.okBg,
  paused: colors.sunk,
  blocked: colors.missBg,
};
const mono = { fontFamily: fonts.mono };
/** 작업의 흐름 단계 이름. 화면에 내지 않는 내부 단계(geo·done)는 이름이 없다. */
const stageLabel = (stage?: TaskStage) =>
  stage ? (STAGE_LABELS as Partial<Record<TaskStage, string>>)[stage] : undefined;

/** 목록 단위 에러: 사유 문장 + 재시도. 화면 4·5·9·10 이 같이 쓴다. */
export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <View style={{ gap: 4, alignItems: "flex-start" }}>
      <ErrorNotice error={error} />
      <Button small onPress={onRetry}>
        {text.retry}
      </Button>
    </View>
  );
}

/** 진척바. 값은 0~100. 화면 10 의 카나리 진행도 이걸 쓴다. */
export function Meter({ value, tone = colors.accent }: { value: number; tone?: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: value }}
      style={{ height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" }}
    >
      <View
        style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: 6, backgroundColor: tone }}
      />
    </View>
  );
}
const meterTone = (status: TeamGoal["status"]) =>
  status === "completed" ? colors.ok : status === "blocked" ? colors.miss : colors.accent;

export function TeamGoalsScreen({
  roomId,
  onOpenRoom,
}: {
  roomId?: string;
  onOpenRoom?: (roomId: string) => void;
}) {
  const { api, navigate } = useWorkspace();
  const rooms = useLoad(() => api.request<RoomCard[]>("/api/rooms"));
  const [picked, setPicked] = useState("");

  if (!rooms.data)
    return rooms.error ? (
      <LoadError error={rooms.error} onRetry={rooms.retry} />
    ) : (
      <Skeleton rows={2} height={120} />
    );
  if (rooms.data.length === 0)
    return (
      <Card>
        <Empty icon={Store} title={text.noRooms} detail={text.noRoomsDetail}>
          <Button small onPress={() => navigate("store")}>
            {text.goStore}
          </Button>
        </Empty>
      </Card>
    );
  const room =
    rooms.data.find((r) => r.id === (roomId ?? picked)) ?? (roomId ? undefined : rooms.data[0]);
  return (
    <View style={{ gap: 16 }}>
      {roomId ? null : (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {rooms.data.map((r) => (
            <Choice
              key={r.id}
              label={r.title}
              selected={r.id === room?.id}
              onPress={() => setPicked(r.id)}
            />
          ))}
        </View>
      )}
      {rooms.error ? <LoadError error={rooms.error} onRetry={rooms.retry} /> : null}
      {room ? (
        <TeamGoals key={room.id} room={room} onOpenRoom={onOpenRoom} />
      ) : (
        <LoadError error={text.roomMissing} onRetry={rooms.retry} />
      )}
    </View>
  );
}

function TeamGoals({
  room,
  onOpenRoom,
}: {
  room: RoomCard;
  onOpenRoom?: (roomId: string) => void;
}) {
  const { api, navigate } = useWorkspace();
  const { width } = useWindowDimensions();
  const goals = useLoad(() => api.request<TeamGoal[]>(`/api/goals?room_id=${room.id}`), room.id);
  const proposals = useLoad(
    () => api.request<GoalProposal[]>(`/api/goals/proposals?room_id=${room.id}`),
    room.id,
  );
  const act = useAction();

  // 서버가 준 순서(order → 생성순)를 그대로 쓴다. 순서를 바꾸면 다시 읽는다.
  const list = goals.data;
  const childrenOf = (parentId: string | null) =>
    (list ?? []).filter((g) => g.parentId === parentId && g.level !== "task");
  // 단기 목표 순서: 이웃과 order 를 맞바꾼다(두 건 PATCH). 서버가 방 타임라인에 알림을 남긴다.
  const move = (goal: TeamGoal, other: TeamGoal) =>
    act.run(async () => {
      await api.request(`/api/goals/${goal.id}/order`, { order: other.order }, "PATCH");
      await api.request(`/api/goals/${other.id}/order`, { order: goal.order }, "PATCH");
      goals.retry();
    });
  const activate = (goal: TeamGoal) =>
    act.run(async () => {
      await api.request(`/api/goals/${goal.id}/activate`, {});
      goals.retry(); // 상태 칩은 서버가 돌려준 목록으로만 바뀐다
    });

  const row = (goal: TeamGoal, depth: number) => {
    const siblings = goal.level === "short" ? childrenOf(goal.parentId) : [];
    const idx = siblings.indexOf(goal);
    const openable = goal.level === "short" && onOpenRoom;
    const main = (
      <View style={{ gap: 6 }}>
        <View style={[s.row, { gap: 8 }]}>
          <Chip>{text.levels[goal.level]}</Chip>
          <Text style={[s.text, { flex: 1 }]} numberOfLines={2}>
            {goal.title}
          </Text>
          {goal.status === "active" ? null : (
            <Chip tint={statusTint[goal.status]}>{text.status[goal.status]}</Chip>
          )}
          <Text style={[s.small, mono, { width: 40, textAlign: "right" }]}>{goal.progress}%</Text>
        </View>
        <Meter value={goal.progress} tone={meterTone(goal.status)} />
        {goal.nextActions?.[0] ? (
          <Text style={s.small}>
            {text.next}: {goal.nextActions[0]}
          </Text>
        ) : null}
      </View>
    );
    return (
      <View key={goal.id} style={{ gap: 10, marginLeft: depth * 14 }}>
        <View style={[s.row, { gap: 8 }]}>
          {openable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${goal.title} — ${text.openLinked}`}
              onPress={() => openable(room.id)}
              style={{ flex: 1 }}
            >
              {main}
            </Pressable>
          ) : (
            <View style={{ flex: 1 }}>{main}</View>
          )}
          {siblings.length > 1 ? (
            <Reorder
              index={idx}
              count={siblings.length}
              disabled={act.busy}
              onMove={(dir) => void move(goal, siblings[idx + dir] as TeamGoal)}
            />
          ) : null}
        </View>
        {childrenOf(goal.id).map((k) => row(k, depth + 1))}
      </View>
    );
  };

  const roots = childrenOf(null);
  const tasks = (list ?? []).filter((g) => g.level === "task");
  const wide = width >= 900;

  const tree = !list ? (
    goals.error ? (
      <LoadError error={goals.error} onRetry={goals.retry} />
    ) : (
      <Skeleton rows={3} height={48} />
    )
  ) : roots.length === 0 ? (
    <Card>
      <Empty icon={Target} title={text.emptyTitle} detail={text.emptyDetail}>
        <View style={{ gap: 6, alignItems: "center" }}>
          {text.examples.map((e) => (
            <Chip key={e}>{`“${e}”`}</Chip>
          ))}
        </View>
        <Button primary onPress={() => navigate("chat")}>
          {text.goChat}
        </Button>
      </Empty>
    </Card>
  ) : (
    roots.map((goal) => {
      const done = goal.status === "completed";
      return (
        <Card key={goal.id} style={{ gap: 12, borderColor: done ? colors.ok : colors.line }}>
          <View style={[s.row, { gap: 12, alignItems: "flex-start" }]}>
            <View style={{ flex: 1, gap: 6 }}>
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Chip tint={colors.sunk}>{text.levels[goal.level]}</Chip>
                <Text style={[s.small, mono]}>
                  {text.started} {dateLabel(goal.createdAt)}
                </Text>
              </View>
              <Text style={[s.heading, { fontFamily: fonts.display }]}>{goal.title}</Text>
            </View>
            {/* 팀장 미니 아바타 — 목표를 달성했을 때만 완료 표정 */}
            <CharacterAvatar character={room.character} size={36} mood={done ? "happy" : "idle"} />
          </View>
          <StatusTrack status={goal.status} />
          <View style={[s.row, { gap: 10 }]}>
            <View style={{ flex: 1 }}>
              <Meter value={goal.progress} tone={meterTone(goal.status)} />
            </View>
            <Text style={[s.text, mono]}>{goal.progress}%</Text>
          </View>
          {goal.metrics ? (
            <Text style={[s.small, mono]}>
              {(["published", "indexed", "ai_citations"] as const)
                .filter((k) => goal.metrics?.[k] !== undefined)
                .map((k) => `${text.metrics[k]} ${goal.metrics?.[k]}`)
                .join(" / ")}
            </Text>
          ) : null}
          {goal.status === "proposed" ? (
            <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
              <Button small primary busy={act.busy} onPress={() => void activate(goal)}>
                {text.activate}
              </Button>
              <Text style={[s.small, { flex: 1 }]}>{text.activateHint}</Text>
            </View>
          ) : null}
          {done ? <Text style={s.small}>{text.achievedHint}</Text> : null}
          {goal.nextActions?.[0] ? (
            <Text style={s.small}>
              {text.next}: {goal.nextActions[0]}
            </Text>
          ) : null}
          {childrenOf(goal.id).map((k) => row(k, 0))}
        </Card>
      );
    })
  );

  const side = (
    <>
      {roots
        .filter((g) => g.level === "long")
        .map((g) => (
          <MetricsCard key={g.id} goal={g} />
        ))}

      <Text style={s.heading}>{text.proposalsHeading}</Text>
      {!proposals.data ? (
        proposals.error ? (
          <LoadError error={proposals.error} onRetry={proposals.retry} />
        ) : (
          <Skeleton rows={1} height={88} />
        )
      ) : proposals.data.length === 0 ? (
        <Text style={s.muted}>{text.noProposals}</Text>
      ) : (
        proposals.data.map((p) => (
          <ProposalCard
            key={p.id}
            proposal={p}
            onDecided={() => {
              proposals.retry();
              goals.retry(); // 반영하면 다음 중기 목표로 들어온다
            }}
          />
        ))
      )}

      {list ? (
        <>
          <View style={[s.row, { gap: 6 }]}>
            <Text style={s.heading}>{text.tasksHeading}</Text>
            <Text style={[s.heading, mono]}>{text.count(tasks.length)}</Text>
          </View>
          {tasks.length === 0 ? (
            <Text style={s.muted}>{text.noTasks}</Text>
          ) : (
            <Card style={{ paddingVertical: 4 }}>
              {tasks.map((t, i) => (
                <View
                  key={t.id}
                  style={{
                    gap: 4,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: colors.line,
                  }}
                >
                  <View style={[s.row, { gap: 8 }]}>
                    <Text style={[s.text, { flex: 1 }]} numberOfLines={2}>
                      {t.title}
                    </Text>
                    {stageLabel(t.stage) ? <Chip>{stageLabel(t.stage)}</Chip> : null}
                    <Chip tint={statusTint[t.status]}>{text.status[t.status]}</Chip>
                    <Text style={[s.small, mono, { width: 40, textAlign: "right" }]}>
                      {t.progress}%
                    </Text>
                  </View>
                  {t.assignee || t.nextActions?.[0] ? (
                    <Text style={s.small}>
                      {[t.assignee, t.nextActions?.[0]].filter(Boolean).join(" · ")}
                    </Text>
                  ) : null}
                </View>
              ))}
            </Card>
          )}
        </>
      ) : null}
    </>
  );

  return (
    <View style={{ gap: 16 }}>
      {room.stalled ? (
        <Card
          style={{
            gap: 8,
            padding: 14,
            borderColor: colors.warn,
            backgroundColor: colors.warnBg,
            alignItems: "flex-start",
          }}
        >
          <Chip tint={colors.card}>{text.stalled}</Chip>
          <Text style={s.text}>{text.stalledDetail}</Text>
          {onOpenRoom ? (
            <Button small onPress={() => onOpenRoom(room.id)}>
              {text.openRoom}
            </Button>
          ) : null}
        </Card>
      ) : null}
      <ErrorNotice error={act.error} />
      {list && goals.error ? <LoadError error={goals.error} onRetry={goals.retry} /> : null}
      {wide ? (
        <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
          <View style={{ flex: 1, gap: 16 }}>{tree}</View>
          <View style={{ flex: 1, gap: 14 }}>{side}</View>
        </View>
      ) : (
        <View style={{ gap: 14 }}>
          {tree}
          {side}
        </View>
      )}
    </View>
  );
}

/** 목표 상태: proposed → active → achieved. 일시정지·막힘은 따로 칩으로 붙는다. */
function StatusTrack({ status }: { status: TeamGoal["status"] }) {
  const steps = ["proposed", "active", "completed"] as const;
  const off = status === "paused" || status === "blocked";
  return (
    <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
      {steps.map((step, i) => (
        <View key={step} style={[s.row, { gap: 6 }]}>
          {i > 0 ? <Text style={s.small}>→</Text> : null}
          <Chip tint={step === status || (off && step === "active") ? statusTint[step] : undefined}>
            {text.status[step]}
          </Chip>
        </View>
      ))}
      {off ? <Chip tint={statusTint[status]}>{text.status[status]}</Chip> : null}
    </View>
  );
}

/** 단기 목표 순서 — 위·아래를 한 알약에 묶은 컨트롤. */
function Reorder({
  index,
  count,
  disabled,
  onMove,
}: {
  index: number;
  count: number;
  disabled: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const arrow = (dir: -1 | 1) => {
    const Icon = dir < 0 ? ArrowUp : ArrowDown;
    const edge = dir < 0 ? index === 0 : index === count - 1;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dir < 0 ? text.up : text.down}
        disabled={disabled || edge}
        onPress={() => onMove(dir)}
        hitSlop={6}
        style={{ padding: 6, opacity: disabled || edge ? 0.3 : 1 }}
      >
        <Icon size={14} color={colors.text} />
      </Pressable>
    );
  };
  return (
    <View style={[s.row, { borderWidth: 1, borderColor: colors.line, borderRadius: 16 }]}>
      {arrow(-1)}
      <Text style={[s.small, mono]}>
        {index + 1}/{count}
      </Text>
      {arrow(1)}
    </View>
  );
}

/** 장기 목표의 지표 칩 + 기간 전환. 조회에 실패하면 마지막 측정값과 그 시각을 보인다. */
function MetricsCard({ goal }: { goal: TeamGoal }) {
  const { api } = useWorkspace();
  const [period, setPeriod] = useState<MetricPeriod>("month");
  const [explain, setExplain] = useState<GoalMetricKey | null>(null);
  const load = useLoad(
    () => api.request<GoalMetrics>(`/api/goals/${goal.id}/metrics?period=${period}`),
    `${goal.id}|${period}`,
  );
  // 실패했을 때 보일 값: 마지막으로 성공한 조회(useLoad 가 남겨 둔다), 그것도 없으면 팀이 목표에 보고한 값.
  const reported: Record<GoalMetricKey, number | null> = {
    published: goal.metrics?.published ?? null,
    indexed: goal.metrics?.indexed ?? null,
    ai_citations: goal.metrics?.ai_citations ?? null,
    conversions: null,
  };
  const values = load.data?.metrics ?? (load.error ? reported : undefined);
  return (
    <Card style={{ gap: 12 }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={s.heading}>{text.metricsHeading}</Text>
        <View style={[s.row, { gap: 6 }]}>
          {METRIC_PERIODS.map((p) => (
            <Choice
              key={p}
              label={text.period[p]}
              selected={p === period}
              onPress={() => setPeriod(p)}
            />
          ))}
        </View>
      </View>
      <Text style={s.small} numberOfLines={1}>
        {goal.title}
      </Text>
      {load.loading || !values ? (
        <Skeleton rows={1} height={28} />
      ) : (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {GOAL_METRIC_KEYS.map((k) => {
            const v = values[k];
            return (
              <Pressable
                key={k}
                accessibilityRole="button"
                accessibilityLabel={text.howTitle(text.metrics[k])}
                onPress={() => setExplain(k)}
              >
                <Chip tint={v === null ? undefined : colors.okBg}>
                  {text.metrics[k]} {v === null ? text.collecting : v}
                </Chip>
              </Pressable>
            );
          })}
        </View>
      )}
      {load.loading ? null : load.error ? (
        <View style={{ gap: 6, alignItems: "flex-start" }}>
          <Text style={[s.small, { color: colors.miss }]}>
            {text.metricsFailed}: {load.error}
          </Text>
          <Text style={[s.small, mono]}>
            {load.data
              ? `${text.lastMeasured} · ${text.period[load.data.period]} · ${
                  load.data.measuredAt ? relativeDate(load.data.measuredAt) : text.notMeasured
                }`
              : `${text.lastReported} · ${relativeDate(goal.updatedAt)}`}
          </Text>
          <Button small onPress={load.retry}>
            {text.retry}
          </Button>
        </View>
      ) : load.data ? (
        <Text style={[s.small, mono]}>
          {load.data.measuredAt
            ? `${text.measured} ${relativeDate(load.data.measuredAt)}`
            : text.notMeasured}
        </Text>
      ) : null}
      {explain ? (
        <Sheet title={text.howTitle(text.metrics[explain])} onClose={() => setExplain(null)}>
          <Text style={s.text}>{text.how[explain]}</Text>
        </Sheet>
      ) : null}
    </Card>
  );
}

function ProposalCard({ proposal, onDecided }: { proposal: GoalProposal; onDecided: () => void }) {
  const { api } = useWorkspace();
  const act = useAction();
  const decide = (decision: ProposalDecision) =>
    act.run(async () => {
      await api.request(`/api/goals/proposals/${proposal.id}/decide`, { decision });
      onDecided(); // 결과 칩은 다시 읽은 목록의 status 로 그린다
    });
  return (
    <Card style={{ gap: 8, padding: 16 }}>
      <View style={[s.row, { gap: 8 }]}>
        <Text style={[s.heading, { flex: 1 }]}>{proposal.title}</Text>
        {proposal.status === "pending" ? null : (
          <Chip tint={proposal.status === "accepted" ? colors.okBg : colors.sunk}>
            {text.proposalStatus[proposal.status]}
          </Chip>
        )}
      </View>
      {proposal.detail ? <Text style={s.muted}>{proposal.detail}</Text> : null}
      <Text style={s.small}>
        {proposal.proposedBy} · {relativeDate(proposal.createdAt)}
      </Text>
      <ErrorNotice error={act.error} />
      {proposal.status === "pending" ? (
        <View style={[s.row, { gap: 8 }]}>
          <Button small primary busy={act.busy} onPress={() => void decide("accept")}>
            {text.accept}
          </Button>
          <Button small disabled={act.busy} onPress={() => void decide("hold")}>
            {text.hold}
          </Button>
        </View>
      ) : null}
    </Card>
  );
}
