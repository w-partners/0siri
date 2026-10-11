// 음성 입력 — 마이크 버튼을 누르면 앱 안에서 바로 듣고 입력창에 글자로 채운다.
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

export function VoiceButton({
  draft,
  setDraft,
  onListening,
  onError,
}: {
  draft: string;
  setDraft: (text: string) => void;
  onListening: (on: boolean) => void;
  onError: (message: string | undefined) => void;
}) {
  const [on, setOn] = useState(false);
  // 누른 순간의 입력창 글 + 확정된 말. 듣는 중의 말은 그 뒤에 잠정으로 붙는다
  const base = useRef("");
  const set = (value: boolean) => {
    setOn(value);
    onListening(value);
  };
  useSpeechRecognitionEvent("start", () => set(true));
  useSpeechRecognitionEvent("end", () => set(false));
  useSpeechRecognitionEvent("result", (event) => {
    const said = event.results[0]?.transcript?.trim() ?? "";
    if (!said) return;
    const joined = base.current ? `${base.current} ${said}` : said;
    if (event.isFinal) base.current = joined;
    setDraft(joined);
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
