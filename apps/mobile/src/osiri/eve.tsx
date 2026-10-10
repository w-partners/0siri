// 영시리 캐릭터 — WALL-E 의 EVE 를 닮은 흰 달걀형 로봇(마스터 2026-10-10 "월이의 이브 같은 형태로").
// 쉴 때는 얼굴이 꺼져 있고, 일할 때는 웃으면서 노트북을 친다(마스터 2026-10-10).
// 몸은 SVG, 눈·볼·팔·노트북은 Animated 레이어 — 전부 transform/opacity 만 바꾼다(네이티브 드라이버).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing, Image, StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import {
  type CharacterPrefs,
  DEFAULT_CHARACTER_PREFS,
} from "../../../../packages/domain/src/osiri";
import { Mascot } from "../ui";

/** idle=쉼(얼굴 꺼짐) · listening=듣는 중 · thinking=일하는 중(웃으며 노트북) · speaking=말하는 중 · happy=완료 · alert=승인 대기 */
export type Mood = "idle" | "listening" | "thinking" | "speaking" | "happy" | "alert";

const EYE = "#5CD6FF";
const VISOR_MID = "#151E28"; // 눈 높이에서의 바이저 색 — 웃는 눈을 깎아 낼 때 쓴다
// 기분별: 얼굴 켜짐 · 웃는 눈 · 눈 크기(x,y) · 고개 기울기(-1~1) · 노트북
const LOOK: Record<
  Mood,
  { on: number; smile: number; x: number; y: number; tilt: number; work: number }
> = {
  idle: { on: 0, smile: 0, x: 1, y: 1, tilt: 0, work: 0 },
  // 눈을 뜬 얼굴도 늘 웃는 눈 — 웃음 없는 큰 타원 눈은 귀엽지 않다(피커 #475)
  listening: { on: 1, smile: 1, x: 1, y: 1.15, tilt: 0.7, work: 0 },
  thinking: { on: 1, smile: 1, x: 1.08, y: 1.35, tilt: 0, work: 1 },
  speaking: { on: 1, smile: 1, x: 1.08, y: 1.35, tilt: 0.25, work: 0 },
  happy: { on: 1, smile: 1, x: 1.15, y: 1.45, tilt: 0, work: 0 },
  alert: { on: 1, smile: 1, x: 1, y: 1.2, tilt: -0.5, work: 0 },
};

const spring = (v: Animated.Value, to: number) =>
  Animated.spring(v, { toValue: to, useNativeDriver: true, speed: 14, bounciness: 8 }).start();
const pingPong = (v: Animated.Value, up: number, down: number, easing = Easing.linear) =>
  Animated.loop(
    Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: up, easing, useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: down, easing, useNativeDriver: true }),
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
  const float = useRef(new Animated.Value(0)).current; // 부유 0→1→0
  const blink = useRef(new Animated.Value(1)).current; // 눈 scaleY
  const beat = useRef(new Animated.Value(0)).current; // 말하기 들썩 · 타이핑 박자
  const bounce = useRef(new Animated.Value(0)).current; // 완료 폴짝
  const on = useRef(new Animated.Value(LOOK[mood].on)).current;
  const smile = useRef(new Animated.Value(LOOK[mood].smile)).current;
  const eyeX = useRef(new Animated.Value(LOOK[mood].x)).current;
  const eyeY = useRef(new Animated.Value(LOOK[mood].y)).current;
  const tilt = useRef(new Animated.Value(LOOK[mood].tilt)).current;
  const work = useRef(new Animated.Value(LOOK[mood].work)).current;

  // 부유는 늘 돈다 — 쉴 땐 느린 숨, 말할 땐 빠르게
  useEffect(() => {
    if (still) return float.setValue(0);
    const ms = mood === "speaking" ? 700 : mood === "idle" ? 2600 : 1700;
    const loop = pingPong(float, ms, ms, Easing.inOut(Easing.sin));
    loop.start();
    return () => loop.stop();
  }, [float, mood, still]);

  // 기분 → 모습은 스프링으로 옮겨 간다 (얼굴이 켜지고 꺼지는 것도)
  useEffect(() => {
    const look = LOOK[mood];
    // 멈춤 모드: 표정은 바뀌되 옮겨 가는 동작은 없다
    const to = still ? (v: Animated.Value, n: number) => v.setValue(n) : spring;
    to(on, look.on);
    to(smile, look.smile);
    to(eyeX, look.x);
    to(eyeY, look.y);
    to(tilt, look.tilt);
    to(work, look.work);
  }, [mood, on, smile, eyeX, eyeY, tilt, work, still]);

  // 깜빡임: 눈을 뜨고 있을 때만(듣는 중·승인 대기)
  useEffect(() => {
    if (still || (mood !== "listening" && mood !== "alert")) return;
    let timer: ReturnType<typeof setTimeout>;
    const once = () =>
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.08, duration: 70, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 120, useNativeDriver: true }),
      ]).start(() => {
        timer = setTimeout(once, 2600 + Math.random() * 2400);
      });
    timer = setTimeout(once, 900);
    return () => {
      clearTimeout(timer);
      blink.setValue(1);
    };
  }, [blink, mood, still]);

  // 박자: 말할 땐 눈이 들썩, 일할 땐 두 팔이 번갈아 자판을 친다
  useEffect(() => {
    if (still || (mood !== "speaking" && mood !== "thinking")) {
      beat.setValue(0);
      return;
    }
    const loop = mood === "thinking" ? pingPong(beat, 130, 130) : pingPong(beat, 150, 230);
    loop.start();
    return () => loop.stop();
  }, [beat, mood, still]);

  // 완료: 한 번 폴짝
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

  const lift = Animated.add(
    float.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.045] }),
    bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.14] }),
  );
  const rotate = tilt.interpolate({ inputRange: [-1, 1], outputRange: ["-8deg", "8deg"] });
  const talking = mood === "speaking";
  const scaleY = Animated.multiply(
    Animated.multiply(eyeY, blink),
    beat.interpolate({ inputRange: [0, 1], outputRange: [1, talking ? 0.75 : 1] }),
  );
  const eyeW = size * 0.15;
  const eyeH = size * 0.085;
  const eye = (side: -1 | 1) => (
    <Animated.View
      key={side}
      pointerEvents="none"
      style={{
        position: "absolute",
        top: size * 0.355 - eyeH / 2,
        left: size * 0.5 + side * size * 0.115 - eyeW / 2,
        width: eyeW,
        height: eyeH,
        opacity: on,
        transform: [{ rotate: side < 0 ? "-12deg" : "12deg" }, { scaleX: eyeX }, { scaleY }],
      }}
    >
      {/* 빛 번짐 — 웃을 땐 끈다(초승달 눈 둘레에 테처럼 남는다) */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: eyeH,
            backgroundColor: EYE,
            opacity: smile.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0] }),
            transform: [{ scale: 1.4 }],
          },
        ]}
      />
      {/* 눈 — 알약 모양으로 잘라 두고, 웃을 땐 아래에서 원으로 깎아 ∩ 모양 (깎는 원이 눈 밖으로 새지 않는다) */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: eyeH, backgroundColor: EYE, overflow: "hidden" },
        ]}
      >
        <Animated.View
          style={{
            position: "absolute",
            left: eyeW * 0.14,
            top: eyeH * 0.34,
            width: eyeW * 0.72,
            height: eyeW * 0.72,
            borderRadius: eyeW,
            backgroundColor: VISOR_MID,
            opacity: smile,
          }}
        />
      </View>
    </Animated.View>
  );
  // 볼 — 웃을 때만 살짝
  const cheek = (side: -1 | 1) => (
    <Animated.View
      key={`c${side}`}
      pointerEvents="none"
      style={{
        position: "absolute",
        top: size * 0.415,
        left: size * 0.5 + side * size * 0.185 - size * 0.03,
        width: size * 0.06,
        height: size * 0.032,
        borderRadius: size,
        backgroundColor: "#FF8FB1",
        opacity: Animated.multiply(smile, 0.55),
      }}
    />
  );
  // 팔 — 일할 땐 안쪽으로 모여 번갈아 까딱인다
  const arm = (side: -1 | 1) => (
    <Animated.View
      key={`a${side}`}
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [
            {
              translateX: work.interpolate({
                inputRange: [0, 1],
                outputRange: [0, -side * size * 0.07],
              }),
            },
            {
              translateY: Animated.add(
                work.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.03] }),
                Animated.multiply(
                  work,
                  beat.interpolate({
                    inputRange: [0, 1],
                    outputRange: side < 0 ? [0, -size * 0.035] : [-size * 0.035, 0],
                  }),
                ),
              ),
            },
          ],
        },
      ]}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Path
          d={
            side < 0
              ? "M24 58c-6 9-8 21-4 29 2 3 6 2 7-1 3-10 2-19 1-27-1-3-3-3-4-1z"
              : "M76 58c6 9 8 21 4 29-2 3-6 2-7-1-3-10-2-19-1-27 1-3 3-3 4-1z"
          }
          fill="url(#arm)"
        />
        <Defs>
          <LinearGradient id="arm" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" />
            <Stop offset="1" stopColor="#D9E2EA" />
          </LinearGradient>
        </Defs>
      </Svg>
    </Animated.View>
  );

  return (
    <View style={{ width: size, height: size * 1.08 }} accessibilityLabel="영시리">
      {/* 바닥 그림자 — 떠오를수록 작아진다 */}
      <Animated.View
        style={{
          position: "absolute",
          bottom: 0,
          left: size * 0.28,
          width: size * 0.44,
          height: size * 0.05,
          borderRadius: size,
          backgroundColor: "rgba(19,38,49,0.12)",
          transform: [
            { scaleX: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0.78] }) },
          ],
        }}
      />
      <Animated.View
        style={{ width: size, height: size, transform: [{ translateY: lift }, { rotate }] }}
      >
        {arm(-1)}
        {arm(1)}
        <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id="body" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#FFFFFF" />
              <Stop offset="1" stopColor="#D9E2EA" />
            </LinearGradient>
            <LinearGradient id="visor" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#1C2733" />
              <Stop offset="1" stopColor="#0E141B" />
            </LinearGradient>
          </Defs>
          <Path d="M34 57c0-4 32-4 32 0 6 17-3 38-16 38S28 74 34 57z" fill="url(#body)" />
          <Ellipse cx="50" cy="35" rx="30" ry="22" fill="url(#body)" />
          <Ellipse cx="50" cy="36.5" rx="26.5" ry="15.5" fill="url(#visor)" />
          <Ellipse cx="42" cy="26" rx="9" ry="3" fill="#FFFFFF" opacity="0.18" />
        </Svg>
        {/* 가슴 등 — 쉴 땐 희미하게, 켜지면 밝게 */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: size * 0.628,
            left: size * 0.468,
            width: size * 0.064,
            height: size * 0.064,
            borderRadius: size,
            backgroundColor: EYE,
            opacity: on.interpolate({ inputRange: [0, 1], outputRange: [0.22, 0.9] }),
          }}
        />
        {eye(-1)}
        {eye(1)}
        {cheek(-1)}
        {cheek(1)}
        {/* 노트북 — 우리는 뚜껑 뒷면을 본다. 일할 때만 올라온다 */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: work,
              transform: [
                {
                  translateY: work.interpolate({
                    inputRange: [0, 1],
                    outputRange: [size * 0.08, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Svg width={size} height={size} viewBox="0 0 100 100">
            <Defs>
              <LinearGradient id="lid" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#F6F8FB" />
                <Stop offset="1" stopColor="#C6D1DB" />
              </LinearGradient>
            </Defs>
            <Rect x="31" y="67" width="38" height="24" rx="3.5" fill="url(#lid)" />
            <Circle cx="50" cy="79" r="2.6" fill={EYE} opacity="0.9" />
            <Path
              d="M26 91h48l2.4 3.2a1.4 1.4 0 0 1-1.1 2.3H24.7a1.4 1.4 0 0 1-1.1-2.3z"
              fill="#AEBAC5"
            />
          </Svg>
        </Animated.View>
      </Animated.View>
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
  // 자산을 등록하지 않은 팀: 플랫폼 기본 팀장 캐릭터(카피바라) + 이름 해시로 고정한 배경색
  let h = 0;
  for (const ch of character) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <Mascot size={size} variant={h % 2 ? "sand" : "lilac"} />;
}
