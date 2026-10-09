// 0Siri 결재함(S4) — 전 팀 승인 대기 + 활동 피드. 0SIRI-SPEC §4.4.
import { CheckCheck, Clock3 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Activity } from "../../../server/src/osiri/rooms.ts";
import { Button, Card, Chip, colors, Empty, ErrorNotice, relativeDate, s } from "../ui";
import { useWorkspace } from "../workspace";
import { ApprovalCard, decideApproval, type PendingApproval } from "./rooms";

type Feed = Activity & { roomTitle: string };
const text = {
  tabPending: (n: number) => (n ? `결재 대기 ${n}` : "결재 대기"),
  tabAll: "전체 활동",
  loadFailed: "불러오지 못했어요",
  retry: "다시 시도",
  emptyPendingTitle: "처리할 승인이 없어요",
  emptyPendingDetail: "팀이 승인을 요청하면 여기에 모여요.",
  emptyFeedTitle: "아직 활동이 없어요",
  emptyFeedDetail: "발행·보고·오류가 생기면 여기에 쌓여요.",
  approved: "승인했습니다",
  rejected: "반려했습니다",
  kinds: {
    approval: "승인",
    publish: "발행",
    report: "보고",
    error: "오류",
    goal: "목표",
    system: "알림",
    skill: "스킬",
    subscription: "구독",
  } as Record<string, string>,
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function InboxScreen() {
  const { api, notify } = useWorkspace();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [pending, setPending] = useState<PendingApproval[] | null>(null);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const r = await api.request<{ pending: PendingApproval[]; activities: Feed[] }>("/api/inbox");
      // 팀 → 종류 → 오래 기다린 순
      setPending(
        [...r.pending].sort(
          (a, b) =>
            a.roomTitle.localeCompare(b.roomTitle) ||
            a.toolName.localeCompare(b.toolName) ||
            a.createdAt.localeCompare(b.createdAt),
        ),
      );
      setFeed(r.activities);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !pending)
    return (
      <View style={{ gap: 12 }}>
        <ErrorNotice error={`${text.loadFailed}: ${error}`} />
        <Button onPress={() => void load()}>{text.retry}</Button>
      </View>
    );
  if (!pending)
    return (
      <View style={{ gap: 12 }} accessibilityLabel="불러오는 중">
        {[0, 1, 2].map((i) => (
          <View key={i} style={[s.card, { height: 88, backgroundColor: colors.line }]} />
        ))}
      </View>
    );
  return (
    <View style={{ gap: 16 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Button small primary={tab === "pending"} onPress={() => setTab("pending")}>
          {text.tabPending(pending.length)}
        </Button>
        <Button small primary={tab === "all"} onPress={() => setTab("all")}>
          {text.tabAll}
        </Button>
      </View>
      <ErrorNotice error={error} />
      {tab === "pending" ? (
        pending.length === 0 ? (
          <Card>
            <Empty
              icon={CheckCheck}
              title={text.emptyPendingTitle}
              detail={text.emptyPendingDetail}
            />
          </Card>
        ) : (
          pending.map((a) => (
            <View key={a.id} style={{ gap: 6 }}>
              <View style={[s.row, { gap: 8 }]}>
                <Chip>{a.roomTitle}</Chip>
                <Chip>{a.toolName}</Chip>
                <Text style={s.small}>{relativeDate(a.createdAt)}</Text>
              </View>
              <ApprovalCard
                title={a.title}
                summary={a.summary}
                evidence={a.evidence}
                status={a.status}
                onDecide={async (decision, reason) => {
                  await decideApproval(api, a.id, decision, a.inputHash, reason);
                  setPending((list) => list?.filter((x) => x.id !== a.id) ?? list);
                  notify(decision === "approve" ? text.approved : text.rejected);
                  void load(); // 활동 피드에 결과를 반영
                }}
              />
            </View>
          ))
        )
      ) : feed.length === 0 ? (
        <Card>
          <Empty icon={Clock3} title={text.emptyFeedTitle} detail={text.emptyFeedDetail} />
        </Card>
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {feed.map((a) => (
            <View
              key={a.id}
              style={{
                gap: 4,
                paddingVertical: 14,
                borderTopWidth: 1,
                borderTopColor: colors.line,
              }}
            >
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Chip tint={a.kind === "error" ? "#FBEFED" : colors.sky}>
                  {text.kinds[a.kind] ?? a.kind}
                </Chip>
                {a.roomTitle ? <Chip>{a.roomTitle}</Chip> : null}
                <Text style={s.small}>
                  {a.actor} · {relativeDate(a.createdAt)}
                </Text>
              </View>
              <Text style={s.text}>{a.title}</Text>
              {a.detail ? <Text style={s.muted}>{a.detail}</Text> : null}
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}
