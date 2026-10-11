// 음성 입력 — 마이크 버튼을 누르면 앱 안에서 바로 듣고 입력창에 글자로 채우고, 말이 끝나면 바로 보낸다(마스터 2026-10-11).
// 안드로이드는 SpeechRecognizer 를 직접 부른다(구글 음성 입력 창·키보드 마이크를 띄우지 않는다). 웹은 브라우저 SpeechRecognition.
// continuous: 말을 멈춰도 다시 누를 때까지 듣는다 — 안드로이드 13+ 에서는 이 모드여야 시작음(삑)도 나지 않는다.
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { Mic, Square } from "lucide-react-native";
import { useRef, useState } from "react";
import { Pressable } from "react-native";
import { colors } from "../ui";

export const VOICE_TEXT = {
  start: "음성으로 입력",
  stop: "음성 입력 끝내기",
  denied:
    "마이크 권한이 없어 음성 입력을 할 수 없습니다. 앱은 휴대폰 설정에서 0Siri 의 마이크를, 웹은 주소창 옆 자물쇠에서 마이크를 허용해 주세요.",
  failed: (why: string) => `음성 입력이 멈췄습니다: ${why}`,
};
/** 사용자가 끝낸 것·말이 없던 것은 오류가 아니다 */
const QUIET = new Set(["aborted", "no-speech", "speech-timeout"]);
/** 말이 이만큼 끊기면 끝난 것으로 보고 보낸다 — ponytail: 고정값, 말이 느린 사람이 잘리면 늘린다 */
const SILENCE_MS = 1500;

export function VoiceButton({
  draft,
  setDraft,
  onDone,
  onListening,
  onError,
}: {
  draft: string;
  setDraft: (text: string) => void;
  /** 듣기가 끝났을 때 들은 글(입력창에 있던 글 포함) — 바로 보낸다 */
  onDone: (text: string) => void;
  onListening: (on: boolean) => void;
  onError: (message: string | undefined) => void;
}) {
  const [on, setOn] = useState(false);
  // 누른 순간의 입력창 글 + 확정된 말. 듣는 중의 말은 그 뒤에 잠정으로 붙는다
  const base = useRef("");
  // 이번에 들은 글 전체 — 듣기가 끝나면 이것을 보낸다
  const heard = useRef("");
  const silence = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const set = (value: boolean) => {
    setOn(value);
    onListening(value);
  };
  useSpeechRecognitionEvent("start", () => set(true));
  useSpeechRecognitionEvent("end", () => {
    clearTimeout(silence.current);
    set(false);
    const text = heard.current.trim();
    heard.current = "";
    if (text) onDone(text);
  });
  useSpeechRecognitionEvent("result", (event) => {
    const said = event.results[0]?.transcript?.trim() ?? "";
    if (!said) return;
    const joined = base.current ? `${base.current} ${said}` : said;
    if (event.isFinal) base.current = joined;
    heard.current = joined;
    setDraft(joined);
    // 말이 끊기면 듣기를 끝낸다 → end 에서 보낸다. continuous 를 끄지 않는 것은 안드로이드 시작음(삑) 때문
    clearTimeout(silence.current);
    silence.current = setTimeout(() => ExpoSpeechRecognitionModule.stop(), SILENCE_MS);
  });
  useSpeechRecognitionEvent("error", (event) => {
    if (QUIET.has(event.error)) return;
    // 웹 브라우저는 권한 거절을 시작 뒤 오류(not-allowed)로 알린다 — 권한 안내로 바꿔 보인다
    onError(
      event.error === "not-allowed" || event.error === "service-not-allowed"
        ? VOICE_TEXT.denied
        : VOICE_TEXT.failed(event.message || event.error),
    );
  });

  // 웹에서 SpeechRecognition 이 없는 브라우저(파이어폭스 등)는 버튼을 내지 않는다 — 눌러도 안 되는 버튼은 두지 않는다
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return null;

  const toggle = async () => {
    if (on) return ExpoSpeechRecognitionModule.stop();
    onError(undefined);
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) return onError(VOICE_TEXT.denied);
    base.current = draft.trim();
    heard.current = "";
    ExpoSpeechRecognitionModule.start({
      lang: "ko-KR",
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
    });
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={on ? VOICE_TEXT.stop : VOICE_TEXT.start}
      accessibilityState={{ selected: on }}
      onPress={() => void toggle()}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: on ? colors.accent : pressed ? colors.sky : "transparent",
      })}
    >
      {on ? (
        <Square size={16} fill={colors.onAccent} strokeWidth={0} />
      ) : (
        <Mic size={22} color={colors.text} />
      )}
    </Pressable>
  );
}
