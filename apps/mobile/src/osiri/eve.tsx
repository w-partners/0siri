// 영시리 캐릭터 — 0Siri_ClaudeCode_Kit 의 흰 구체 로봇(마스터 2026-10-11 «압축파일 안의 캐릭터로 기본으로»).
// 포즈는 정지 PNG(assets/osiri — 시트 조각을 지우고 같은 축척으로 맞춤), 움직임은 transform/opacity 만(네이티브 드라이버).
// 손가락 관절 애니메이션은 없다 — 일할 땐 두 포즈를 번갈아 보이고 아래 홀로그램 키가 점등된다.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing, Image, View } from "react-native";
import {
  type CharacterPrefs,
  DEFAULT_CHARACTER_PREFS,
} from "../../../../packages/domain/src/osiri";
import { Mascot } from "../ui";
import {
  DOZE_MIN_SIZE,
  DOZE_MS,
  type Mood,
  POSE_LABEL,
  type Pose,
  poseFor,
  SLEEP_MS,
  WORK_SWAP_MS,
} from "./eve-pose";

export type { Mood } from "./eve-pose";

const POSE: Record<Pose, number> = {
  idle: require("../../assets/osiri/idle.png"),
  resting: require("../../assets/osiri/resting.png"),
  sleeping: require("../../assets/osiri/sleeping.png"),
  working: require("../../assets/osiri/working.png"),
  working_alt: require("../../assets/osiri/working_alt.png"),
  thinking: require("../../assets/osiri/thinking.png"),
  success: require("../../assets/osiri/success.png"),
};
const KEY = "#5CD6FF";
const KEYS = 4;

const pingPong = (v: Animated.Value, ms: number) =>
  Animated.loop(
    Animated.sequence([
      Animated.timing(v, {
        toValue: 1,
        duration: ms,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
      Animated.timing(v, {
        toValue: 0,
        duration: ms,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
    ]),
  );

/** OS «동작 줄이기»(웹은 prefers-reduced-motion). 켜져 있으면 움직임을 멈추고 표정·문구로만 상태를 전한다. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (v) => live && setReduced(v),
      (e) => console.warn("[0siri] reduce-motion 조회 실패 — 움직임을 그대로 둔다", e),
    );
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

// --- 캐릭터 설정 (화면 11 «캐릭터 끄기 · 반응 강도») — 값은 서버 GET /settings 의 character, 여기는 그 사본을 들고만 있는다 ---
export type CharacterPref = CharacterPrefs;
let pref: CharacterPref = DEFAULT_CHARACTER_PREFS;
const prefListeners = new Set<() => void>();
export function setCharacterPref(next: CharacterPref) {
  pref = next;
  for (const l of prefListeners) l();
}
export const useCharacterPref = () =>
  useSyncExternalStore(
    (l) => {
      prefListeners.add(l);
      return () => prefListeners.delete(l);
    },
    () => pref,
  );
/** 움직이면 안 되는가 — 동작 줄이기이거나 반응 강도가 «표정만» 이하 */
export function useStill() {
  const reduced = useReducedMotion();
  const { intensity } = useCharacterPref();
  return reduced || intensity !== "motion";
}

export function Eve({ size = 120, mood = "idle" }: { size?: number; mood?: Mood }) {
  const still = useStill();
  // 졸음: 큰 캐릭터가 쉬는 채로 오래 있으면 눈을 감고, 더 오래면 잠든다. 기분이 바뀌면 바로 깬다
  const [drowse, setDrowse] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    setDrowse(0);
    if (mood !== "idle" || size < DOZE_MIN_SIZE) return;
    const doze = setTimeout(() => setDrowse(1), DOZE_MS);
    const sleep = setTimeout(() => setDrowse(2), DOZE_MS + SLEEP_MS);
    return () => {
      clearTimeout(doze);
      clearTimeout(sleep);
    };
  }, [mood, size]);
  // 일하는 중: 두 포즈를 번갈아, 홀로그램 키는 하나씩 점등
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    if (still || mood !== "thinking") return;
    const timer = setInterval(() => setTick((t) => t + 1), 150);
    return () => clearInterval(timer);
  }, [mood, still]);
  const pose = poseFor(mood, drowse, Math.floor((tick * 150) / WORK_SWAP_MS) % 2 === 1);

  // 포즈가 바뀌면 옛 포즈 위로 새 포즈를 겹쳐 띄운다(부드러운 전환)
  const [layers, setLayers] = useState<{ now: Pose; prev: Pose | null }>({ now: pose, prev: null });
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (pose === layers.now) return;
    if (still) return setLayers({ now: pose, prev: null });
    setLayers({ now: pose, prev: layers.now });
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: true }).start(() =>
      setLayers((l) => ({ ...l, prev: null })),
    );
  }, [pose, layers.now, still, fade]);

  // 움직임 하나(wave 0↔1)를 포즈마다 다르게 쓴다
  const working = pose === "working" || pose === "working_alt";
  const period = working
    ? 110
    : pose === "resting"
      ? 3200
      : pose === "sleeping"
        ? 4200
        : pose === "thinking"
          ? 2200
          : mood === "speaking"
            ? 700
            : mood === "listening"
              ? 1300
              : 2600;
  const wave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return wave.setValue(0);
    const loop = pingPong(wave, period);
    loop.start();
    return () => loop.stop();
  }, [wave, period, still]);
  // 완료: 한 번 가볍게 튄다
  const bounce = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still || mood !== "happy") return;
    bounce.setValue(0);
    Animated.sequence([
      Animated.timing(bounce, {
        toValue: 1,
        duration: 170,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(bounce, {
        toValue: 0,
        duration: 420,
        easing: Easing.bounce,
        useNativeDriver: true,
      }),
    ]).start();
  }, [bounce, mood, still]);

  const between = (a: number, b: number) =>
    wave.interpolate({ inputRange: [0, 1], outputRange: [a, b] });
  const transform = working
    ? [{ translateX: between(-size * 0.012, size * 0.012) }]
    : pose === "resting" || pose === "sleeping"
      ? [{ scale: between(1, 1.03) }]
      : pose === "thinking"
        ? [{ rotate: wave.interpolate({ inputRange: [0, 1], outputRange: ["-5deg", "5deg"] }) }]
        : [
            {
              translateY: Animated.add(
                between(0, -size * 0.045),
                bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.14] }),
              ),
            },
            { rotate: wave.interpolate({ inputRange: [0, 1], outputRange: ["-2deg", "2deg"] }) },
          ];
  const floating = pose === "idle" || pose === "success";
  const image = (p: Pose, opacity: Animated.Value | Animated.AnimatedInterpolation<number>) => (
    <Animated.Image
      key={p}
      source={POSE[p]}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      style={{ position: "absolute", width: size, height: size, opacity }}
    />
  );
  const lit = (tick * 7) % KEYS;

  return (
    <View
      style={{ width: size, height: size * 1.08 }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`영시리 — ${POSE_LABEL[pose]}`}
    >
      {/* 바닥 그림자 — 떠오를수록 작아진다 */}
      <Animated.View
        style={{
          position: "absolute",
          bottom: size * 0.04,
          left: size * 0.3,
          width: size * 0.4,
          height: size * 0.045,
          borderRadius: size,
          backgroundColor: "rgba(19,38,49,0.12)",
          transform: [{ scaleX: floating ? between(1, 0.8) : 1 }],
        }}
      />
      <Animated.View style={{ width: size, height: size, transform }}>
        {layers.prev &&
          image(layers.prev, fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }))}
        {image(layers.now, fade)}
      </Animated.View>
      {/* 홀로그램 키 — 일할 때만. 하나씩 번갈아 점등(실제 타자 동작을 그린 것은 아니다) */}
      {working && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: size * 0.9,
            left: 0,
            right: 0,
            flexDirection: "row",
            justifyContent: "center",
            gap: size * 0.025,
          }}
        >
          {Array.from({ length: KEYS }, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: 고정 개수의 키
              key={i}
              style={{
                width: size * 0.075,
                height: size * 0.045,
                borderRadius: size * 0.012,
                borderWidth: 1,
                borderColor: "rgba(92,214,255,0.7)",
                backgroundColor: KEY,
                opacity: still ? 0.35 : i === lit ? 0.9 : 0.2,
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// --- 캐릭터 → 모습: 여기 한 곳에서만 정한다 (SSOT) ---
// 방 목록·방 머리·스토어·로그인·로딩·온보딩 전부 이 컴포넌트를 쓴다. 다른 파일에서 character 값으로 분기하지 않는다.
// (2026-10-10 마스터 지적: 방 머리만 EVE 로 바꾸고 방 목록은 카피바라로 남아 영시리 얼굴이 둘이었다)
export const YEONGSIL = "yeongsil";
/** 스스로 움직이는 캐릭터인가 — 아니면 부르는 쪽이 presence 애니메이션을 입힌다 */
export const selfAnimated = (character: string) => character === YEONGSIL;

export function CharacterAvatar({
  character = YEONGSIL,
  size = 42,
  mood = "idle",
}: {
  /** 캐릭터 자산 id — 서버 현황판 `character.assetId`(= Room.character / Package.character). 생략하면 0Siri 의 얼굴 = 영시리 */
  character?: string;
  size?: number;
  mood?: Mood;
}) {
  const { enabled, intensity } = useCharacterPref();
  // 캐릭터를 끄면 그림은 사라지고 부르는 쪽의 상태 문구만 남는다 (기획 화면 3 분기)
  if (!enabled || intensity === "text") return null;
  if (character === YEONGSIL) return <Eve size={size} mood={mood} />;
  // 팀이 등록한 캐릭터 자산: assetId 가 그림 주소면 그 그림을 쓴다 (기획 화면 3 «팀마다 다른 캐릭터 자산»)
  if (/^(https:\/\/|data:image\/)/.test(character))
    return (
      <Image
        source={{ uri: character }}
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  // 방 설정에서 고른 카피바라 색 (ROOM_CHARACTER_PRESETS)
  if (character === "mascot:sand" || character === "mascot:lilac")
    return <Mascot size={size} variant={character.slice(7) as "sand" | "lilac"} />;
  // 자산을 등록하지 않은 팀: 플랫폼 기본 팀장 캐릭터(카피바라) + 이름 해시로 고정한 배경색
  let h = 0;
  for (const ch of character) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <Mascot size={size} variant={h % 2 ? "sand" : "lilac"} />;
}
