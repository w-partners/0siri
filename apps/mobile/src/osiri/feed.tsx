// 피드 탭 (Muse 피드 + 마스터 2026-10-10): 내 관심 프롬프트로 모은 글 + 관리자가 보낸 글. 글마다 좋아요 · 공유 · 토론.
// 토론 = 그 글을 첫 카드로 실은 새 대화방(주제방)을 열어 영시리와 이야기한다.
import { Heart, Link2, MessageCircle, Newspaper, Send, Share2 } from "lucide-react-native";
import { useState } from "react";
import { Linking, Pressable, Share, Text, View } from "react-native";
import type { MeResponse } from "../../../server/src/osiri/account-routes.ts";
import type { FeedItem } from "../../../server/src/osiri/feed.ts";
import type { Room } from "../../../server/src/osiri/rooms.ts";
import { Button, Card, Chip, colors, ErrorNotice, Field, relativeDate, s, useAction } from "../ui";
import { useWorkspace } from "../workspace";
import { refreshRooms } from "./rooms";
import { LoadState, useLoad } from "./store";

const text = {
  promptTitle: "관심 프롬프트",
  promptDetail:
    "적어 두면 영시리가 주기적으로 웹에서 찾아 피드에 올려요. 주기·정지는 ≡ 메뉴 «자동화» 에서.",
  promptPlaceholder: "예: 이번 주 상속 판례 소식",
  add: "추가",
  added: (n: string) => `«${n}» 을(를) 피드에 붙였어요`,
  admin: "관리자",
  broadcastTitle: "모두에게 보내기 (관리자)",
  broadcastHeading: "제목",
  broadcastBody: "내용",
  send: "보내기",
  sent: "모두의 피드에 올렸어요",
  like: "좋아요",
  share: "공유",
  discuss: "토론",
  open: "원문",
  empty: "피드가 비어 있어요",
  emptyDetail: "위에 관심 프롬프트를 적으면 관련 글이 여기에 쌓여요.",
  discussTitle: (title: string) => `토론 · ${title.slice(0, 30)}`,
  discussSeed: "이 글로 이야기해요:",
};

function Post({
  post,
  onChange,
  onOpenRoom,
}: {
  post: FeedItem;
  onChange: (p: FeedItem) => void;
  onOpenRoom: (id: string) => void;
}) {
  const { api } = useWorkspace();
  const act = useAction();
  const like = () =>
    act.run(async () => {
      await api.request(`/api/feed/${post.id}/like`, { liked: !post.liked });
      onChange({ ...post, liked: !post.liked });
    });
  const share = () =>
    act.run(() => Share.share({ message: [post.title, post.url].filter(Boolean).join("\n") }));
  const discuss = () =>
    act.run(async () => {
      const room = await api.request<Room>("/api/rooms", {
        title: text.discussTitle(post.title),
        seed: [text.discussSeed, post.title, post.body, post.url].filter(Boolean).join("\n"),
      });
      await refreshRooms(api);
      onOpenRoom(room.id);
    });
  const action = (icon: typeof Heart, label: string, onPress: () => void, on = false) => {
    const Icon = icon;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: on, disabled: act.busy }}
        disabled={act.busy}
        onPress={onPress}
        style={[s.row, { gap: 5, paddingVertical: 6, paddingHorizontal: 4 }]}
      >
        <Icon
          size={18}
          color={on ? colors.danger : colors.text}
          fill={on ? colors.danger : "none"}
        />
        <Text style={s.small}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <Card style={{ gap: 8, padding: 16 }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Chip tint={post.source === "admin" ? colors.warnBg : undefined}>
          {post.source === "admin" ? text.admin : (post.prompt ?? text.promptTitle)}
        </Chip>
        <Text style={s.small}>{relativeDate(post.createdAt)}</Text>
      </View>
      <Text style={s.heading}>{post.title}</Text>
      {post.body ? <Text style={s.text}>{post.body}</Text> : null}
      <View style={[s.row, { gap: 14, flexWrap: "wrap" }]}>
        {action(Heart, text.like, like, post.liked)}
        {action(Share2, text.share, share)}
        {action(MessageCircle, text.discuss, discuss)}
        {post.url ? action(Link2, text.open, () => void Linking.openURL(post.url as string)) : null}
      </View>
      <ErrorNotice error={act.error} />
    </Card>
  );
}

export function FeedScreen({ onOpenRoom }: { onOpenRoom: (id: string) => void }) {
  const { api, notify } = useWorkspace();
  const feed = useLoad(() => api.request<FeedItem[]>("/api/feed"), "feed");
  const me = useLoad(() => api.request<MeResponse>("/api/me"), "me");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const add = useAction();
  const send = useAction();
  const reload = async () => feed.setData(await api.request<FeedItem[]>("/api/feed"));
  return (
    <View style={{ gap: 14 }}>
      <Card style={{ gap: 8, padding: 16 }}>
        <Text style={s.heading}>{text.promptTitle}</Text>
        <Text style={s.muted}>{text.promptDetail}</Text>
        <Field
          label={text.promptTitle}
          placeholder={text.promptPlaceholder}
          value={prompt}
          onChangeText={setPrompt}
        />
        <Button
          small
          primary
          icon={Newspaper}
          busy={add.busy}
          disabled={prompt.trim().length < 2}
          onPress={() =>
            add.run(async () => {
              await api.request("/api/feed/prompts", { prompt: prompt.trim() });
              notify(text.added(prompt.trim()));
              setPrompt("");
              await reload();
            })
          }
        >
          {text.add}
        </Button>
        <ErrorNotice error={add.error} />
      </Card>
      <LoadState
        loading={feed.loading}
        error={feed.error}
        retry={feed.retry}
        empty={
          feed.data?.length === 0 && {
            title: text.empty,
            detail: text.emptyDetail,
            icon: Newspaper,
          }
        }
      >
        {feed.data?.map((post) => (
          <Post
            key={post.id}
            post={post}
            onOpenRoom={onOpenRoom}
            onChange={(next) =>
              feed.setData((feed.data ?? []).map((p) => (p.id === next.id ? next : p)))
            }
          />
        ))}
      </LoadState>
      {me.data?.user.role === "admin" && (
        <Card style={{ gap: 8, padding: 16 }}>
          <Text style={s.heading}>{text.broadcastTitle}</Text>
          <Field label={text.broadcastHeading} value={title} onChangeText={setTitle} />
          <Field label={text.broadcastBody} value={body} onChangeText={setBody} multiline />
          <Button
            small
            icon={Send}
            busy={send.busy}
            disabled={!title.trim() || !body.trim()}
            onPress={() =>
              send.run(async () => {
                await api.request("/api/admin/feed", { title: title.trim(), body: body.trim() });
                notify(text.sent);
                setTitle("");
                setBody("");
                await reload();
              })
            }
          >
            {text.send}
          </Button>
          <ErrorNotice error={send.error} />
        </Card>
      )}
    </View>
  );
}
