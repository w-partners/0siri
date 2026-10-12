// 단체 톡 화면 — 목록(메뉴 안) · 대화 · 멤버(초대·닉네임·나가기). 서버 osiri/groups.ts 가 정본.
// ponytail: 새 메시지는 3초마다 after=seq 로 묻는다(서버 주석과 같은 상한).

import * as Clipboard from "expo-clipboard";
import { ArrowLeft, Bot, MessagesSquare, Users } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  GROUP_BOT_TRIGGER_LABELS,
  GROUP_BOT_TRIGGERS,
  GROUP_NICKNAME_MAX,
  GROUP_TEXT_MAX,
  GROUP_TITLE_MAX,
  type GroupBotTrigger,
} from "../../../../packages/domain/src/osiri";
import type { GroupBot, TeamTools } from "../../../server/src/osiri/bots.ts";
import type { Group, GroupMessage } from "../../../server/src/osiri/groups.ts";
import { Button, colors, ErrorNotice, Field, IconButton, Sheet, s, useAction } from "../ui";
import { useWorkspace } from "../workspace";
import { stampLabel } from "./message-actions";
import { useLoad } from "./store";

export type GroupView = Group & { mine: boolean };
const POLL_MS = 3000;
const text = {
  title: "단체 톡",
  create: "새 단체 톡",
  name: "방 이름",
  make: "만들기",
  cancel: "취소",
  members: (n: number) => `멤버 ${n}명`,
  owner: "방장",
  me: "나",
  invite: "번호로 초대",
  phone: "전화번호",
  nickname: "이 방에서 부를 이름",
  send: "보내기",
  placeholder: "메시지",
  joined: (hint: string) => `${hint} 님이 들어왔습니다`,
  pending: (hint: string) =>
    `${hint} 은(는) 아직 회원이 아닙니다. 아래 가입 링크를 보내 주세요 — 가입하면 이 방에 들어옵니다.`,
  pendingNoLink: (hint: string) =>
    `${hint} 은(는) 다른 회원이 이미 가입 초대를 보낸 번호입니다. 그 링크로 가입하면 이 방에 들어옵니다.`,
  copyLink: "링크 복사",
  copied: "복사했습니다",
  myNickname: "내 닉네임",
  save: "저장",
  remove: "내보내기",
  leave: "이 방 나가기",
  back: "뒤로",
  empty: "아직 대화가 없어요",
  bots: "봇",
  noBots: "아직 봇이 없어요",
  addBot: "봇 만들기",
  removeBot: "빼기",
  noTeams:
    "구독 중인 에이전트 팀이 없어요 — 스토어에서 팀을 구독하면 그 팀의 도구로 봇을 만들 수 있어요",
  pickTeam: "어느 팀의 도구로 만들까요",
  noTools: "이 팀은 봇으로 쓸 도구를 열어 두지 않았어요(팀 YAML x-osiri-tools)",
  pickTool: "도구",
  botName: "봇 이름",
  trigger: "언제 움직일까요",
  triggerValue: {
    keyword: "이 단어가 들어간 말에",
    command: "명령어",
    cron: "크론(분 시 일 월 요일, 서울 시각)",
  },
  triggerExample: { keyword: "티타임", command: "/티타임", cron: "0 9 * * 1" },
  args: "도구 인자(JSON) — 글자 값의 {text} 는 명령어 뒤 글·그 말 전체로 바뀝니다",
  badArgs: "도구 인자가 JSON 이 아닙니다",
  makeBot: "봇 넣기",
};

/** 메뉴의 단체 톡 목록 + 만들기 */
export function GroupList({
  onOpen,
  activeId,
}: {
  onOpen: (g: GroupView) => void;
  activeId?: string;
}) {
  const { api } = useWorkspace();
  const list = useLoad(() => api.request<GroupView[]>("/api/groups"));
  const [making, setMaking] = useState(false);
  const [title, setTitle] = useState("");
  const make = useAction();
  return (
    <View style={{ gap: 6, marginTop: 10 }}>
      <View style={[s.row, { gap: 6 }]}>
        <MessagesSquare size={14} color={colors.muted} />
        <Text style={s.label}>{text.title}</Text>
      </View>
      <ErrorNotice error={list.error} />
      {list.data?.map((g) => (
        <Pressable
          key={g.id}
          accessibilityRole="button"
          onPress={() => onOpen(g)}
          style={{
            padding: 10,
            borderRadius: 10,
            backgroundColor: g.id === activeId ? colors.card : "transparent",
          }}
        >
          <Text style={[s.text, { fontWeight: "600" }]}>{g.title}</Text>
        </Pressable>
      ))}
      {making ? (
        <View style={{ gap: 6 }}>
          <Field
            label={text.name}
            value={title}
            maxLength={GROUP_TITLE_MAX}
            onChangeText={setTitle}
          />
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              primary
              busy={make.busy}
              disabled={!title.trim()}
              onPress={() =>
                make.run(async () => {
                  const g = await api.request<GroupView>("/api/groups", { title: title.trim() });
                  setMaking(false);
                  setTitle("");
                  list.retry();
                  onOpen(g);
                })
              }
            >
              {text.make}
            </Button>
            <Button small onPress={() => setMaking(false)}>
              {text.cancel}
            </Button>
          </View>
          <ErrorNotice error={make.error} />
        </View>
      ) : (
        <Button small onPress={() => setMaking(true)}>
          {text.create}
        </Button>
      )}
    </View>
  );
}

/** 단체 톡 대화 화면 */
export function GroupScreen({ group: initial, onBack }: { group: GroupView; onBack: () => void }) {
  const { api } = useWorkspace();
  const who = useLoad(() => api.request<{ user: { id: string } }>("/api/me"), "me");
  const [group, setGroup] = useState(initial);
  const [lines, setLines] = useState<GroupMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [membersOpen, setMembersOpen] = useState(false);
  const last = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const pull = useCallback(async () => {
    try {
      const next = await api.request<GroupMessage[]>(
        `/api/groups/${initial.id}/messages?after=${last.current}`,
      );
      if (next.length) {
        last.current = next.at(-1)?.seq ?? last.current;
        setLines((prev) => [...prev, ...next.filter((m) => !prev.some((p) => p.id === m.id))]);
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, initial.id]);
  const reload = useCallback(
    async () => setGroup(await api.request<GroupView>(`/api/groups/${initial.id}`)),
    [api, initial.id],
  );
  useEffect(() => {
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => clearInterval(timer);
  }, [pull]);
  const send = useAction();
  const me = who.data?.user.id;
  return (
    <View style={{ flex: 1 }}>
      <View
        style={[
          s.row,
          { gap: 6, padding: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
        ]}
      >
        <IconButton icon={ArrowLeft} label={text.back} onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "700" }]}>{group.title}</Text>
          <Text style={s.small}>{text.members(group.members.length)}</Text>
        </View>
        <IconButton
          icon={Users}
          label={text.members(group.members.length)}
          onPress={() => setMembersOpen(true)}
        />
      </View>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {lines.length === 0 && <Text style={s.muted}>{text.empty}</Text>}
        {lines.map((m) =>
          m.authorId === "system" ? (
            <Text key={m.id} style={[s.small, { textAlign: "center" }]}>
              {m.text}
            </Text>
          ) : (
            <View
              key={m.id}
              style={{
                alignSelf: m.authorId === me ? "flex-end" : "flex-start",
                maxWidth: "80%",
                gap: 2,
              }}
            >
              {m.authorId !== me && <Text style={s.small}>{m.nickname}</Text>}
              <View
                style={{
                  padding: 10,
                  borderRadius: 14,
                  backgroundColor: m.authorId === me ? colors.accent : colors.card,
                  borderWidth: m.authorId === me ? 0 : 1,
                  borderColor: colors.line,
                }}
              >
                <Text selectable style={[s.text, m.authorId === me && { color: "#fff" }]}>
                  {m.text}
                </Text>
              </View>
              <Text style={[s.small, { fontSize: 11 }]}>{stampLabel(m.createdAt)}</Text>
            </View>
          ),
        )}
        <ErrorNotice error={error} />
      </ScrollView>
      <View
        style={[s.row, { gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.line }]}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={text.placeholder}
          placeholderTextColor={colors.muted}
          maxLength={GROUP_TEXT_MAX}
          multiline
          style={[
            s.text,
            { flex: 1, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.line },
          ]}
        />
        <Button
          small
          primary
          busy={send.busy}
          disabled={!draft.trim()}
          onPress={() =>
            send.run(async () => {
              await api.request(`/api/groups/${group.id}/messages`, { text: draft.trim() });
              setDraft("");
              await pull();
            })
          }
        >
          {text.send}
        </Button>
      </View>
      <ErrorNotice error={send.error} />
      {membersOpen && (
        <Sheet
          title={text.members(group.members.length)}
          subtitle={group.title}
          onClose={() => setMembersOpen(false)}
        >
          <Members
            group={group}
            me={me}
            onChanged={() => void reload().catch((e) => setError(String(e)))}
            onLeft={() => {
              setMembersOpen(false);
              onBack();
            }}
          />
        </Sheet>
      )}
    </View>
  );
}

function Members({
  group,
  me,
  onChanged,
  onLeft,
}: {
  group: GroupView;
  me?: string;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const { api } = useWorkspace();
  const act = useAction();
  const [phone, setPhone] = useState("");
  const [nickname, setNickname] = useState("");
  const [mine, setMine] = useState(group.members.find((m) => m.userId === me)?.nickname ?? "");
  const [result, setResult] = useState<{
    joined: boolean;
    phoneHint: string;
    link: string | null;
  }>();
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ gap: 14 }}>
      {group.members.map((m) => (
        <View key={m.userId} style={[s.row, { gap: 8 }]}>
          <Text style={[s.text, { flex: 1 }]}>
            {m.nickname}
            {m.userId === group.ownerId ? ` · ${text.owner}` : ""}
            {m.userId === me ? ` · ${text.me}` : ""}
          </Text>
          {group.mine && m.userId !== me && (
            <Button
              small
              danger
              disabled={act.busy}
              onPress={() =>
                act.run(async () => {
                  await api.request(
                    `/api/groups/${group.id}/members/${m.userId}`,
                    undefined,
                    "DELETE",
                  );
                  onChanged();
                })
              }
            >
              {text.remove}
            </Button>
          )}
        </View>
      ))}
      <View style={{ gap: 6 }}>
        <Field
          label={text.myNickname}
          value={mine}
          maxLength={GROUP_NICKNAME_MAX}
          onChangeText={setMine}
        />
        <Button
          small
          disabled={act.busy || !mine.trim()}
          onPress={() =>
            act.run(async () => {
              await api.request(
                `/api/groups/${group.id}/nickname`,
                { nickname: mine.trim() },
                "PATCH",
              );
              onChanged();
            })
          }
        >
          {text.save}
        </Button>
      </View>
      {group.mine && (
        <View style={{ gap: 6 }}>
          <Text style={s.label}>{text.invite}</Text>
          <Field
            label={text.phone}
            placeholder="010-1234-5678"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
          />
          <Field
            label={text.nickname}
            value={nickname}
            maxLength={GROUP_NICKNAME_MAX}
            onChangeText={setNickname}
          />
          <Button
            small
            primary
            busy={act.busy}
            disabled={!phone.trim() || !nickname.trim()}
            onPress={() =>
              act.run(async () => {
                setCopied(false);
                setResult(
                  await api.request(`/api/groups/${group.id}/invite`, {
                    phone: phone.trim(),
                    nickname: nickname.trim(),
                  }),
                );
                setPhone("");
                setNickname("");
                onChanged();
              })
            }
          >
            {text.invite}
          </Button>
          {result && (
            <View style={{ gap: 6 }}>
              <Text style={s.small}>
                {result.joined
                  ? text.joined(result.phoneHint)
                  : result.link
                    ? text.pending(result.phoneHint)
                    : text.pendingNoLink(result.phoneHint)}
              </Text>
              {result.link && (
                <>
                  <Text selectable style={[s.small, { color: colors.text }]}>
                    {result.link}
                  </Text>
                  <Button
                    small
                    onPress={() =>
                      void Clipboard.setStringAsync(result.link as string).then(() =>
                        setCopied(true),
                      )
                    }
                  >
                    {copied ? text.copied : text.copyLink}
                  </Button>
                </>
              )}
            </View>
          )}
        </View>
      )}
      {group.kind !== "operator" && <BotPanel group={group} />}
      {!group.mine && me && (
        <Button
          small
          danger
          disabled={act.busy}
          onPress={() =>
            act.run(async () => {
              await api.request(`/api/groups/${group.id}/members/${me}`, undefined, "DELETE");
              onLeft();
            })
          }
        >
          {text.leave}
        </Button>
      )}
      <ErrorNotice error={act.error} />
    </View>
  );
}

/** 이 방의 봇 — 멤버는 보고, 방장은 구독 팀 도구로 만들고 뺀다 */
function BotPanel({ group }: { group: GroupView }) {
  const { api } = useWorkspace();
  const bots = useLoad(() => api.request<GroupBot[]>(`/api/groups/${group.id}/bots`), group.id);
  const [options, setOptions] = useState<TeamTools[]>();
  const [roomId, setRoomId] = useState("");
  const [tool, setTool] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GroupBotTrigger>("command");
  const [value, setValue] = useState("");
  const [args, setArgs] = useState("{}");
  const act = useAction();
  const team = options?.find((t) => t.roomId === roomId);
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{text.bots}</Text>
      <ErrorNotice error={bots.error} />
      {bots.data?.length === 0 && <Text style={s.small}>{text.noBots}</Text>}
      {bots.data?.map((b) => (
        <View key={b.id} style={[s.row, { gap: 8 }]}>
          <Bot size={16} color={colors.muted} />
          <View style={{ flex: 1 }}>
            <Text style={s.text}>
              {b.name} · {b.teamName}
            </Text>
            <Text style={s.small}>
              {GROUP_BOT_TRIGGER_LABELS[b.trigger.kind]}{" "}
              {b.trigger.kind === "command" ? `/${b.trigger.value}` : b.trigger.value} → {b.tool}
            </Text>
          </View>
          {group.mine && (
            <Button
              small
              danger
              disabled={act.busy}
              onPress={() =>
                act.run(async () => {
                  await api.request(`/api/groups/${group.id}/bots/${b.id}`, undefined, "DELETE");
                  bots.retry();
                })
              }
            >
              {text.removeBot}
            </Button>
          )}
        </View>
      ))}
      {group.mine && !options && (
        <Button
          small
          busy={act.busy}
          onPress={() =>
            act.run(async () =>
              setOptions(await api.request<TeamTools[]>(`/api/groups/${group.id}/bot-options`)),
            )
          }
        >
          {text.addBot}
        </Button>
      )}
      {options?.length === 0 && <Text style={s.small}>{text.noTeams}</Text>}
      {!!options?.length && (
        <View style={{ gap: 6 }}>
          <Text style={s.small}>{text.pickTeam}</Text>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {options.map((t) => (
              <Button
                key={t.roomId}
                small
                primary={t.roomId === roomId}
                onPress={() => {
                  setRoomId(t.roomId);
                  setTool("");
                }}
              >
                {t.team}
              </Button>
            ))}
          </View>
          {team && team.tools.length === 0 && <Text style={s.small}>{text.noTools}</Text>}
          {team && team.tools.length > 0 && (
            <>
              <Text style={s.small}>{text.pickTool}</Text>
              <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                {team.tools.map((t) => (
                  <Button key={t} small primary={t === tool} onPress={() => setTool(t)}>
                    {t}
                  </Button>
                ))}
              </View>
            </>
          )}
          {tool && (
            <>
              <Field
                label={text.botName}
                value={name}
                maxLength={GROUP_NICKNAME_MAX}
                onChangeText={setName}
              />
              <Text style={s.small}>{text.trigger}</Text>
              <View style={[s.row, { gap: 6 }]}>
                {GROUP_BOT_TRIGGERS.map((k) => (
                  <Button key={k} small primary={k === kind} onPress={() => setKind(k)}>
                    {GROUP_BOT_TRIGGER_LABELS[k]}
                  </Button>
                ))}
              </View>
              <Field
                label={text.triggerValue[kind]}
                placeholder={text.triggerExample[kind]}
                value={value}
                maxLength={100}
                onChangeText={setValue}
              />
              <Field label={text.args} value={args} autoCapitalize="none" onChangeText={setArgs} />
              <Button
                small
                primary
                busy={act.busy}
                disabled={!name.trim() || !value.trim()}
                onPress={() =>
                  act.run(async () => {
                    let parsed: unknown;
                    try {
                      parsed = JSON.parse(args || "{}");
                    } catch {
                      throw new Error(text.badArgs);
                    }
                    await api.request(`/api/groups/${group.id}/bots`, {
                      roomId,
                      tool,
                      name: name.trim(),
                      args: parsed,
                      trigger: { kind, value: value.trim() },
                    });
                    setOptions(undefined);
                    setRoomId("");
                    setTool("");
                    setName("");
                    setValue("");
                    setArgs("{}");
                    bots.retry();
                  })
                }
              >
                {text.makeBot}
              </Button>
            </>
          )}
        </View>
      )}
      <ErrorNotice error={act.error} />
    </View>
  );
}
