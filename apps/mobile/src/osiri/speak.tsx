// 음성으로 보낸 말의 답은 음성으로 — 답 글이 흘러나오는 대로 문장 단위로 기기 TTS 에 넘긴다(앱: 안드로이드 TTS, 웹: speechSynthesis).
// 게이트웨이에 TTS 가 없어 기기 음성을 쓴다. 멈추기 버튼은 읽는 동안만 보인다.
import * as Speech from "expo-speech";
import { VolumeX } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text } from "react-native";
import { colors } from "../ui";
import { sentenceEnd, speakable } from "./speak-text";

export const SPEAK_TEXT = { stop: "음성 멈추기" };

type Last = { id: string; role: string; content?: unknown } | undefined;

/** 답 읽기. start() 는 음성으로 보낼 때 부른다 — 그때 마지막 메시지 다음에 오는 답부터 읽는다 */
export function useSpokenReply(last: Last, replying: boolean) {
  const on = useRef(false);
  const before = useRef<string | undefined>(undefined);
  const target = useRef<string | undefined>(undefined);
  const said = useRef(0);
  const queued = useRef(0);
  const [speaking, setSpeaking] = useState(false);
  const lastRef = useRef(last);
  lastRef.current = last;

  const stop = () => {
    on.current = false;
    queued.current = 0;
    setSpeaking(false);
    void Speech.stop();
  };
  const start = () => {
    stop();
    on.current = true;
    before.current = lastRef.current?.id;
    target.current = undefined;
  };

  const content = typeof last?.content === "string" ? last.content : "";
  useEffect(() => {
    if (!on.current || !last || last.role !== "assistant" || last.id === before.current) return;
    if (last.id !== target.current) {
      target.current = last.id;
      said.current = 0;
    }
    const end = sentenceEnd(content, said.current, !replying);
    const chunk = speakable(content.slice(said.current, end));
    said.current = end;
    if (chunk) {
      queued.current += 1;
      setSpeaking(true);
      const done = () => {
        queued.current = Math.max(0, queued.current - 1);
        if (!queued.current) setSpeaking(false);
      };
      Speech.speak(chunk, { language: "ko-KR", onDone: done, onError: done, onStopped: done });
    }
    // ponytail: 도구를 부른 뒤 새 답 메시지가 이어질 수 있어, 답이 끝난 뒤에만 끈다
    if (!replying && content) on.current = false;
  }, [last, content, replying]);

  useEffect(() => () => void Speech.stop(), []);
  return { speaking, start, stop };
}

export function StopSpeakingButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={SPEAK_TEXT.stop}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "center",
        gap: 6,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: pressed ? colors.sky : colors.sunk,
      })}
    >
      <VolumeX size={16} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 14 }}>{SPEAK_TEXT.stop}</Text>
    </Pressable>
  );
}
