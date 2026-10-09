// 0Siri 목표(S5) — 팀별 목표 트리(장기→중기→단기→작업)·진척·지표·다음 행동. 조회 + 단기 순서 변경만. 0SIRI-SPEC §4.5.
import { ArrowDown, ArrowUp, Target } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, Chip, colors, Empty, ErrorNotice, IconButton, s } from "../ui";
import { useWorkspace } from "../workspace";
import type { Room, TeamGoal } from "./rooms";

const text = {
  loadFailed: "불러오지 못했어요",
  retry: "다시 시도",
  noRooms: "팀이 없어요",
  noRoomsDetail: "스토어에서 팀을 고용하면 목표가 생겨요.",
  emptyTitle: "목표가 아직 없어요",
  emptyDetail: "새 목표는 채팅에서 팀장과 대화해 만들어요. 이 화면은 조회와 순서 변경만 해요.",
  levels: { long: "장기", mid: "중기", short: "단기", task: "작업" } as Record<string, string>,
  metrics: { published: "발행", indexed: "색인", ai_citations: "AI 인용" } as Record<
    string,
    string
  >,
  next: "다음 행동",
  up: "위로",
  down: "아래로",
  status: { paused: "일시정지", completed: "완료", blocked: "막힘" } as Record<string, string>,
  personal: "영시리",
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const byOrder = (a: TeamGoal, b: TeamGoal) =>
  a.order - b.order || a.createdAt.localeCompare(b.createdAt);

export function TeamGoalsScreen() {
  const { api } = useWorkspace();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [roomId, setRoomId] = useState("");
  const [goals, setGoals] = useState<TeamGoal[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadRooms = useCallback(async () => {
    setError("");
    try {
      const list = await api.request<Room[]>("/api/rooms");
      setRooms(list);
      setRoomId((id) => id || list[0]?.id || "");
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  const loadGoals = useCallback(async () => {
    if (!roomId) return;
    setError("");
    try {
      setGoals(await api.request<TeamGoal[]>(`/api/goals?room_id=${roomId}`));
    } catch (e) {
      setError(errorText(e));
    }
  }, [api, roomId]);
  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);
  useEffect(() => {
    setGoals(null);
    void loadGoals();
  }, [loadGoals]);

  // 단기 목표 순서: 이웃과 order 를 맞바꾼다(두 건 PATCH). 서버가 방 타임라인에 알림을 남긴다.
  const move = async (goal: TeamGoal, dir: -1 | 1) => {
    if (!goals) return;
    const siblings = goals
      .filter((g) => g.level === "short" && g.parentId === goal.parentId)
      .sort(byOrder);
    const i = siblings.indexOf(goal);
    const other = siblings[i + dir];
    if (!other) return;
    setBusy(true);
    try {
      await api.request(`/api/goals/${goal.id}/order`, { order: other.order }, "PATCH");
      await api.request(`/api/goals/${other.id}/order`, { order: goal.order }, "PATCH");
      await loadGoals();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !rooms)
    return (
      <View style={{ gap: 12 }}>
        <ErrorNotice error={`${text.loadFailed}: ${error}`} />
        <Button onPress={() => void loadRooms()}>{text.retry}</Button>
      </View>
    );
  if (!rooms)
    return (
      <View style={{ gap: 12 }} accessibilityLabel="불러오는 중">
        {[0, 1].map((i) => (
          <View key={i} style={[s.card, { height: 120, backgroundColor: colors.line }]} />
        ))}
      </View>
    );
  if (rooms.length === 0)
    return (
      <Card>
        <Empty icon={Target} title={text.noRooms} detail={text.noRoomsDetail} />
      </Card>
    );

  const children = (parentId: string | null) =>
    (goals ?? []).filter((g) => g.parentId === parentId).sort(byOrder);
  const render = (goal: TeamGoal, depth: number) => {
    const kids = children(goal.id);
    const siblings =
      goal.level === "short" ? children(goal.parentId).filter((g) => g.level === "short") : [];
    const idx = siblings.indexOf(goal);
    const metrics = Object.entries(goal.metrics ?? {}).filter(([, v]) => v !== undefined);
    return (
      <View key={goal.id} style={{ gap: 8, marginLeft: depth * 14, marginTop: 10 }}>
        <View style={[s.row, { gap: 8 }]}>
          <Chip tint={depth === 0 ? colors.lavender : undefined}>{text.levels[goal.level]}</Chip>
          <Text style={[goal.level === "task" ? s.muted : s.text, { flex: 1 }]} numberOfLines={2}>
            {goal.title}
            {goal.status !== "active" && text.status[goal.status]
              ? ` · ${text.status[goal.status]}`
              : ""}
          </Text>
          <Text style={[s.small, { width: 36, textAlign: "right" }]}>{goal.progress}%</Text>
          {goal.level === "short" && siblings.length > 1 && (
            <View style={s.row}>
              {idx > 0 && (
                <IconButton icon={ArrowUp} label={text.up} onPress={() => void move(goal, -1)} />
              )}
              {idx < siblings.length - 1 && (
                <IconButton icon={ArrowDown} label={text.down} onPress={() => void move(goal, 1)} />
              )}
            </View>
          )}
        </View>
        <View
          style={{ height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" }}
        >
          <View
            style={{
              width: `${Math.max(0, Math.min(100, goal.progress))}%`,
              height: 6,
              backgroundColor: goal.status === "blocked" ? colors.danger : colors.blueDark,
            }}
          />
        </View>
        {metrics.length > 0 && (
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {metrics.map(([k, v]) => (
              <Chip key={k} tint={colors.green}>
                {text.metrics[k] ?? k} {String(v)}
              </Chip>
            ))}
          </View>
        )}
        {goal.nextActions?.[0] ? (
          <Text style={s.small}>
            {text.next}: {goal.nextActions[0]}
          </Text>
        ) : null}
        {kids.map((k) => render(k, depth + 1))}
      </View>
    );
  };
  const roots = children(null);
  return (
    <View style={{ gap: 16, opacity: busy ? 0.6 : 1 }}>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {rooms.map((r) => (
          <Button key={r.id} small primary={r.id === roomId} onPress={() => setRoomId(r.id)}>
            {r.packageId === null ? text.personal : r.title}
          </Button>
        ))}
      </View>
      <ErrorNotice error={error} />
      {error && goals === null ? (
        <Button onPress={() => void loadGoals()}>{text.retry}</Button>
      ) : goals === null ? (
        <View style={[s.card, { height: 120, backgroundColor: colors.line }]} />
      ) : roots.length === 0 ? (
        <Card>
          <Empty icon={Target} title={text.emptyTitle} detail={text.emptyDetail} />
        </Card>
      ) : (
        <Card style={{ paddingTop: 10 }}>{roots.map((g) => render(g, 0))}</Card>
      )}
    </View>
  );
}
