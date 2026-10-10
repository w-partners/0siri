// 자동화 (마스터 2026-10-10 «적용되어 있는 크론과 스크립트를 확인하는 곳»): 지금 돌고 있는 주기 실행과 장착된 스크립트를 한 화면에.
// ① 피드 관심 프롬프트(N시간마다) ② 감시·예약 작업(엔진 monitors / scheduled tasks) ③ 장착된 스킬(방마다 붙는 스크립트).
// 실패는 숨기지 않는다 — 마지막 오류를 그대로 보인다.
import { Clock, Pause, Play, RefreshCw, Trash2 } from "lucide-react-native";
import { Text, View } from "react-native";
import type { FeedPrompt } from "../../../server/src/osiri/feed.ts";
import type { Skill } from "../../../server/src/osiri/skills.ts";
import { useAgentWorkspace } from "../agent-workspace";
import { Button, Card, Chip, colors, ErrorNotice, relativeDate, s, useAction } from "../ui";
import { useWorkspace } from "../workspace";
import { useRooms } from "./rooms";
import { LoadState, useLoad } from "./store";

const text = {
  feedHeading: "피드 관심 프롬프트",
  feedEmpty: "관심 프롬프트가 없어요",
  feedEmptyDetail: "피드 탭에서 관심 있는 주제를 적으면 여기서 주기·정지를 관리해요.",
  every: (h: number) => `${h}시간마다`,
  next: (at: string) => `다음 ${relativeDate(at)}`,
  paused: "멈춤",
  last: (r: string) => `마지막: ${r}`,
  failed: (e: string) => `마지막 실행 실패: ${e}`,
  runNow: "지금 실행",
  pause: "멈추기",
  resume: "다시 켜기",
  remove: "삭제",
  watchHeading: "감시 · 예약 작업",
  watchEmpty: "예약되었거나 감시 중인 작업이 없어요",
  minutes: (m: number) => (m >= 60 ? `${Math.round(m / 60)}시간마다` : `${m}분마다`),
  scriptsHeading: "장착된 스크립트 (스킬)",
  scriptsEmpty: "장착된 스킬이 없어요 — 아이디어 탭에서 스킬화 제안을 승인하면 여기에 붙어요.",
};

function PromptRow({ prompt, onChange }: { prompt: FeedPrompt; onChange: () => void }) {
  const { api } = useWorkspace();
  const act = useAction();
  const call = (path: string, body?: object, method?: string) =>
    act.run(async () => {
      await api.request(`/api/feed/prompts/${prompt.id}${path}`, body, method);
      onChange();
    });
  return (
    <Card style={{ gap: 6, padding: 14 }}>
      <Text style={s.heading}>{prompt.prompt}</Text>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Chip>{text.every(prompt.everyHours)}</Chip>
        {prompt.active ? (
          <Chip>{text.next(prompt.nextRunAt)}</Chip>
        ) : (
          <Chip tint={colors.warnBg}>{text.paused}</Chip>
        )}
      </View>
      {prompt.lastError ? (
        <Text style={[s.small, { color: colors.danger }]}>{text.failed(prompt.lastError)}</Text>
      ) : prompt.lastResult ? (
        <Text style={s.small}>
          {text.last(prompt.lastResult)} · {relativeDate(prompt.lastRunAt ?? prompt.createdAt)}
        </Text>
      ) : null}
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button small icon={RefreshCw} busy={act.busy} onPress={() => call("/run", {})}>
          {text.runNow}
        </Button>
        <Button
          small
          icon={prompt.active ? Pause : Play}
          disabled={act.busy}
          onPress={() => call("", { active: !prompt.active }, "PATCH")}
        >
          {prompt.active ? text.pause : text.resume}
        </Button>
        <Button
          small
          danger
          icon={Trash2}
          disabled={act.busy}
          onPress={() => call("", undefined, "DELETE")}
        >
          {text.remove}
        </Button>
      </View>
      <ErrorNotice error={act.error} />
    </Card>
  );
}

export function AutomationScreen() {
  const { api } = useWorkspace();
  const prompts = useLoad(() => api.request<FeedPrompt[]>("/api/feed/prompts"), "feed-prompts");
  const skills = useLoad(() => api.request<Skill[]>("/api/skills?status=active"), "skills-active");
  const { data: agent } = useAgentWorkspace();
  const { rooms } = useRooms();
  const roomTitle = (id: string) => rooms?.find((r) => r.id === id)?.title ?? "";
  const monitors = (agent?.monitors ?? []).filter((m) => m.status !== "stopped");
  const scheduled = (agent?.tasks ?? []).filter(
    (t) => t.status === "scheduled" && t.kind !== "monitor",
  );
  const reload = async () => prompts.setData(await api.request<FeedPrompt[]>("/api/feed/prompts"));
  return (
    <View style={{ gap: 14 }}>
      <Text style={s.heading}>{text.feedHeading}</Text>
      <LoadState
        loading={prompts.loading}
        error={prompts.error}
        retry={prompts.retry}
        empty={
          prompts.data?.length === 0 && {
            title: text.feedEmpty,
            detail: text.feedEmptyDetail,
            icon: Clock,
          }
        }
      >
        {prompts.data?.map((p) => (
          <PromptRow key={p.id} prompt={p} onChange={() => void reload()} />
        ))}
      </LoadState>

      <Text style={s.heading}>{text.watchHeading}</Text>
      {monitors.length + scheduled.length === 0 ? (
        <Text style={s.muted}>{text.watchEmpty}</Text>
      ) : (
        <>
          {monitors.map((m) => (
            <Card key={m.id} style={{ gap: 4, padding: 14 }}>
              <Text style={s.text}>{m.title}</Text>
              <Text style={s.small}>
                {text.minutes(m.intervalMinutes)} ·{" "}
                {m.status === "paused" ? text.paused : text.next(m.nextCheckAt)}
              </Text>
              {m.error ? (
                <Text style={[s.small, { color: colors.danger }]}>{text.failed(m.error)}</Text>
              ) : null}
            </Card>
          ))}
          {scheduled.map((t) => (
            <Card key={t.id} style={{ gap: 4, padding: 14 }}>
              <Text style={s.text}>{t.title}</Text>
              {t.nextRunAt ? <Text style={s.small}>{text.next(t.nextRunAt)}</Text> : null}
            </Card>
          ))}
        </>
      )}

      <Text style={s.heading}>{text.scriptsHeading}</Text>
      <LoadState loading={skills.loading} error={skills.error} retry={skills.retry} empty={false}>
        {skills.data?.length === 0 ? <Text style={s.muted}>{text.scriptsEmpty}</Text> : null}
        {skills.data?.map((skill) => (
          <Card key={skill.id} style={{ gap: 4, padding: 14 }}>
            <Text style={s.text}>
              {skill.name} <Text style={s.small}>v{skill.version}</Text>
            </Text>
            <Text style={s.small}>
              {skill.roomId ? `${roomTitle(skill.roomId)} · ` : ""}
              {skill.appliesTo}
            </Text>
          </Card>
        ))}
      </LoadState>
    </View>
  );
}
