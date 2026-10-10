import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  ChevronRight,
  CircleDollarSign,
  Heart,
  ListChecks,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Target,
  Users,
  X,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Artifact, BrowserSession } from "../../../packages/domain/src";
import type {
  AgentArtifact,
  AgentMemory,
  AgentTask,
  Evidence,
  Goal,
  Monitor,
  RunEvent,
} from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { HtmlFrame } from "./osiri/html-frame";
import { ActivityScreen, ConnectionsScreen } from "./screens";
import { t } from "./strings";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  IconButton,
  Mascot,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
} from "./ui";
import { useWorkspace } from "./workspace";

const statusLabels: Record<string, string> = t.agent.status;
export function statusLabel(value: string) {
  return statusLabels[value] ?? value.replace(/_/g, " ");
}
function stamp(value?: string) {
  return value
    ? new Date(value).toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : t.agent.notCheckedYet;
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function activeTask(task: AgentTask) {
  return !["succeeded", "failed", "cancelled"].includes(task.status);
}
export function AgentStatus() {
  const { data, error, refresh } = useAgentWorkspace();
  if (data?.worker.running && !error) return null;
  return (
    <View style={{ gap: 8 }}>
      <ErrorNotice error={error ? t.agent.worker.unavailable(error) : ""} />
      {!!error && (
        <Button small onPress={() => void refresh().catch(() => {})}>
          {t.agent.worker.reconnect}
        </Button>
      )}
      {!data && !error && <ActivityIndicator color={colors.blueDark} />}
      {data && !data.worker.running && <Text style={s.small}>{t.agent.worker.offline}</Text>}
    </View>
  );
}
export function TaskCard({
  task,
  compact = false,
  onOpen,
}: {
  task: AgentTask;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const { open } = useWorkspace();
  const done = task.plan.filter((step) => step.status === "succeeded").length;
  const next = task.plan.find((step) => ["running", "waiting"].includes(step.status));
  const waiting = ["waiting_input", "waiting_approval"].includes(task.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.agent.taskCard.open(task.title)}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId: task.id });
      }}
    >
      <Card
        style={{
          padding: compact ? 15 : 20,
          gap: 11,
          borderRadius: 22,
          backgroundColor: "#F0F1F2",
        }}
      >
        <View style={[s.row, { gap: 10 }]}>
          <View
            style={[
              s.iconBox,
              { width: 34, height: 34, backgroundColor: waiting ? colors.orange : colors.sky },
            ]}
          >
            <ListChecks size={18} color={colors.blueDark} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>{task.title}</Text>
            <Text style={s.small}>
              {statusLabel(task.status)}
              {task.plan.length ? ` · ${t.agent.taskCard.stepsDone(done, task.plan.length)}` : ""}
            </Text>
          </View>
          <ChevronRight size={17} color={colors.muted} />
        </View>
        {!!task.plan.length && (
          <View style={{ height: 4, backgroundColor: colors.line, borderRadius: 4 }}>
            <View
              style={{
                height: 4,
                width: `${Math.round((done / task.plan.length) * 100)}%`,
                backgroundColor: "#6AAEE0",
                borderRadius: 4,
              }}
            />
          </View>
        )}
        {(task.question || task.result || task.error || next?.title) && (
          <Text numberOfLines={compact ? 2 : 4} style={s.muted}>
            {task.question || task.error || resultSummary(task.result || next?.title || "")}
          </Text>
        )}
        {waiting && (
          <Text style={[s.small, { color: colors.blueDark, fontWeight: "600" }]}>
            {task.status === "waiting_approval"
              ? t.agent.taskCard.reviewRequested
              : t.agent.taskCard.inputNeeded}
          </Text>
        )}
      </Card>
    </Pressable>
  );
}
export function ChatWork() {
  const { data } = useAgentWorkspace();
  const tasks = [...(data?.tasks || [])]
    .filter(activeTask)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2);
  if (!tasks.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {tasks.map((task) => (
        <TaskCard task={task} key={task.id} compact />
      ))}
    </View>
  );
}
export function AgentActivityScreen() {
  const { data } = useAgentWorkspace();
  const [filter, setFilter] = useState<keyof typeof t.agent.activity.filters>("all");
  const tasks = [...(data?.tasks || [])]
    .filter(
      (task) => filter === "all" || (filter === "active" ? activeTask(task) : !activeTask(task)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <View style={{ gap: 20 }}>
      <AgentStatus />
      <View style={[s.row, { gap: 8 }]}>
        {(["all", "active", "finished"] as const).map((item) => (
          <Button key={item} small primary={filter === item} onPress={() => setFilter(item)}>
            {t.agent.activity.filters[item]}
          </Button>
        ))}
      </View>
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
      {!tasks.length && (
        <Empty
          icon={ListChecks}
          title={t.agent.activity.emptyTitle}
          detail={t.agent.activity.emptyDetail}
        />
      )}
      <SectionHeading title={t.agent.activity.reviewsHeading} />
      <ActivityScreen />
    </View>
  );
}
export function EvidenceList({ items }: { items: Evidence[] }) {
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 10 }}>
      {items.map((item) => (
        <View
          key={item.id}
          style={{ borderLeftWidth: 2, borderLeftColor: colors.blue, paddingLeft: 12, gap: 4 }}
        >
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>{item.title}</Text>
          <Text selectable style={s.small}>
            {item.excerpt}
          </Text>
          {item.url && /^https?:\/\//i.test(item.url) && (
            <Button
              small
              onPress={() =>
                void Linking.openURL(item.url || "").catch((e) => setError(errorText(e)))
              }
            >
              {t.agent.evidence.openSource}
            </Button>
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
    </View>
  );
}
export function TaskDetail({ taskId }: { taskId: string }) {
  const { api, workspace, close, open, refresh: refreshWorkspace } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const [detail, setDetail] = useState<{
    task: AgentTask;
    events: RunEvent[];
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [fieldJson, setFieldJson] = useState("");
  const [showFieldJson, setShowFieldJson] = useState(false);
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const task = data?.tasks.find((item) => item.id === taskId) || detail?.task;
  const milestone = data?.goals
    .find((goal) => goal.id === task?.goalId)
    ?.milestones.find((item) => item.id === task?.milestoneId);
  useEffect(() => {
    let active = true;
    void api
      .request<{
        task: AgentTask;
        events: RunEvent[];
        artifacts: AgentArtifact[];
        files: Artifact[];
        browsers: BrowserSession[];
      }>(`/api/agent/tasks/${taskId}`)
      .then((result) => {
        if (active) {
          setDetail(result);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, taskId, task?.updatedAt]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/${path}`, body);
      if (path === "input") {
        setAnswer("");
        setFields({});
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function submitInput() {
    try {
      let parsed: Record<string, string | boolean> = fields;
      if (fieldJson.trim()) {
        const raw: unknown = JSON.parse(fieldJson);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.values(raw).some(
            (value) => typeof value !== "string" && typeof value !== "boolean",
          )
        )
          throw new Error(t.agent.taskDetail.fieldsJsonInvalid);
        parsed = raw as Record<string, string | boolean>;
      }
      await act("input", {
        answer: answer.trim() || t.agent.taskDetail.fieldsProvided,
        fields: parsed,
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      await refreshWorkspace();
      const snapshot = await api.request<typeof workspace>("/api/workspace");
      const action = snapshot.actions.find((item) => item.id === task?.actionId);
      if (!action) throw new Error(t.agent.taskDetail.reviewUnavailable);
      open({ type: "review", action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const missing = Array.isArray(task?.state.missingFields) ? task.state.missingFields : [];
  const fieldNames = missing
    .map((field) =>
      typeof field === "string"
        ? field
        : typeof field === "object" && field && "name" in field
          ? String(field.name)
          : "",
    )
    .filter(Boolean);
  return (
    <Sheet
      title={task?.title || t.agent.taskDetail.fallbackTitle}
      subtitle={
        task ? `${statusLabel(task.status)} · ${stamp(task.updatedAt)}` : t.agent.taskDetail.loading
      }
      onClose={close}
    >
      <ErrorNotice error={error} />
      {!task ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : (
        <View style={{ gap: 20 }}>
          <Text selectable style={s.text}>
            {task.prompt}
          </Text>
          {task.milestoneId && data && (
            <Text style={s.muted}>
              {milestone?.title
                ? t.agent.taskDetail.milestone(milestone.title)
                : t.agent.taskDetail.milestoneMissing}
            </Text>
          )}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {["queued", "running", "scheduled", "waiting_input", "waiting_approval"].includes(
              task.status,
            ) && (
              <Button
                small
                icon={Pause}
                busy={busy}
                onPress={() => void act("control", { action: "pause" })}
              >
                {t.agent.taskDetail.pause}
              </Button>
            )}
            {task.status === "paused" && (
              <Button
                small
                icon={Play}
                busy={busy}
                onPress={() => void act("control", { action: "resume" })}
              >
                {t.agent.taskDetail.resume}
              </Button>
            )}
            {task.status === "failed" && (
              <Button
                small
                icon={RefreshCw}
                busy={busy}
                onPress={() => void act("control", { action: "retry" })}
              >
                {t.agent.taskDetail.retry}
              </Button>
            )}
            {activeTask(task) && (
              <Button
                small
                danger
                icon={X}
                busy={busy}
                onPress={() => void act("control", { action: "cancel" })}
              >
                {t.agent.taskDetail.cancel}
              </Button>
            )}
          </View>
          {task.status === "waiting_approval" && (
            <Card style={{ backgroundColor: colors.lavender, gap: 12 }}>
              <Text style={s.heading}>{t.agent.taskDetail.reviewTitle}</Text>
              <Text style={s.muted}>{t.agent.taskDetail.reviewDetail}</Text>
              <Button primary busy={busy} onPress={() => void review()}>
                {t.agent.taskDetail.reviewAction}
              </Button>
            </Card>
          )}
          {task.status === "waiting_input" && (
            <Card style={{ backgroundColor: colors.sky, gap: 10 }}>
              <Text style={s.heading}>{task.question || t.agent.taskDetail.inputTitle}</Text>
              {fieldNames.map((name) =>
                missing.some(
                  (f) => typeof f === "object" && f && f.name === name && f.type === "checkbox",
                ) ? (
                  <CheckRow
                    key={name}
                    label={name.replace(/_/g, " ")}
                    checked={Boolean(fields[name])}
                    onPress={() => setFields((current) => ({ ...current, [name]: !current[name] }))}
                  />
                ) : (
                  <Field
                    key={name}
                    label={name.replace(/_/g, " ")}
                    value={String(fields[name] ?? "")}
                    onChangeText={(value) =>
                      setFields((current) => ({ ...current, [name]: value }))
                    }
                  />
                ),
              )}
              {!fieldNames.length && (
                <Field
                  label={t.agent.taskDetail.answerLabel}
                  value={answer}
                  onChangeText={setAnswer}
                  multiline
                  placeholder={t.agent.taskDetail.answerPlaceholder}
                />
              )}
              {task.kind === "document" && !fieldNames.length && (
                <>
                  <Button small onPress={() => setShowFieldJson(!showFieldJson)}>
                    {t.agent.taskDetail.formFieldValues}
                  </Button>
                  {showFieldJson && (
                    <Field
                      label={t.agent.taskDetail.fieldsJsonLabel}
                      value={fieldJson}
                      onChangeText={setFieldJson}
                      multiline
                      autoCapitalize="none"
                      placeholder={t.agent.taskDetail.fieldsJsonPlaceholder}
                    />
                  )}
                </>
              )}
              <Button
                primary
                busy={busy}
                disabled={!answer.trim() && !Object.keys(fields).length && !fieldJson.trim()}
                onPress={() => void submitInput()}
              >
                {t.agent.taskDetail.continueTask}
              </Button>
            </Card>
          )}
          {!!task.plan.length && (
            <Card style={{ gap: 15 }}>
              <Text style={s.heading}>{t.agent.taskDetail.plan}</Text>
              {task.plan.map((step, index) => (
                <View key={step.id} style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
                  <Text
                    style={[
                      s.text,
                      { color: step.status === "succeeded" ? colors.blueDark : colors.muted },
                    ]}
                  >
                    {step.status === "succeeded" ? "✓" : `${index + 1}.`}
                  </Text>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.text}>{step.title}</Text>
                    <Text style={s.small}>
                      {statusLabel(step.status)}
                      {step.detail ? ` · ${step.detail}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          )}
          {!!task.result && (
            <Card style={{ backgroundColor: colors.green }}>
              <Text selectable style={s.text}>
                {resultSummary(task.result)}
              </Text>
            </Card>
          )}
          <ErrorNotice error={task.error ?? undefined} />
          {(
            data?.artifacts.filter((artifact) => artifact.taskId === taskId) ||
            detail?.artifacts ||
            []
          ).map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {!!task.evidence.length && (
            <View style={{ gap: 14 }}>
              <Text style={s.heading}>{t.agent.taskDetail.sources}</Text>
              <EvidenceList items={task.evidence} />
            </View>
          )}
          <Text style={s.heading}>{t.agent.taskDetail.timeline}</Text>
          {detail?.events.map((event) => (
            <View
              key={event.id}
              style={{ gap: 4, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.line }}
            >
              <Text style={s.small}>
                {stamp(event.date)} · {statusLabel(event.kind)}
              </Text>
              <Text style={s.text}>{event.title}</Text>
              <Text selectable style={s.muted}>
                {event.detail}
              </Text>
            </View>
          ))}
          {!detail?.events.length && (
            <Text style={s.muted}>{t.agent.taskDetail.timelineEmpty}</Text>
          )}
        </View>
      )}
    </Sheet>
  );
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "—"
        : JSON.stringify(value, null, 2) || "";
}
/** 아티팩트가 HTML 페이지면 그 원문 — 영시리의 save_artifact 가 { type: "html", content, filename } 으로 남긴다 */
const htmlOf = (artifact: AgentArtifact) =>
  artifact.data.type === "html" && typeof artifact.data.content === "string"
    ? artifact.data.content
    : null;

/** HTML 아티팩트: 원문을 글자로 늘어놓지 않고 «열기» 로 페이지를 전체 화면에 띄운다 (Muse 처럼 대화 안에서 깔끔한 참조) */
function HtmlArtifactCard({ artifact, html }: { artifact: AgentArtifact; html: string }) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  return (
    <Card style={{ gap: 10, backgroundColor: colors.card }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{artifact.title}</Text>
        <Chip>HTML</Chip>
      </View>
      {!!artifact.summary && <Text style={s.muted}>{artifact.summary}</Text>}
      <Button small primary icon={ArrowUpRight} onPress={() => setOpen(true)}>
        {t.agent.artifact.open}
      </Button>
      {open && (
        <Modal visible animationType="slide" onRequestClose={() => setOpen(false)}>
          <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
            <View style={[s.between, { paddingHorizontal: 12, paddingVertical: 6 }]}>
              <Text numberOfLines={1} style={[s.heading, { flex: 1 }]}>
                {artifact.title}
              </Text>
              <IconButton icon={X} label={t.common.close} onPress={() => setOpen(false)} />
            </View>
            <HtmlFrame html={html} />
          </View>
        </Modal>
      )}
    </Card>
  );
}

export function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const rows = Object.entries(artifact.data);
  const html = htmlOf(artifact);
  if (html) return <HtmlArtifactCard artifact={artifact} html={html} />;
  return (
    <Card style={{ gap: 13, backgroundColor: colors.card }}>
      <View style={s.between}>
        <Text style={s.heading}>{artifact.title}</Text>
        <Chip>{statusLabel(artifact.kind)}</Chip>
      </View>
      <Text selectable style={s.muted}>
        {artifact.summary}
      </Text>
      {(expanded ? rows : rows.slice(0, 4)).map(([key, value]) => (
        <View key={key} style={{ gap: 6 }}>
          <Text style={s.label}>{key.replace(/_/g, " ")}</Text>
          {Array.isArray(value) ? (
            value.slice(0, expanded ? 100 : 5).map((item) => {
              const row = record(item);
              return (
                <View
                  key={`${key}-${display(row?.id ?? item)}`}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                  }}
                >
                  <Text selectable style={s.text}>
                    {row
                      ? Object.entries(row)
                          .map(([name, val]) => `${name}: ${display(val)}`)
                          .join(" · ")
                      : display(item)}
                  </Text>
                </View>
              );
            })
          ) : record(value) ? (
            Object.entries(record(value) || {}).map(([name, val]) => (
              <View key={name} style={s.between}>
                <Text style={s.muted}>{name}</Text>
                <Text selectable style={s.text}>
                  {display(val)}
                </Text>
              </View>
            ))
          ) : (
            <Text selectable style={[s.text, { fontSize: typeof value === "number" ? 24 : 14 }]}>
              {display(value)}
            </Text>
          )}
        </View>
      ))}
      <Button small onPress={() => setExpanded(!expanded)}>
        {expanded ? t.agent.artifact.showSummary : t.agent.artifact.exploreFull}
      </Button>
    </Card>
  );
}
export function DelegateSheet({ goalId, milestoneId }: { goalId?: string; milestoneId?: string }) {
  const { workspace, close, open } = useWorkspace();
  const { data, delegate } = useAgentWorkspace();
  const goal = data?.goals.find((item) => item.id === goalId);
  const milestone = goal?.milestones.find((item) => item.id === milestoneId);
  const submission = useRef<{ input: string; id: string } | null>(null);
  const submitting = useRef(false);
  const [kind, setKind] = useState<AgentTask["kind"]>("plan");
  const [title] = useState(milestone?.title);
  const [prompt, setPrompt] = useState(
    milestone && goal
      ? t.agent.delegate.milestonePrompt(milestone.title, goal.title, goal.description)
      : "",
  );
  const [messageId, setMessageId] = useState("");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const input = {
        title,
        prompt: prompt.trim(),
        kind,
        goalId,
        milestoneId,
        input: kind === "finance" ? { csv } : kind === "document" ? { messageId } : {},
      };
      const serialized = JSON.stringify(input);
      if (submission.current?.input !== serialized)
        submission.current = {
          input: serialized,
          id: `delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
      const task = await delegate(input, submission.current.id);
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={t.agent.delegate.title}
      subtitle={t.agent.delegate.subtitle(t.common.product)}
      onClose={close}
    >
      {milestoneId && (
        <Text style={[s.muted, { marginBottom: 16 }]}>
          {milestone
            ? t.agent.delegate.milestoneNote(goal?.title || "", milestone.title)
            : t.agent.delegate.milestoneMissing}
        </Text>
      )}
      <View style={[s.row, { flexWrap: "wrap", gap: 8, marginBottom: 20 }]}>
        {(["plan", "document", "finance", "agent"] as const).map((item) => (
          <Button small primary={kind === item} key={item} onPress={() => setKind(item)}>
            {statusLabel(item)}
          </Button>
        ))}
      </View>
      <Field
        label={t.agent.delegate.promptLabel}
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder={
          kind === "document"
            ? t.agent.delegate.placeholderDocument
            : kind === "finance"
              ? t.agent.delegate.placeholderFinance
              : t.agent.delegate.placeholderPlan
        }
      />
      {kind === "document" && (
        <View style={{ gap: 8, marginBottom: 18 }}>
          <Text style={s.heading}>{t.agent.delegate.chooseMail}</Text>
          {workspace.mail
            .filter((mail) => mail.attachments.length)
            .map((mail) => (
              <CheckRow
                key={mail.id}
                checked={mail.id === messageId}
                label={`${mail.subject} · ${mail.sender}`}
                onPress={() => setMessageId(mail.id)}
              />
            ))}
          {!workspace.mail.some((mail) => mail.attachments.length) && (
            <Text style={s.muted}>{t.agent.delegate.mailMissing}</Text>
          )}
        </View>
      )}
      {kind === "finance" && (
        <>
          <Field
            label={t.agent.delegate.csvLabel}
            value={csv}
            onChangeText={setCsv}
            multiline
            autoCapitalize="none"
            placeholder={t.agent.delegate.csvPlaceholder}
          />
          {workspace.mode === "sample" && (
            <Button onPress={() => setCsv(t.agent.delegate.csvSample)}>
              {t.agent.delegate.trySample}
            </Button>
          )}
          <Text style={[s.small, { marginVertical: 12 }]}>{t.agent.delegate.csvHint}</Text>
        </>
      )}
      {kind === "agent" && !workspace.runtime.configured && (
        <Text style={[s.muted, { marginBottom: 16 }]}>{t.agent.delegate.modelRequired}</Text>
      )}
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          Boolean(milestoneId && !milestone) ||
          !prompt.trim() ||
          (kind === "document" && !messageId) ||
          (kind === "finance" && !csv.trim())
        }
        onPress={() => void submit()}
      >
        {t.agent.delegate.submit}
      </Button>
    </Sheet>
  );
}
function TaskLink({ taskId, onOpen }: { taskId: string; onOpen?: () => void }) {
  const { open } = useWorkspace();
  return (
    <Button
      small
      icon={ArrowRight}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId });
      }}
    >
      {t.agent.taskLink.view}
    </Button>
  );
}
type GoalCategory = keyof typeof t.agent.goals.categories;
const goalCategories: { id: GoalCategory; icon: typeof Heart }[] = [
  { id: "health", icon: Heart },
  { id: "relationships", icon: Users },
  { id: "finances", icon: CircleDollarSign },
  { id: "other", icon: Target },
];
export function GoalsScreen() {
  const { data } = useAgentWorkspace();
  const [adding, setAdding] = useState<GoalCategory | "tracking">();
  const [selectedGoal, setSelectedGoal] = useState<string>();
  const [selectedMonitor, setSelectedMonitor] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const goal = data?.goals.find((item) => item.id === selectedGoal);
  const monitor = data?.monitors.find((item) => item.id === selectedMonitor);
  const monitors = data?.monitors || [];
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <View style={{ gap: 8 }}>
        <View style={[s.between, { marginBottom: 5 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                borderWidth: 5,
                borderColor: "#D9F1E2",
                backgroundColor: "#24A46B",
              }}
            />
            <Text style={[s.heading, { color: "#189A58" }]}>{t.agent.goals.trackingHeading}</Text>
          </View>
          <Button small icon={Plus} onPress={() => setAdding("tracking")}>
            {t.agent.goals.track}
          </Button>
        </View>
        {(showAll ? monitors : monitors.slice(0, 3)).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={t.agent.goals.openTracking(item.title)}
            onPress={() => setSelectedMonitor(item.id)}
            style={[s.row, { gap: 12, paddingVertical: 13 }]}
          >
            <Square size={21} color="#A7AAAC" />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.text}>{item.title}</Text>
              <Text numberOfLines={1} style={s.muted}>
                {item.status === "active"
                  ? t.agent.goals.checkingEvery(item.intervalMinutes)
                  : statusLabel(item.status)}
              </Text>
            </View>
            <ChevronRight size={18} color="#A3A6A8" />
          </Pressable>
        ))}
        {!monitors.length && (
          <Text style={[s.muted, { paddingVertical: 10 }]}>{t.agent.goals.trackingEmpty}</Text>
        )}
        {monitors.length > 3 && (
          <Button small onPress={() => setShowAll(!showAll)}>
            {showAll ? t.agent.goals.showLess : t.agent.goals.showMore(monitors.length - 3)}
          </Button>
        )}
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <View style={{ gap: 8 }}>
        <View style={[s.row, { gap: 10, marginBottom: 5 }]}>
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              borderWidth: 5,
              borderColor: "#D7E9FA",
              backgroundColor: "#3D9BDE",
            }}
          />
          <Text style={[s.heading, { color: colors.blueDark }]}>{t.agent.goals.goalsHeading}</Text>
        </View>
        {data?.goals.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={t.agent.goals.openGoal(item.title)}
            onPress={() => setSelectedGoal(item.id)}
            style={[s.row, { gap: 12, paddingVertical: 13 }]}
          >
            <Square
              size={21}
              color="#A7AAAC"
              fill={item.status === "completed" ? colors.green : "transparent"}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.text}>{item.title}</Text>
              <Text numberOfLines={2} style={s.muted}>
                {item.description || statusLabel(item.status)}
              </Text>
            </View>
            <ChevronRight size={18} color="#A3A6A8" />
          </Pressable>
        ))}
        {!data?.goals.length && (
          <Text style={[s.muted, { paddingVertical: 10 }]}>{t.agent.goals.goalsEmpty}</Text>
        )}
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <Text style={s.heading}>{t.agent.goals.createHeading}</Text>
      {goalCategories.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={t.agent.goals.createCategory(t.agent.goals.categories[item.id])}
          onPress={() => setAdding(item.id)}
          style={[s.row, { gap: 12, minHeight: 38 }]}
        >
          <item.icon size={23} color="#989C9F" />
          <Text style={[s.text, { flex: 1, color: "#666A6D" }]}>
            {t.agent.goals.categories[item.id]}
          </Text>
          <Plus size={18} color="#989C9F" />
        </Pressable>
      ))}
      {adding && (
        <Sheet
          title={adding === "tracking" ? t.agent.goals.trackSheet : t.agent.goals.createSheet}
          onClose={() => setAdding(undefined)}
        >
          {adding === "tracking" ? (
            <MonitorForm onDone={() => setAdding(undefined)} />
          ) : (
            <GoalForm category={adding} onDone={() => setAdding(undefined)} />
          )}
        </Sheet>
      )}
      {goal && (
        <Sheet title={goal.title} onClose={() => setSelectedGoal(undefined)}>
          <GoalCard goal={goal} onOpenTask={() => setSelectedGoal(undefined)} />
        </Sheet>
      )}
      {monitor && (
        <Sheet title={monitor.title} onClose={() => setSelectedMonitor(undefined)}>
          <MonitorCard monitor={monitor} onOpenTask={() => setSelectedMonitor(undefined)} />
        </Sheet>
      )}
    </View>
  );
}
function GoalForm({ onDone, category }: { onDone: () => void; category?: string }) {
  const { mutate } = useAgentWorkspace();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [milestones, setMilestones] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await mutate("/goals", {
        title: title.trim(),
        category,
        description,
        milestones: milestones
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field
        label={t.agent.goals.form.titleLabel}
        value={title}
        onChangeText={setTitle}
        placeholder={t.agent.goals.form.titlePlaceholder}
      />
      <Field
        label={t.agent.goals.form.descriptionLabel}
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Field
        label={t.agent.goals.form.milestonesLabel}
        value={milestones}
        onChangeText={setMilestones}
        multiline
      />
      <ErrorNotice error={error} />
      <Button primary disabled={!title.trim()} busy={busy} onPress={() => void save()}>
        {t.agent.goals.form.submit}
      </Button>
    </Card>
  );
}
function GoalCard({ goal, onOpenTask }: { goal: Goal; onOpenTask?: () => void }) {
  const { data, mutate, delegate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = goal.milestones.filter((item) => item.done).length;
  async function update(body: unknown, milestoneId?: string) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/goals/${goal.id}${milestoneId ? `/milestones/${milestoneId}` : ""}`, body);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function plan() {
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        title: t.agent.goals.card.planTitle(goal.title),
        prompt: t.agent.goals.card.planPrompt(goal.title, goal.description),
        kind: "plan",
        goalId: goal.id,
        input: {},
      });
      onOpenTask?.();
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{goal.title}</Text>
        <Chip tint={goal.status === "completed" ? colors.green : colors.sky}>
          {statusLabel(goal.status)}
        </Chip>
      </View>
      <Text style={s.muted}>{goal.description}</Text>
      <Text style={s.small}>{t.agent.goals.card.milestones(done, goal.milestones.length)}</Text>
      {goal.milestones.map((milestone) => (
        <View key={milestone.id} style={{ gap: 8 }}>
          <CheckRow
            checked={milestone.done}
            label={milestone.title}
            onPress={() => {
              if (!busy) void update({ done: !milestone.done }, milestone.id);
            }}
          />
          {!milestone.done && (
            <Button
              small
              disabled={goal.status !== "active"}
              onPress={() => {
                onOpenTask?.();
                open({ type: "delegate", goalId: goal.id, milestoneId: milestone.id });
              }}
            >
              {t.agent.goals.card.delegate}
            </Button>
          )}
          {data?.tasks
            .filter((task) => task.goalId === goal.id && task.milestoneId === milestone.id)
            .map((task) => (
              <TaskCard key={task.id} task={task} compact onOpen={onOpenTask} />
            ))}
        </View>
      ))}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          small
          busy={busy}
          onPress={() => void update({ status: goal.status === "active" ? "paused" : "active" })}
        >
          {goal.status === "active" ? t.agent.goals.card.pause : t.agent.goals.card.resume}
        </Button>
        {goal.status !== "completed" && (
          <Button small busy={busy} onPress={() => void update({ status: "completed" })}>
            {t.agent.goals.card.complete}
          </Button>
        )}
        <Button small primary busy={busy} onPress={() => void plan()}>
          {t.agent.goals.card.planNext}
        </Button>
      </View>
      {data?.tasks
        .filter(
          (task) =>
            task.goalId === goal.id &&
            (!task.milestoneId || !goal.milestones.some((m) => m.id === task.milestoneId)),
        )
        .map((task) => (
          <TaskCard key={task.id} task={task} compact onOpen={onOpenTask} />
        ))}
    </Card>
  );
}
function MonitorForm({ onDone }: { onDone: () => void }) {
  const { workspace } = useWorkspace();
  const { mutate } = useAgentWorkspace();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [condition, setCondition] = useState<Monitor["condition"]>("change");
  const [value, setValue] = useState("");
  const [interval, setInterval] = useState("15");
  const [sample, setSample] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError("");
    try {
      const minutes = Number(interval);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
        throw new Error(t.agent.monitors.form.intervalInvalid);
      if (!sample && !/^https?:\/\//i.test(url.trim()))
        throw new Error(t.agent.monitors.form.urlInvalid);
      await mutate("/monitors", {
        title: title.trim(),
        url: sample ? "sample://availability" : url.trim(),
        condition,
        value,
        intervalMinutes: minutes,
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field
        label={t.agent.monitors.form.titleLabel}
        value={title}
        onChangeText={setTitle}
        placeholder={t.agent.monitors.form.titlePlaceholder}
      />
      {workspace.mode === "sample" && (
        <CheckRow
          checked={sample}
          label={t.agent.monitors.form.sampleToggle}
          onPress={() => setSample(!sample)}
        />
      )}
      {!sample && (
        <Field
          label={t.agent.monitors.form.urlLabel}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          placeholder={t.agent.monitors.form.urlPlaceholder}
        />
      )}
      <Text style={[s.small, { marginBottom: 10 }]}>{t.agent.monitors.form.notifyWhen}</Text>
      <View style={[s.row, { gap: 7, flexWrap: "wrap", marginBottom: 16 }]}>
        {(["change", "contains", "price_below"] as const).map((item) => (
          <Button small primary={condition === item} key={item} onPress={() => setCondition(item)}>
            {item === "change"
              ? t.agent.monitors.form.conditionChange
              : item === "contains"
                ? t.agent.monitors.form.conditionContains
                : t.agent.monitors.form.conditionPriceBelow}
          </Button>
        ))}
      </View>
      {condition !== "change" && (
        <Field
          label={
            condition === "contains"
              ? t.agent.monitors.form.textLabel
              : t.agent.monitors.form.priceLabel
          }
          value={value}
          onChangeText={setValue}
        />
      )}
      <Field
        label={t.agent.monitors.form.intervalLabel}
        value={interval}
        onChangeText={setInterval}
        keyboardType="number-pad"
      />
      <Text style={[s.small, { marginBottom: 14 }]}>
        {sample
          ? t.agent.monitors.form.sampleHint
          : t.agent.monitors.form.serverHint(t.common.product)}
      </Text>
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !title.trim() || (!sample && !url.trim()) || (condition !== "change" && !value.trim())
        }
        onPress={() => void save()}
      >
        {t.agent.monitors.form.submit}
      </Button>
    </Card>
  );
}
function MonitorCard({ monitor, onOpenTask }: { monitor: Monitor; onOpenTask?: () => void }) {
  const { mutate } = useAgentWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/monitors/${monitor.id}/control`, { action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeSample() {
    setBusy(true);
    setError("");
    try {
      await mutate("/sample-page", {
        text: t.agent.monitors.card.sampleText(new Date().toISOString()),
      });
      await mutate(`/monitors/${monitor.id}/control`, { action: "check" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 13 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{monitor.title}</Text>
        <Chip tint={colors.sky}>{statusLabel(monitor.status)}</Chip>
      </View>
      <Text selectable style={s.small}>
        {monitor.url.startsWith("sample:") ? t.agent.monitors.card.samplePage : monitor.url}
      </Text>
      <Text style={s.text}>
        {monitor.condition === "change"
          ? t.agent.monitors.card.watchChange
          : monitor.condition === "contains"
            ? t.agent.monitors.card.watchContains(monitor.value)
            : t.agent.monitors.card.priceBelow(monitor.value)}
      </Text>
      <Text style={s.small}>
        {t.agent.monitors.card.schedule(monitor.intervalMinutes, monitor.checks)}
      </Text>
      <Text style={s.small}>
        {t.agent.monitors.card.lastCheck(stamp(monitor.lastCheckedAt))}
        {monitor.status === "active"
          ? `\n${t.agent.monitors.card.nextCheck(stamp(monitor.nextCheckAt))}`
          : ""}
      </Text>
      {!!monitor.lastValue && (
        <Text selectable numberOfLines={5} style={s.muted}>
          {monitor.lastValue}
        </Text>
      )}
      <ErrorNotice error={error || monitor.error} />
      {monitor.status !== "stopped" && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            small
            busy={busy}
            onPress={() => void act(monitor.status === "active" ? "pause" : "resume")}
          >
            {monitor.status === "active"
              ? t.agent.monitors.card.pause
              : t.agent.monitors.card.resume}
          </Button>
          <Button small busy={busy} onPress={() => void act("check")}>
            {t.agent.monitors.card.checkNow}
          </Button>
          <Button small danger busy={busy} onPress={() => void act("stop")}>
            {t.agent.monitors.card.stop}
          </Button>
        </View>
      )}
      {monitor.url.startsWith("sample:") && monitor.status !== "stopped" && (
        <Button small busy={busy} onPress={() => void changeSample()}>
          {t.agent.monitors.card.changeSample}
        </Button>
      )}
      <TaskLink taskId={monitor.taskId} onOpen={onOpenTask} />
    </Card>
  );
}
export function NotificationsSheet() {
  const { data, mutate } = useAgentWorkspace();
  const { close, open } = useWorkspace();
  const [error, setError] = useState("");
  async function read(id: string, taskId?: string) {
    try {
      await mutate(`/notifications/${id}/read`, {});
      if (taskId) open({ type: "task", taskId });
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Sheet
      title={t.agent.notifications.title}
      subtitle={t.agent.notifications.subtitle}
      onClose={close}
    >
      <View style={{ gap: 14 }}>
        <ErrorNotice error={error} />
        {data?.notifications.map((item) => (
          <Card
            key={item.id}
            style={{ gap: 8, backgroundColor: item.read ? colors.card : colors.sky }}
          >
            <View style={s.between}>
              <Text style={s.heading}>{item.title}</Text>
              {!item.read && <Chip>{t.agent.notifications.newChip}</Chip>}
            </View>
            <Text style={s.muted}>{item.body}</Text>
            <Text style={s.small}>{stamp(item.createdAt)}</Text>
            <Button small onPress={() => void read(item.id, item.taskId)}>
              {item.taskId
                ? t.agent.notifications.viewTask
                : item.read
                  ? t.agent.notifications.read
                  : t.agent.notifications.markRead}
            </Button>
          </Card>
        ))}
        {!data?.notifications.length && (
          <Empty
            icon={Bell}
            title={t.agent.notifications.emptyTitle}
            detail={t.agent.notifications.emptyDetail}
          />
        )}
      </View>
    </Sheet>
  );
}
export function AppsScreen() {
  const { data, mutate } = useAgentWorkspace();
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState(data?.identity.name || t.common.agentName);
  const [tone, setTone] = useState(data?.identity.tone || "warm");
  const [avatar, setAvatar] = useState(data?.identity.avatar || "sky");
  const [showChatUpdates, setShowChatUpdates] = useState(data?.identity.showChatUpdates !== false);
  const [memory, setMemory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.identity) {
      setName(data.identity.name);
      setTone(data.identity.tone);
      setAvatar(data.identity.avatar || "sky");
      setShowChatUpdates(data.identity.showChatUpdates !== false);
    }
  }, [
    data?.identity.name,
    data?.identity.tone,
    data?.identity.avatar,
    data?.identity.showChatUpdates,
  ]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(path, body);
      if (path === "/memories") setMemory("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <Field
        label={t.agent.apps.searchLabel}
        value={query}
        onChangeText={setQuery}
        placeholder={t.agent.apps.searchPlaceholder}
      />
      <ConnectionsScreen query={query} />
      <Button onPress={() => setSettings(!settings)}>
        {settings ? t.agent.apps.closeSettings : t.agent.apps.personality}
      </Button>
      {settings && (
        <>
          <Card style={{ gap: 10 }}>
            <SectionHeading title={t.agent.apps.yourAgent} />
            <View style={[s.row, { gap: 16, justifyContent: "center", marginBottom: 12 }]}>
              {(["sky", "sand", "lilac"] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityLabel={t.agent.apps.avatarLabel(t.agent.apps.avatars[item])}
                  accessibilityState={{ checked: avatar === item }}
                  onPress={() => setAvatar(item)}
                  style={{
                    padding: 7,
                    borderRadius: 24,
                    backgroundColor: avatar === item ? colors.sky : colors.canvas,
                  }}
                >
                  <Mascot size={62} variant={item} />
                </Pressable>
              ))}
            </View>
            <Field label={t.agent.apps.nameLabel} value={name} onChangeText={setName} />
            <View style={[s.row, { gap: 8 }]}>
              {(["warm", "concise", "thoughtful"] as const).map((item) => (
                <Button key={item} small primary={tone === item} onPress={() => setTone(item)}>
                  {t.agent.apps.tones[item]}
                </Button>
              ))}
            </View>
            <CheckRow
              label={t.agent.apps.showChatUpdates}
              checked={showChatUpdates}
              onPress={() => setShowChatUpdates(!showChatUpdates)}
            />
            <Text style={s.small}>{t.agent.apps.recordHint}</Text>
            <Button
              busy={busy}
              disabled={!name.trim()}
              onPress={() =>
                void save("/identity", { name: name.trim(), tone, avatar, showChatUpdates })
              }
            >
              {t.agent.apps.savePreferences}
            </Button>
          </Card>
          <Card style={{ gap: 12 }}>
            <SectionHeading title={t.agent.apps.memoryHeading} />
            <Text style={s.muted}>{t.agent.apps.memoryHint}</Text>
            {data?.memories.map((item) => (
              <MemoryRow key={item.id} memory={item} />
            ))}
            <Field
              label={t.agent.apps.rememberLabel}
              value={memory}
              onChangeText={setMemory}
              placeholder={t.agent.apps.rememberPlaceholder}
            />
            <Button
              busy={busy}
              disabled={!memory.trim()}
              onPress={() =>
                void save("/memories", { text: memory.trim(), source: t.agent.apps.memorySource })
              }
            >
              {t.agent.apps.remember}
            </Button>
          </Card>
        </>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
function MemoryRow({ memory }: { memory: AgentMemory }) {
  const { mutate } = useAgentWorkspace();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(forget: boolean) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/memories/${memory.id}${forget ? "/forget" : ""}`, forget ? {} : { text });
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      {editing ? (
        <Field label={t.agent.memoryRow.label} value={text} onChangeText={setText} />
      ) : (
        <Text style={s.text}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {memory.source} · {stamp(memory.createdAt)}
      </Text>
      <View style={[s.row, { gap: 8 }]}>
        {editing ? (
          <Button small busy={busy} disabled={!text.trim()} onPress={() => void act(false)}>
            {t.agent.memoryRow.saveCorrection}
          </Button>
        ) : (
          <Button small onPress={() => setEditing(true)}>
            {t.common.edit}
          </Button>
        )}
        <Button small danger busy={busy} onPress={() => void act(true)}>
          {t.agent.memoryRow.forget}
        </Button>
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
