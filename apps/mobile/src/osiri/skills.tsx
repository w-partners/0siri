// 0Siri 스킬(화면 9) — 팀이 배운 패턴의 초안을 승인·반려하고, 장착된 스킬의 버전·효과를 관리한다.
// 개인 스킬은 사용자가, 패키지 공통 스킬은 운영자가 승인한다(운영자 경로는 operator.tsx).
import { ScanSearch, Sparkles } from "lucide-react-native";
import { useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import {
  type OperatorSkillDecision,
  SKILL_SCOPE_LABELS,
  SKILL_STATUS_LABELS,
  type SkillDecision,
  type SkillStatus,
} from "../../../../packages/domain/src/osiri";
import type { Skill } from "../../../server/src/osiri/skills.ts";
import {
  Button,
  Card,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  fonts,
  Skeleton,
  s,
  useAction,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar, type Mood } from "./eve";
import { refreshRooms, useRooms } from "./rooms";
import { useLoad } from "./store";
import { LoadError } from "./team-goals";

const text = {
  draftsHeading: "승인 대기 초안",
  activeHeading: "장착 중",
  retireHeading: "폐기 제안",
  count: (n: number) => `${n}건`,
  emptyDrafts: "승인 대기 중인 스킬 초안이 없습니다",
  emptyDraftsDetail:
    "«스킬 후보 찾기»를 누르거나 팀이 같은 패턴을 반복해서 배우면 초안이 여기에 올라와요.",
  emptyActive: "장착된 스킬이 없습니다",
  emptyActiveDetail: "초안을 승인하면 버전이 붙어 여기에 장착돼요.",
  goChat: "대화하러 가기",
  scanTitle: "스킬화할 수 있는 것 찾기",
  scanDetail:
    "영시리가 내 대화에서 여러 번 비슷하게 부탁한 일을 찾아 초안으로 올려요. 승인해야 장착됩니다.",
  scan: "스킬 후보 찾기",
  scanResult: (scanned: number, made: number) =>
    made > 0
      ? `요청 ${scanned}건을 살펴 새 초안 ${made}건을 올렸어요`
      : `요청 ${scanned}건을 살펴봤어요 — 새로 반복된 일은 아직 없어요`,
  evidence: "근거",
  appliesTo: "적용",
  proposedBy: "제안",
  approve: "승인",
  reject: "반려",
  rejectReason: "반려 사유",
  rejectHint: "초안을 만든 에이전트에게 돌아가요",
  sendReject: "반려 보내기",
  cancel: "취소",
  packageNote: "패키지 공통 스킬은 운영자가 승인합니다",
  measuring: "효과 측정 중",
  rollback: "롤백",
  retire: "폐기",
  keep: "유지",
};
const mono = { fontFamily: fonts.mono };
// 결과가 정해지면 제안한 에이전트의 표정만 바뀐다
const moodOf = (status: SkillStatus): Mood =>
  status === "active" ? "happy" : status === "rejected" ? "alert" : "idle";
const statusTint = (status: SkillStatus) =>
  status === "active" ? colors.okBg : status === "rejected" ? colors.missBg : colors.sunk;

/** 이름 · 버전 · 범위 한 줄. 버전은 모노. */
function SkillTitle({ skill }: { skill: Skill }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={s.heading}>{skill.name}</Text>
        <Text style={[s.small, mono]}>v{skill.version}</Text>
      </View>
      <Chip>{SKILL_SCOPE_LABELS[skill.scope]}</Chip>
    </View>
  );
}

/**
 * 초안 카드 — 제안 에이전트 미니 아바타 · 스킬명 · 근거 지표 · 적용 범위 · [승인] [반려].
 * 화면 9(개인 스킬)와 화면 10(운영자 큐)이 같이 쓴다. 결정 뒤의 잠금 칩은 다시 읽은 skill.status 로만 그린다.
 */
export function SkillDraftCard({
  skill,
  character,
  canDecide,
  onDecide,
}: {
  skill: Skill;
  /** 제안한 에이전트가 속한 팀의 캐릭터. 없으면 개인 에이전트(영시리) */
  character?: string;
  /** false 면 버튼 대신 «운영자가 승인» 안내만 보인다 */
  canDecide: boolean;
  onDecide: (decision: OperatorSkillDecision, reason?: string) => Promise<void>;
}) {
  const act = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const draft = skill.status === "draft";
  return (
    <Card style={{ gap: 10, padding: 16, borderColor: draft ? colors.warn : colors.line }}>
      <View style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
        <CharacterAvatar character={character} size={32} mood={moodOf(skill.status)} />
        <SkillTitle skill={skill} />
        {draft ? null : (
          <Chip tint={statusTint(skill.status)}>{SKILL_STATUS_LABELS[skill.status]}</Chip>
        )}
      </View>
      <Text style={s.text}>
        {text.evidence}: {skill.evidence}
      </Text>
      <Text style={s.muted}>
        {text.appliesTo}: {skill.appliesTo} · {text.proposedBy}: {skill.proposedBy}
      </Text>
      <ErrorNotice error={act.error} />
      {!draft ? null : !canDecide ? (
        <Chip tint={colors.sunk}>{text.packageNote}</Chip>
      ) : rejecting ? (
        <View>
          <Field
            label={text.rejectReason}
            placeholder={text.rejectHint}
            value={reason}
            onChangeText={setReason}
          />
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              danger
              busy={act.busy}
              disabled={!reason.trim()}
              onPress={() => void act.run(() => onDecide("reject", reason.trim()))}
            >
              {text.sendReject}
            </Button>
            <Button small disabled={act.busy} onPress={() => setRejecting(false)}>
              {text.cancel}
            </Button>
          </View>
        </View>
      ) : (
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            primary
            busy={act.busy}
            onPress={() => void act.run(() => onDecide("approve"))}
          >
            {text.approve}
          </Button>
          <Button small disabled={act.busy} onPress={() => setRejecting(true)}>
            {text.reject}
          </Button>
        </View>
      )}
    </Card>
  );
}

export function SkillsScreen({ roomId }: { roomId?: string }) {
  const { api, notify, navigate } = useWorkspace();
  const { width } = useWindowDimensions();
  const path = `/api/skills${roomId ? `?room_id=${encodeURIComponent(roomId)}` : ""}`;
  const skills = useLoad(() => api.request<Skill[]>(path), path);
  // 초안 카드의 미니 아바타 = 그 스킬이 속한 방의 캐릭터 (방 목록의 정본은 rooms.tsx 의 공용 저장소 — 따로 읽지 않는다)
  const rooms = useRooms();
  // 이 화면에서 결정한 초안은 목록에서 사라지지 않고 잠긴 채 남는다
  const [decided, setDecided] = useState<string[]>([]);
  const scan = useAction();

  /** 쓰기 한 번 → 목록을 다시 읽고, 서버가 돌려준 상태로만 결과를 알린다. */
  const write = async (skill: Skill, sub: string, body: Record<string, unknown>) => {
    await api.request(`/api/skills/${skill.id}/${sub}`, body);
    const fresh = await api.request<Skill[]>(path);
    skills.setData(fresh);
    const now = fresh.find((x) => x.id === skill.id);
    if (now) notify(`${now.name} v${now.version} · ${SKILL_STATUS_LABELS[now.status]}`);
  };

  const list = skills.data;
  if (!list)
    return skills.error ? (
      <LoadError error={skills.error} onRetry={skills.retry} />
    ) : (
      <Skeleton rows={3} height={110} />
    );

  const characterOf = (skill: Skill) => rooms.rooms?.find((r) => r.id === skill.roomId)?.character;
  const drafts = list.filter((x) => x.status === "draft" || decided.includes(x.id));
  const active = list.filter((x) => x.status === "active");
  const retiring = list.filter((x) => x.status === "retire_proposed");
  const goChat = (
    <Button small onPress={() => navigate("chat")}>
      {text.goChat}
    </Button>
  );
  const heading = (title: string, n: number) => (
    <View style={[s.row, { gap: 6 }]}>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.heading, mono]}>{text.count(n)}</Text>
    </View>
  );

  // 좁은 화면에서 flex:1 은 세로로 쌓인 두 칸을 0 높이 기준으로 줄여 겹치게 한다 — 넓을 때만 나눠 갖는다
  const column = { gap: 12, ...(width >= 900 ? { flex: 1 } : {}) };
  const draftColumn = (
    <View style={column}>
      {roomId ? null : (
        <Card style={{ gap: 8, padding: 16 }}>
          <Text style={s.heading}>{text.scanTitle}</Text>
          <Text style={s.muted}>{text.scanDetail}</Text>
          <Button
            primary
            small
            icon={ScanSearch}
            busy={scan.busy}
            onPress={() =>
              scan.run(async () => {
                const r = await api.request<{ scanned: number; created: Skill[] }>(
                  "/api/skills/scan",
                  {},
                );
                skills.setData(await api.request<Skill[]>(path));
                notify(text.scanResult(r.scanned, r.created.length));
              })
            }
          >
            {text.scan}
          </Button>
          <ErrorNotice error={scan.error} />
        </Card>
      )}
      {heading(text.draftsHeading, drafts.filter((x) => x.status === "draft").length)}
      {drafts.length === 0 ? (
        <Card>
          <Empty icon={Sparkles} title={text.emptyDrafts} detail={text.emptyDraftsDetail}>
            {goChat}
          </Empty>
        </Card>
      ) : (
        drafts.map((skill) => (
          <SkillDraftCard
            key={skill.id}
            skill={skill}
            character={characterOf(skill)}
            canDecide={skill.scope === "personal"}
            onDecide={async (decision, reason) => {
              await write(skill, "decide", { decision, reason });
              setDecided((ids) => [...ids, skill.id]);
            }}
          />
        ))
      )}
    </View>
  );
  const activeColumn = (
    <View style={column}>
      {heading(text.activeHeading, active.length)}
      {active.length === 0 ? (
        <Card>
          <Empty icon={Sparkles} title={text.emptyActive} detail={text.emptyActiveDetail}>
            {goChat}
          </Empty>
        </Card>
      ) : (
        active.map((skill) => (
          <ActiveRow key={skill.id} skill={skill} onRollback={() => write(skill, "rollback", {})} />
        ))
      )}
      {retiring.length > 0 ? heading(text.retireHeading, retiring.length) : null}
      {retiring.map((skill) => (
        <RetireCard
          key={skill.id}
          skill={skill}
          onDecide={(decision) => write(skill, "decide", { decision })}
        />
      ))}
    </View>
  );

  return (
    <View style={{ gap: 16 }}>
      {skills.error ? <LoadError error={skills.error} onRetry={skills.retry} /> : null}
      {rooms.error ? (
        <LoadError error={rooms.error} onRetry={() => void refreshRooms(api)} />
      ) : null}
      {width >= 900 ? (
        <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
          {draftColumn}
          {activeColumn}
        </View>
      ) : (
        <>
          {draftColumn}
          {activeColumn}
        </>
      )}
    </View>
  );
}

/** 장착 목록 한 줄: 이름 · 버전 · 효과 측정 상태 · [롤백]. */
function ActiveRow({ skill, onRollback }: { skill: Skill; onRollback: () => Promise<void> }) {
  const act = useAction();
  return (
    <Card style={{ gap: 8, padding: 16 }}>
      <View style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
        <SkillTitle skill={skill} />
        {skill.measuring ? <Chip tint={colors.warnBg}>{text.measuring}</Chip> : null}
      </View>
      {skill.measuring && skill.measureNote ? (
        <Text style={s.small}>{skill.measureNote}</Text>
      ) : null}
      {skill.effect ? <Text style={s.muted}>{skill.effect}</Text> : null}
      <ErrorNotice error={act.error} />
      <Button
        small
        busy={act.busy}
        onPress={() => void act.run(onRollback)}
        style={{ alignSelf: "flex-start" }}
      >
        {text.rollback}
      </Button>
    </Card>
  );
}

/** 폐기 제안 카드 — 측정에서 악화가 확인되면 뜬다. [폐기] [유지]. */
function RetireCard({
  skill,
  onDecide,
}: {
  skill: Skill;
  onDecide: (decision: Exclude<SkillDecision, OperatorSkillDecision>) => Promise<void>;
}) {
  const act = useAction();
  return (
    <Card style={{ gap: 8, padding: 16, borderColor: colors.miss }}>
      <SkillTitle skill={skill} />
      {skill.effect ? <Text style={s.text}>{skill.effect}</Text> : null}
      <ErrorNotice error={act.error} />
      {skill.scope === "personal" ? (
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            danger
            busy={act.busy}
            onPress={() => void act.run(() => onDecide("retire"))}
          >
            {text.retire}
          </Button>
          <Button small disabled={act.busy} onPress={() => void act.run(() => onDecide("keep"))}>
            {text.keep}
          </Button>
        </View>
      ) : (
        <Chip tint={colors.sunk}>{text.packageNote}</Chip>
      )}
    </Card>
  );
}
