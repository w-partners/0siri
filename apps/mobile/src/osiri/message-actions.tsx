// 말풍선 아래 한 줄 — 언제 말했고 언제 답했는지, 누가 답했는지, 복사, 여기서 분기(마스터 2026-10-11 «ChatGPT 처럼»).
// 부분 복사는 말풍선 글 자체가 selectable 이라 길게 눌러(앱)·끌어서(웹) 고른다.
import * as Clipboard from "expo-clipboard";
import { Check, Copy, GitBranch } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, dateLabel, s, timeLabel } from "../ui";

export const MESSAGE_ACTION_TEXT = {
  copy: "복사",
  copied: "복사됨",
  copyFailed: "복사하지 못했습니다",
  branch: "여기서 분기",
  branchTitle: (title: string) => `${title} · 분기`,
  branchFailed: (why: string) => `분기하지 못했습니다: ${why}`,
  /** 시각 저장 전 옛 메시지 — 같은 턴의 앞 시각이라 정확하지 않다 */
  approximate: (stamp: string) => `≈ ${stamp}`,
};

/** 오늘이면 시각만, 아니면 날짜와 시각 */
export function stampLabel(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = date.toDateString() === now.toDateString();
  return today ? timeLabel(iso) : `${dateLabel(iso)} ${timeLabel(iso)}`;
}

function Action({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ padding: 4, borderRadius: 8, opacity: pressed ? 0.5 : 1 })}
    >
      {children}
    </Pressable>
  );
}

export function MessageMeta({
  user,
  time,
  approximate,
  label,
  copyText,
  onBranch,
  onError,
}: {
  user: boolean;
  time?: string;
  approximate?: boolean;
  label?: string;
  copyText: string;
  onBranch?: () => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    Clipboard.setStringAsync(copyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((e) =>
        onError(`${MESSAGE_ACTION_TEXT.copyFailed}: ${e instanceof Error ? e.message : String(e)}`),
      );
  const exact = time ? stampLabel(time) : "";
  const stamp = exact && approximate ? MESSAGE_ACTION_TEXT.approximate(exact) : exact;
  const info = [stamp, label].filter(Boolean).join(" · ");
  return (
    <View
      style={{
        flexDirection: user ? "row-reverse" : "row",
        alignItems: "center",
        gap: 6,
        marginHorizontal: 6,
        flexWrap: "wrap",
      }}
    >
      {!!info && <Text style={[s.small, { flexShrink: 1 }]}>{info}</Text>}
      <Action label={copied ? MESSAGE_ACTION_TEXT.copied : MESSAGE_ACTION_TEXT.copy} onPress={copy}>
        {copied ? <Check size={15} color={colors.ok} /> : <Copy size={15} color={colors.muted} />}
      </Action>
      {!!onBranch && (
        <Action label={MESSAGE_ACTION_TEXT.branch} onPress={onBranch}>
          <GitBranch size={15} color={colors.muted} />
        </Action>
      )}
    </View>
  );
}
