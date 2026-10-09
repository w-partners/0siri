import {
  type Message,
  type ToolMessage,
  useAgent,
  useAgentContext,
  useCopilotKit,
  useRenderTool,
  useRenderToolCall,
} from "@copilotkit/react-native/headless";
import { ArrowDown, ArrowUp, FileText, RotateCcw, Square, X } from "lucide-react-native";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextStyle,
  View,
} from "react-native";
import { z } from "zod";
import { ArtifactCard } from "./agent-ui";
import { useAgentWorkspace } from "./agent-workspace";
import { AssistantResponse } from "./assistant-response";
import { BackgroundUpdates } from "./background-updates";
import { ConversationQueue, type QueuedMessage } from "./conversation-queue";
import {
  ConversationTurnError,
  replayedRunError,
  runConversationTurn,
  showsRunError,
  threadLocked,
} from "./conversation-run";
import type { Mood } from "./osiri/eve";
import { SearchToolCard } from "./search-tool-card";
import { t } from "./strings";
import { TaskThreadCard } from "./thread-artifacts";
import { type Selection, useMuseThread } from "./threads";
import { Button, Card, CheckRow, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const displayParameters = z.record(z.string(), z.unknown());
// The composer pill shows focus with its border, so the browser's ring inside it is noise.
// Chrome draws `outline-style: auto` at any width, so only `none` removes it; React Native's
// types omit that value, but react-native-web passes it through.
const noFocusRing =
  Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : undefined;
export function WorkspaceTools() {
  const { workspace, section } = useWorkspace();
  useAgentContext({
    description: t.chat.context.screen,
    value: { section, mode: workspace.mode },
  });
  useRenderTool({
    name: "search_web",
    description: t.tools.render.searchWeb,
    parameters: displayParameters,
    render: ({ result, status }) => (
      <SearchToolCard result={result} loading={status !== "complete"} />
    ),
  });
  useRenderTool({
    name: "delegate_task",
    description: t.tools.render.delegateTask,
    parameters: displayParameters,
    render: ({ result, status }) => (
      <ServerToolCard
        name={t.tools.cards.task}
        target="activity"
        result={result}
        loading={status !== "complete"}
      />
    ),
  });
  useRenderTool({
    name: "agent_status",
    description: t.tools.render.agentStatus,
    parameters: displayParameters,
    render: ({ result, status }) => (
      <ServerToolCard
        name={t.tools.cards.agentProgress}
        target="activity"
        result={result}
        loading={status !== "complete"}
      />
    ),
  });
  useRenderTool({
    name: "create_goal",
    description: t.tools.render.createGoal,
    parameters: displayParameters,
    render: ({ result, status }) => (
      <ServerToolCard
        name={t.tools.cards.goal}
        target="goals"
        result={result}
        loading={status !== "complete"}
      />
    ),
  });
  useRenderTool({
    name: "watch_page",
    description: t.tools.render.watchPage,
    parameters: displayParameters,
    render: ({ result, status }) => (
      <ServerToolCard
        name={t.tools.cards.tracking}
        target="goals"
        result={result}
        loading={status !== "complete"}
      />
    ),
  });
  useRenderTool({
    name: "remember_fact",
    description: t.tools.render.rememberFact,
    parameters: displayParameters,
    render: ({ result, status }) => (
      <ServerToolCard
        name={t.tools.cards.memory}
        target="apps"
        result={result}
        loading={status !== "complete"}
      />
    ),
  });
  return null;
}
function ServerToolCard({
  name,
  target,
  result,
  loading,
}: {
  name: string;
  /** Workspace section that shows the saved result; the translated name no longer encodes it. */
  target: "goals" | "apps" | "activity";
  result: unknown;
  loading: boolean;
}) {
  const { data } = useAgentWorkspace();
  const { navigate } = useWorkspace();
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const parsed = z
    .object({
      id: z.string().optional(),
      taskId: z.string().optional(),
      error: z.string().optional(),
    })
    .safeParse(value);
  const task = parsed.success
    ? data?.tasks.find((item) => item.id === parsed.data.id || item.id === parsed.data.taskId)
    : undefined;
  if (task) return <TaskThreadCard task={task} />;
  return (
    <Card style={{ padding: 16, gap: 10 }}>
      <Text style={s.heading}>{loading ? t.tools.card.saving(name) : name}</Text>
      {parsed.success && parsed.data.error ? (
        <ErrorNotice error={parsed.data.error} />
      ) : (
        <Text style={s.muted}>{loading ? t.tools.card.waiting : t.tools.card.saved}</Text>
      )}
      <Button small onPress={() => navigate(target)}>
        {t.tools.card.view(name)}
      </Button>
    </Card>
  );
}
export function ChatScreen({
  prompt,
  thread,
  active = true,
  roomId,
  onMood,
  header,
  footer,
  placeholder,
  answerLabel,
}: {
  prompt?: { id: number; text: string };
  thread?: Selection;
  active?: boolean;
  /** 0Siri 팀 채팅방: 방 id 가 곧 스레드 id (대화 이력은 /api/conversation?threadId=). */
  roomId?: string;
  /** 0Siri 캐릭터 애니메이션용 — 입력 중·생각 중·말하는 중 (영시리 EVE 가 듣는다) */
  onMood?: (mood: Mood) => void;
  /** 0Siri 팀 방: 승인·보고 카드를 같은 대화 흐름 맨 위에 싣는다(기획 화면 3 — 대화 하나에 카드 인라인). */
  header?: ReactNode;
  /** 대화 끝(가장 최근 자리)에 붙는 카드 — 지금 결정해야 하는 승인 카드 */
  footer?: ReactNode;
  placeholder?: string;
  /** 답변마다 «누가 답했는지» 한 줄 (기기에서 답함 · 서버 주력 · 기억에서 찾음). 모르면 undefined. */
  answerLabel?: (messageId: string) => string | undefined;
}) {
  const { api, workspace: w, refresh, navigate } = useWorkspace();
  const { data: agentWorkspace, refresh: refreshAgent } = useAgentWorkspace();
  const { enabled: richThreads, mainId, claimPrompt } = useMuseThread();
  const selection = thread || { id: "local", existing: false };
  const threadId = roomId ?? (richThreads ? selection.id : "local-main");
  const agentId = roomId ? `osiri-${roomId}` : `openmuse-${threadId}`;
  const conversationPath = roomId ? `/api/conversation?threadId=${roomId}` : "/api/conversation";
  const { agent, isReady } = useAgent({ agentId, runtimeAgentId: "default", threadId });
  const { copilotkit } = useCopilotKit();
  const renderToolCall = useRenderToolCall();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [inputHeight, setInputHeight] = useState(44);
  const [showResults, setShowResults] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Replayed messages show before connectAgent returns; new turns wait until it does.
  const [syncing, setSyncing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const list = useRef<ScrollView>(null);
  const [queue] = useState(() => new ConversationQueue());
  const outbox = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const runLock = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  // Loads still replaying history. A count, so an old load finishing does not end a newer one.
  const replaying = useRef(0);
  // Set while a queued message is being sent, so a lock refusal holds it instead of failing.
  const queuedTurn = useRef(false);
  const [keyboardPadding, setKeyboardPadding] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const onShow = (e: { endCoordinates: { height: number } }) => {
      const bottomNavHeight = 74;
      setKeyboardPadding(Math.max(0, e.endCoordinates.height - bottomNavHeight));
    };
    const onHide = () => setKeyboardPadding(0);
    const showSub = Keyboard.addListener("keyboardDidShow", onShow);
    const hideSub = Keyboard.addListener("keyboardDidHide", onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    setHistoryError("");
    setLoaded(false);
    setSyncing(false);
    const replay = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (active && richThreads && messages.length) setLoaded(true);
      },
    });
    async function hydrate() {
      try {
        if (richThreads) {
          if (selection.existing) {
            // Replaying history re-emits past RUN_ERROR events; only connection failures block loading.
            // connectAgent returns once the thread is idle, so it also waits for a reply still
            // running from before a reload. Sending earlier fails with a thread lock.
            replaying.current += 1;
            setSyncing(true);
            try {
              await runConversationTurn(
                agentId,
                () => copilotkit.connectAgent({ agent }),
                (onError) => copilotkit.subscribe({ onError }),
                [replayedRunError],
              );
            } finally {
              replaying.current -= 1;
              if (active) setSyncing(false);
            }
          }
        } else {
          const { messages } = await api.request<{ messages: Message[] }>(conversationPath);
          if (active) agent.setMessages(messages);
        }
        if (active) setLoaded(true);
      } catch (e) {
        if (active) {
          setLoaded(false);
          setHistoryError(t.chat.history.loadFailed(e instanceof Error ? e.message : String(e)));
        }
      }
    }
    void hydrate();
    return () => {
      active = false;
      replay.unsubscribe();
      if (richThreads) void agent.detachActiveRun().catch(() => {});
    };
  }, [
    agent,
    agentId,
    api,
    conversationPath,
    copilotkit,
    isReady,
    historyAttempt,
    richThreads,
    selection.existing,
  ]);
  const saveHistory = useCallback(async () => {
    if (!richThreads) await api.request(conversationPath, { messages: agent.messages }, "PUT");
    setSaveError("");
  }, [agent, api, conversationPath, richThreads]);
  /** Runs one turn; "held" means a queued message was refused by a lock and put back on hold. */
  const run = useCallback(
    async (message?: QueuedMessage): Promise<"held" | undefined> => {
      if (runLock.current || agent.isRunning || !isReady || !loaded || syncing)
        throw new Error(t.chat.errors.notReady);
      runLock.current = true;
      queuedTurn.current = Boolean(message);
      setBusy(true);
      setError("");
      if (message) agent.addMessage({ id: message.id, role: "user", content: message.text });
      try {
        await runConversationTurn(
          agentId,
          () => copilotkit.runAgent({ agent }),
          (onError) => copilotkit.subscribe({ onError }),
        );
        await Promise.all([refresh(), refreshAgent()]);
      } catch (e) {
        if (message && e instanceof ConversationTurnError && e.code === threadLocked) {
          // The server refused the turn before running it (another reply holds the thread),
          // so keep the message unsent and on hold instead of reporting a failed turn.
          agent.setMessages(agent.messages.filter((m) => m.id !== message.id));
          queue.restore(message);
          queue.pause();
          return "held";
        }
        throw e;
      } finally {
        queuedTurn.current = false;
        try {
          await saveHistory();
        } catch (e) {
          queue.pause();
          setSaveError(t.chat.history.saveFailed(e instanceof Error ? e.message : String(e)));
        } finally {
          runLock.current = false;
          setBusy(false);
        }
      }
    },
    [
      agent,
      agentId,
      copilotkit,
      isReady,
      loaded,
      syncing,
      refresh,
      refreshAgent,
      saveHistory,
      queue,
    ],
  );
  const runQueued = useCallback(
    async (message: QueuedMessage) => {
      await run(message);
    },
    [run],
  );
  const flush = useCallback(() => {
    if (!loaded || syncing || !isReady || runLock.current || agent.isRunning) return;
    void queue.flush(runQueued).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [agent, isReady, loaded, syncing, queue, runQueued]);
  const enqueue = useCallback(
    (text: string) => {
      queue.enqueue({ id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text });
      followLatest.current = true;
      setAwayFromLatest(false);
      flush();
    },
    [queue, flush],
  );
  useEffect(() => {
    if (!busy && !agent.isRunning && outbox.pending.length) flush();
  }, [busy, agent.isRunning, outbox.pending.length, flush]);
  useEffect(() => {
    if (active && prompt && isReady && loaded && claimPrompt(prompt.id) && prompt.text.trim())
      enqueue(prompt.text);
  }, [active, prompt, isReady, loaded, enqueue, claimPrompt]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: (event) => {
        if (event.context?.agentId && event.context.agentId !== agentId) return;
        const during = { replaying: replaying.current > 0, queuedTurn: queuedTurn.current };
        if (!showsRunError(event, during)) return;
        const failure = event.error instanceof Error ? event.error : new Error(String(event.error));
        setError(failure.message);
      },
    });
    return () => subscription.unsubscribe();
  }, [copilotkit, agentId, queue]);
  async function stop() {
    queue.pause();
    try {
      await copilotkit.stopAgent({ agent });
    } catch (e) {
      setError(t.chat.errors.stopFailed(e instanceof Error ? e.message : String(e)));
    }
  }
  function send() {
    const text = draft.trim();
    if (!text || !isReady || !loaded) return;
    // A new submission can continue after Stop; held follow-ups still need explicit resume.
    if (!busy && !agent.isRunning && !saveError && !queue.getSnapshot().pending.length)
      queue.resume();
    setShowResults(false);
    const files = w.files.filter((f) => attachments.includes(f.id));
    enqueue(
      text +
        (files.length
          ? t.chat.attach.marker(files.map((f) => t.chat.attach.item(f.name, f.id)).join(", "))
          : ""),
    );
    setDraft("");
    setInputHeight(44);
    setAttachments([]);
    setPicking(false);
  }
  const messages = agent.messages || [];
  const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const replying = busy || agent.isRunning;
  // 기분: 답이 흘러나오는 중이면 speaking, 그 전까지는 thinking, 사용자가 쓰는 중이면 listening
  const last = visible.at(-1) as { role: string; content?: string } | undefined;
  const mood: Mood = replying
    ? last?.role === "assistant" && last.content
      ? "speaking"
      : "thinking"
    : focused || draft
      ? "listening"
      : "idle";
  useEffect(() => onMood?.(mood), [mood, onMood]);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={list}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 13, paddingTop: 15, paddingBottom: 20, flexGrow: 1 }}
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          const nearEnd = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
          followLatest.current = nearEnd;
          setAwayFromLatest(visible.length > 0 && !nearEnd);
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (active && (visible.length > 0 || !!footer) && followLatest.current)
            list.current?.scrollToEnd({ animated: false });
        }}
        keyboardShouldPersistTaps="handled"
      >
        {header}
        {!!historyError && (
          <>
            <ErrorNotice error={historyError} />
            <Button onPress={() => setHistoryAttempt((attempt) => attempt + 1)}>
              {t.chat.history.retryLoad}
            </Button>
          </>
        )}
        {!visible.length ? (
          <View
            style={{
              flexGrow: 1,
              flexShrink: 0,
              justifyContent: "center",
              alignItems: "center",
              paddingVertical: 34,
              gap: 15,
            }}
          >
            <Text
              style={{
                fontSize: 28,
                letterSpacing: -1,
                color: colors.text,
                textAlign: "center",
                maxWidth: 350,
              }}
            >
              {t.chat.empty.title}
            </Text>
            <Text style={[s.muted, { maxWidth: 320, textAlign: "center", lineHeight: 23 }]}>
              {t.chat.empty.subtitle}
            </Text>
            <View style={{ width: "100%", maxWidth: 360, marginTop: 14, gap: 8 }}>
              {[
                {
                  text: t.chat.empty.suggestions.plan.label,
                  action: () => enqueue(t.chat.empty.suggestions.plan.prompt),
                },
                {
                  text: t.chat.empty.suggestions.summarize.label,
                  action: () => enqueue(t.chat.empty.suggestions.summarize.prompt),
                },
                { text: t.chat.empty.suggestions.goal.label, action: () => navigate("goals") },
              ].map((item) => (
                <Button key={item.text} onPress={item.action}>
                  {item.text}
                </Button>
              ))}
            </View>
          </View>
        ) : (
          visible.map((message) => {
            const user = message.role === "user";
            const text = typeof message.content === "string" ? message.content : "";
            const toolCalls = "toolCalls" in message ? message.toolCalls || [] : [];
            return (
              <View
                key={message.id}
                style={{
                  alignSelf: user ? "flex-end" : "flex-start",
                  maxWidth: user ? "85%" : "95%",
                  width: toolCalls.length ? "95%" : undefined,
                  gap: 8,
                }}
              >
                {!!text && (
                  <View
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 13,
                      borderRadius: 22,
                      borderBottomRightRadius: user ? 7 : 22,
                      borderBottomLeftRadius: user ? 22 : 7,
                      backgroundColor: user ? colors.accentSoft : colors.sunk,
                    }}
                  >
                    {user ? (
                      <Text selectable style={[s.text, { fontSize: 16, lineHeight: 24 }]}>
                        {text}
                      </Text>
                    ) : (
                      <AssistantResponse content={text} />
                    )}
                  </View>
                )}
                {!user && !!text && !!answerLabel?.(message.id) && (
                  <Text style={[s.small, { marginLeft: 6 }]}>{answerLabel(message.id)}</Text>
                )}
                {toolCalls.map((toolCall) => {
                  const toolMessage = messages.find(
                    (candidate): candidate is ToolMessage =>
                      candidate.role === "tool" && candidate.toolCallId === toolCall.id,
                  );
                  return <View key={toolCall.id}>{renderToolCall({ toolCall, toolMessage })}</View>;
                })}
              </View>
            );
          })
        )}
        {footer}
        {!richThreads && (
          <>
            {!!agentWorkspace?.artifacts.length && (
              <Button
                small
                style={{ alignSelf: "flex-start", marginTop: 6 }}
                onPress={() => setShowResults(!showResults)}
              >
                {showResults ? t.chat.results.hide : t.chat.results.show}
              </Button>
            )}
            {showResults &&
              [...(agentWorkspace?.artifacts || [])]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .filter(
                  (artifact, index, items) =>
                    items.findIndex((item) => item.kind === artifact.kind) === index,
                )
                .slice(0, 2)
                .reverse()
                .map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
          </>
        )}
        {(!richThreads || selection.id === mainId) && <BackgroundUpdates />}
        {(busy || agent.isRunning) && (
          <View
            accessibilityLabel={t.chat.status.working}
            style={[
              s.row,
              {
                alignSelf: "flex-start",
                gap: 7,
                paddingHorizontal: 19,
                paddingVertical: 18,
                backgroundColor: colors.sunk,
                borderRadius: 28,
              },
            ]}
          >
            {[0.4, 0.75, 0.5].map((opacity) => (
              <View
                key={opacity}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: colors.muted,
                  opacity,
                }}
              />
            ))}
          </View>
        )}
        <ErrorNotice error={error} />
        {!!error && (
          <Button
            style={{ alignSelf: "flex-start" }}
            icon={RotateCcw}
            disabled={busy || agent.isRunning || !loaded || syncing || !isReady}
            onPress={() => {
              void run()
                .then(() => {
                  if (!queue.getSnapshot().paused) flush();
                })
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {t.chat.errors.retryResponse}
          </Button>
        )}
      </ScrollView>
      {awayFromLatest && (
        <Button
          small
          icon={ArrowDown}
          style={{ alignSelf: "center", marginBottom: 10 }}
          onPress={() => {
            followLatest.current = true;
            setAwayFromLatest(false);
            list.current?.scrollToEnd({ animated: true });
          }}
        >
          {t.chat.scroll.latest}
        </Button>
      )}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={keyboardPadding > 0 ? { paddingBottom: keyboardPadding } : undefined}
      >
        <ErrorNotice error={saveError} />
        {!!saveError && (
          <Button
            small
            disabled={busy}
            onPress={() => {
              void saveHistory().catch((e) => setSaveError(String(e)));
            }}
          >
            {t.chat.history.retrySave}
          </Button>
        )}
        {!!outbox.pending.length && (
          <View style={{ padding: 12, gap: 6 }}>
            <Text style={s.small}>
              {outbox.paused ? t.chat.queue.onHold : t.chat.queue.upNext} · {t.chat.queue.keepOpen}
            </Text>
            {outbox.pending.map((message) => (
              <View key={message.id} style={[s.row, { gap: 8 }]}>
                <Text numberOfLines={2} style={[s.muted, { flex: 1 }]}>
                  {message.text}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.chat.queue.remove(message.text)}
                  hitSlop={10}
                  onPress={() => queue.remove(message.id)}
                  style={{ padding: 8 }}
                >
                  <X size={16} color={colors.muted} />
                </Pressable>
              </View>
            ))}
            {outbox.paused && (
              <Button
                small
                disabled={busy || !!saveError}
                onPress={() => {
                  queue.resume();
                  flush();
                }}
              >
                {t.chat.queue.sendAll}
              </Button>
            )}
          </View>
        )}
        {picking && (
          <Card style={{ marginBottom: 12, padding: 15 }}>
            <Text style={s.heading}>{t.chat.attach.title}</Text>
            <ScrollView style={{ maxHeight: 230 }} keyboardShouldPersistTaps="handled">
              {w.files.length ? (
                w.files.map((f) => (
                  <CheckRow
                    key={f.id}
                    checked={attachments.includes(f.id)}
                    label={f.name}
                    onPress={() =>
                      setAttachments(
                        attachments.includes(f.id)
                          ? attachments.filter((id) => id !== f.id)
                          : [...attachments, f.id],
                      )
                    }
                  />
                ))
              ) : (
                <Text style={s.muted}>{t.chat.attach.empty}</Text>
              )}
            </ScrollView>
            <Button
              small
              onPress={() => setPicking(false)}
              style={{ alignSelf: "flex-end", marginTop: 8 }}
            >
              {t.common.done}
            </Button>
          </Card>
        )}
        <View
          style={{
            backgroundColor: colors.card,
            borderRadius: 32,
            borderWidth: 1,
            borderColor: focused ? colors.accent : colors.line,
            padding: 8,
            shadowColor: colors.text,
            shadowOpacity: focused ? 0.1 : 0.06,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 4 },
            elevation: 4,
          }}
        >
          {attachments.length > 0 && (
            <View style={[s.row, { gap: 6, flexWrap: "wrap", padding: 9 }]}>
              {w.files
                .filter((f) => attachments.includes(f.id))
                .map((f) => (
                  <Pressable
                    key={f.id}
                    accessibilityRole="button"
                    accessibilityLabel={t.chat.attach.remove(f.name)}
                    onPress={() => setAttachments((ids) => ids.filter((id) => id !== f.id))}
                    style={[
                      s.row,
                      {
                        gap: 7,
                        maxWidth: "100%",
                        backgroundColor: colors.sky,
                        borderRadius: 16,
                        paddingHorizontal: 11,
                        paddingVertical: 8,
                      },
                    ]}
                  >
                    <FileText size={14} color={colors.blueDark} />
                    <Text
                      numberOfLines={1}
                      style={{ flexShrink: 1, fontSize: 12, color: colors.text }}
                    >
                      {f.name}
                    </Text>
                    <X size={13} color={colors.muted} />
                  </Pressable>
                ))}
            </View>
          )}
          <View style={[s.row, { gap: 7, alignItems: "flex-end" }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.chat.attach.button}
              accessibilityState={{ expanded: picking }}
              onPress={() => setPicking(!picking)}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 24,
                backgroundColor: picking || pressed ? colors.sky : "transparent",
              })}
            >
              <Text style={{ color: colors.text, fontSize: 29, fontWeight: "300", lineHeight: 32 }}>
                +
              </Text>
            </Pressable>
            <TextInput
              accessibilityLabel={t.chat.composer.inputLabel}
              value={draft}
              onChangeText={setDraft}
              onContentSizeChange={(event) =>
                setInputHeight(Math.max(44, Math.min(140, event.nativeEvent.contentSize.height)))
              }
              placeholder={
                !isReady
                  ? t.chat.composer.connecting
                  : !loaded
                    ? historyError
                      ? t.chat.composer.unavailable
                      : t.chat.composer.loading
                    : (placeholder ?? t.chat.composer.placeholder)
              }
              placeholderTextColor={colors.muted}
              selectionColor={colors.blueDark}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                flex: 1,
                color: colors.text,
                height: inputHeight,
                minHeight: 44,
                maxHeight: 140,
                fontSize: 17,
                lineHeight: 24,
                paddingHorizontal: 2,
                paddingTop: 10,
                paddingBottom: 10,
                ...noFocusRing,
              }}
              multiline
              editable
              onKeyPress={
                Platform.OS === "web"
                  ? (event) => {
                      if (
                        event.nativeEvent.key === "Enter" &&
                        !("shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey)
                      ) {
                        event.preventDefault();
                        send();
                      }
                    }
                  : undefined
              }
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={replying ? t.chat.composer.stop : t.chat.composer.send}
              disabled={!replying && (!draft.trim() || !loaded || !isReady)}
              onPress={replying ? () => void stop() : send}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 24,
                backgroundColor: replying || draft.trim() ? colors.accent : colors.sunk,
                alignItems: "center",
                justifyContent: "center",
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              {replying ? (
                <Square size={18} fill={colors.onAccent} strokeWidth={0} />
              ) : (
                <ArrowUp
                  size={25}
                  strokeWidth={1.8}
                  color={draft.trim() ? colors.onAccent : colors.muted}
                />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
