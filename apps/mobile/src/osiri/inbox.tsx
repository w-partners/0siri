// 0Siri 활동 / 결재함(화면 4) — 전 팀 승인 대기를 한 목록에서 건별로 처리하고, 이미 일어난 일은 활동 피드로 본다.
// roomId 를 주면 그 방의 «피드» 탭이다: 같은 내용을 그 방으로만 좁히고 팀 필터는 없다.
import { CheckCheck, Clock3 } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import {
  APPROVAL_KIND_LABELS,
  APPROVAL_KINDS,
  type ApprovalKind,
} from "../../../../packages/domain/src/osiri";
import type { Activity } from "../../../server/src/osiri/rooms.ts";
import {
  Badge,
  Button,
  Card,
  Chip,
  colors,
  Empty,
  fonts,
  relativeDate,
  Sheet,
  Skeleton,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar } from "./eve";
import {
  ApprovalCard,
  decidePending,
  isConflict,
  type PendingApproval,
  type RejectReason,
  type RoomFocus,
  refreshRooms,
  useRooms,
  useUserEvent,
} from "./rooms";
import { SkillsScreen } from "./skills";
import { Choice, useLoad } from "./store";
import { LoadError } from "./team-goals";

// --- GET /inbox 응답. 서버에 내보낸 타입이 없다 — room-routes.ts 의 `app.get("/inbox")` 핸들러가 만든다. ---
export type InboxApproval = PendingApproval & { roomCharacter: string };
/**
 * 활동 한 줄. 종류 이름(label)은 서버가 준다 — 여기서 kind → 이름을 다시 만들지 않는다.
 * `Activity.messageId` 는 그 활동이 붙은 방 메시지 — 있을 때만 그 메시지로 스크롤하고, 없으면 방만 연다.
 */
export type InboxActivity = Activity & { roomTitle: string; label: string };
export interface Inbox {
  pending: InboxApproval[];
  activities: InboxActivity[];
  /** 조회에 실패한 팀 — 나머지 팀은 정상으로 온다 */
  failed: { roomId: string; roomTitle: string; error: string }[];
}

const text = {
  allTeams: "전체 팀",
  filter: "필터",
  skills: "스킬",
  pendingHeading: "승인 대기",
  feedHeading: "활동",
  retry: "재시도",
  teamFailed: "불러오지 못함",
  emptyTitle: "결재할 항목이 없습니다",
  emptyDetail: "팀이 승인을 요청하면 여기에 모여요. 최근 활동은 아래에서 볼 수 있어요.",
  emptyFeed: "아직 활동이 없어요",
  emptyFeedDetail: "발행·배포·롤백이 일어나면 여기에 쌓여요.",
  goRooms: "팀 방 보기",
  goRoom: "방으로 가기",
  openRoom: "방에서 보기",
  handled: "처리됨",
  handledDetail: "다른 화면에서 이미 처리된 승인이에요.",
  reasonRequired: "반려 사유(톤·사실·주제)를 골라 주세요",
  // 토스트는 서버가 돌려준 status 로만 고른다
  done: { approved: "승인했습니다", rejected: "반려했습니다" } as Record<string, string>,
};

/**
 * 이 화면에서 결과가 정해진 카드. status 는 서버가 돌려준 값, null 은 «다른 곳에서 이미 처리됨»(409).
 * label 은 스킬 초안의 결과 이름(스킬 상태는 승인 상태표에 없다).
 */
type Settled = { item: InboxApproval; status: string | null; label?: string };

export function InboxScreen({
  roomId,
  onOpenRoom,
}: {
  roomId?: string;
  onOpenRoom: (roomId: string, focus?: RoomFocus) => void;
}) {
  const { api, notify, navigate } = useWorkspace();
  const { width } = useWindowDimensions();
  const [team, setTeam] = useState("");
  const [kind, setKind] = useState<ApprovalKind | "">("");
  const [settled, setSettled] = useState<Settled[]>([]);
  const [skills, setSkills] = useState(false);

  const scope = roomId ?? team;
  const query = [scope && `room_id=${encodeURIComponent(scope)}`, kind && `kind=${kind}`]
    .filter(Boolean)
    .join("&");
  const path = `/api/inbox${query ? `?${query}` : ""}`;
  const inbox = useLoad(() => api.request<Inbox>(path), path);
  // 팀 필터 칩과 팀별 대기 배지는 방 목록이 정본이다(필터를 걸어도 다른 팀의 숫자가 남는다) — 앱이 쥔 목록을 같이 쓴다.
  const { rooms, error: roomsError } = useRooms();
  // 다른 기기·다른 화면에서 승인이 생기거나 처리되면 서버가 `inbox` 이벤트를 보낸다
  useUserEvent("inbox", () => inbox.retry());

  const decide = async (
    a: InboxApproval,
    decision: "approve" | "reject",
    reason?: RejectReason,
  ) => {
    if (decision === "reject" && !reason) throw new Error(text.reasonRequired);
    let status: string | null;
    let label: string | undefined;
    try {
      ({ status, label } = await decidePending(api, a, decision, reason));
    } catch (e) {
      // 이미 처리된 건은 409 + 현재 status 로 온다(AlreadyDecidedError). 그 밖의 실패는 사유를 카드에 그대로 보인다.
      const current = isConflict(e)
        ? (e.body as { status?: unknown } | undefined)?.status
        : undefined;
      if (typeof current !== "string") {
        // status 없는 409 = 승인 요청의 내용이 바뀌었다 — 서버 문장은 카드에 남기고 카드를 새 내용으로 다시 읽는다
        if (isConflict(e)) inbox.retry();
        throw e;
      }
      status = null; // 이미 다른 화면에서 처리됨 — 성공 토스트를 내지 않는다
    }
    setSettled((list) => [...list.filter((x) => x.item.id !== a.id), { item: a, status, label }]);
    const done = status === null ? undefined : (text.done[status] ?? label);
    if (done) notify(done);
    inbox.retry(); // 활동 피드에 결과 반영
    void refreshRooms(api); // 팀 배지 갱신
  };
  /** 카드가 붙은 방 메시지로 간다. 스킬 초안처럼 메시지가 없는 건은 그 방의 승인 대기 위치로. */
  const openAt = (a: InboxApproval) =>
    onOpenRoom(a.roomId, a.messageId ? { messageId: a.messageId } : { approval: true });

  const data = inbox.data;
  const settledIds = new Set(settled.map((x) => x.item.id));
  const pending = data?.pending.filter((a) => !settledIds.has(a.id));
  const locked = settled.filter(
    (x) => (!scope || x.item.roomId === scope) && (!kind || x.item.kind === kind),
  );
  const nextAction = roomId ? (
    <Button small onPress={() => onOpenRoom(roomId)}>
      {text.goRoom}
    </Button>
  ) : (
    <Button small onPress={() => navigate("rooms")}>
      {text.goRooms}
    </Button>
  );

  const wide = width >= 900 && !roomId;
  const teamFilter = roomId ? null : (
    <View
      style={
        wide
          ? { width: 220, gap: 10, alignItems: "flex-start" }
          : [s.row, { gap: 10, flexWrap: "wrap" }]
      }
    >
      <Choice label={text.allTeams} selected={team === ""} onPress={() => setTeam("")} />
      {roomsError ? <LoadError error={roomsError} onRetry={() => void refreshRooms(api)} /> : null}
      {rooms?.map((r) => (
        <View key={r.id} style={[s.row, { gap: 4 }]}>
          <Choice label={r.title} selected={team === r.id} onPress={() => setTeam(r.id)} />
          <Badge count={r.pendingApprovals} />
        </View>
      ))}
    </View>
  );

  const body = (
    <View style={{ flex: 1, gap: 14 }}>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={s.small}>{text.filter}</Text>
        {APPROVAL_KINDS.map((k) => (
          <Choice
            key={k}
            label={APPROVAL_KIND_LABELS[k]}
            selected={kind === k}
            onPress={() => setKind(kind === k ? "" : k)}
          />
        ))}
        <View style={{ flex: 1 }} />
        <Button small onPress={() => setSkills(true)}>
          {text.skills}
        </Button>
      </View>
      {skills ? (
        <Sheet title={text.skills} onClose={() => setSkills(false)} wide>
          <SkillsScreen roomId={scope || undefined} />
        </Sheet>
      ) : null}

      {!data ? (
        inbox.error ? (
          <LoadError error={inbox.error} onRetry={inbox.retry} />
        ) : (
          <Skeleton rows={3} height={96} />
        )
      ) : (
        <>
          {inbox.error ? <LoadError error={inbox.error} onRetry={inbox.retry} /> : null}
          {data.failed.map((f) => (
            <Card
              key={f.roomId}
              style={{ gap: 6, padding: 14, borderColor: colors.miss, alignItems: "flex-start" }}
            >
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Chip>{f.roomTitle}</Chip>
                <Chip tint={colors.missBg}>{text.teamFailed}</Chip>
              </View>
              <Text style={s.muted}>{f.error}</Text>
              <Button small onPress={inbox.retry}>
                {text.retry}
              </Button>
            </Card>
          ))}

          <View style={[s.row, { gap: 6 }]}>
            <Text style={s.heading}>{text.pendingHeading}</Text>
            <Text style={[s.heading, { fontFamily: fonts.mono }]}>{pending?.length}</Text>
          </View>
          {pending?.length === 0 && locked.length === 0 ? (
            <Card>
              <Empty icon={CheckCheck} title={text.emptyTitle} detail={text.emptyDetail}>
                {nextAction}
              </Empty>
            </Card>
          ) : null}
          {pending?.map((a) => (
            <View key={a.id} style={{ gap: 6 }}>
              <CardMeta item={a} />
              <ApprovalCard
                title={a.title}
                summary={a.summary}
                evidence={a.evidence}
                status={a.status}
                character={a.roomCharacter}
                onDecide={(decision, reason) => decide(a, decision, reason)}
                onOpenRoom={() => openAt(a)}
              />
            </View>
          ))}
          {locked.map(({ item, status, label }) => (
            <View key={item.id} style={{ gap: 6 }}>
              <CardMeta item={item} />
              {status === null ? (
                <Card style={{ gap: 8, padding: 16, alignItems: "flex-start" }}>
                  <View style={[s.row, { gap: 10, alignSelf: "stretch" }]}>
                    <CharacterAvatar character={item.roomCharacter} size={28} />
                    <Text style={[s.heading, { flex: 1 }]}>{item.title}</Text>
                    <Chip tint={colors.sunk}>{text.handled}</Chip>
                  </View>
                  <Text style={s.muted}>{text.handledDetail}</Text>
                  <Button small onPress={() => openAt(item)}>
                    {text.openRoom}
                  </Button>
                </Card>
              ) : (
                <ApprovalCard
                  title={item.title}
                  summary={item.summary}
                  evidence={item.evidence}
                  status={status}
                  statusLabel={label}
                  character={item.roomCharacter}
                  onDecide={(decision, reason) => decide(item, decision, reason)}
                  onOpenRoom={() => openAt(item)}
                />
              )}
            </View>
          ))}

          <Text style={[s.heading, { marginTop: 8 }]}>{text.feedHeading}</Text>
          {data.activities.length === 0 ? (
            <Card>
              <Empty icon={Clock3} title={text.emptyFeed} detail={text.emptyFeedDetail}>
                {nextAction}
              </Empty>
            </Card>
          ) : (
            <Card style={{ paddingVertical: 4 }}>
              {data.activities.map((a, i) => (
                <ActivityRow key={a.id} item={a} first={i === 0} onOpenRoom={onOpenRoom} />
              ))}
            </Card>
          )}
        </>
      )}
    </View>
  );

  return wide ? (
    <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
      {teamFilter}
      {body}
    </View>
  ) : (
    <View style={{ gap: 16 }}>
      {teamFilter}
      {body}
    </View>
  );
}

/** 카드 위 한 줄: 팀 배지 · 종류 · 기다린 시간. */
function CardMeta({ item }: { item: InboxApproval }) {
  return (
    <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
      <Chip tint={colors.accentSoft}>{item.roomTitle}</Chip>
      <Chip>{APPROVAL_KIND_LABELS[item.kind]}</Chip>
      <Text style={s.small}>{relativeDate(item.createdAt)}</Text>
    </View>
  );
}

/** 활동 한 줄. 방이 있는 활동은 누르면 그 방(감사 기록이 붙은 메시지)으로 간다. */
function ActivityRow({
  item,
  first,
  onOpenRoom,
}: {
  item: InboxActivity;
  first: boolean;
  onOpenRoom: (roomId: string, focus?: RoomFocus) => void;
}) {
  const roomId = item.roomId;
  const content = (
    <View
      style={{
        gap: 4,
        paddingVertical: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Chip tint={item.kind === "error" ? colors.missBg : colors.accentSoft}>{item.label}</Chip>
        {item.roomTitle ? <Chip>{item.roomTitle}</Chip> : null}
        <Text style={s.small}>
          {item.actor} · {relativeDate(item.createdAt)}
        </Text>
      </View>
      <Text style={s.text}>{item.title}</Text>
      {item.detail ? <Text style={s.muted}>{item.detail}</Text> : null}
    </View>
  );
  return roomId ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title} — ${text.openRoom}`}
      onPress={() => onOpenRoom(roomId, item.messageId ? { messageId: item.messageId } : undefined)}
    >
      {content}
    </Pressable>
  ) : (
    content
  );
}
