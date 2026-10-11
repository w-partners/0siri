// 단체 톡 화면 — 목록(메뉴 안) · 대화 · 멤버(초대·닉네임·나가기). 서버 osiri/groups.ts 가 정본.
// ponytail: 새 메시지는 3초마다 after=seq 로 묻는다(서버 주석과 같은 상한).
import * as Clipboard from "expo-clipboard";
import { ArrowLeft, MessagesSquare, Users } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  GROUP_NICKNAME_MAX,
  GROUP_TEXT_MAX,
  GROUP_TITLE_MAX,
} from "../../../../packages/domain/src/osiri";
import type { Group, GroupMessage } from "../../../server/src/osiri/groups.ts";
import {
  Button,
  colors,
  ErrorNotice,
  Field,
  IconButton,
  Sheet,
  s,
  timeLabel,
  useAction,
} from "../ui";
import { useWorkspace } from "../workspace";
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
              <Text style={[s.small, { fontSize: 11 }]}>{timeLabel(m.createdAt)}</Text>
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
