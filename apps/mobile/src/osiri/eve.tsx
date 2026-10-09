// 영시리 캐릭터 — WALL-E 의 EVE 를 닮은 흰 달걀형 로봇(마스터 2026-10-10 "월이의 이브 같은 형태로").
// 몸·팔은 SVG 한 장, 눈은 Animated.View 두 개 — 모양·깜빡임·기분은 전부 transform 만 바꾼다(네이티브 드라이버).
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Defs, Ellipse, LinearGradient, Path, Stop } from "react-native-svg";

export type Mood = "idle" | "listening" | "thinking" | "speaking" | "happy" | "alert";

const EYE = "#5CD6FF";
const VISOR = "#0E141B";
// 기분별 눈 모양 (scaleX, scaleY) · 고개 기울기(-1~1)
const SHAPE: Record<Mood, { x: number; y: number; tilt: number }> = {
  idle: { x: 1, y: 1, tilt: 0 },
  listening: { x: 1.15, y: 1.2, tilt: 0.8 },
  thinking: { x: 1, y: 0.45, tilt: -0.6 },
  speaking: { x: 1, y: 1, tilt: 0 },
  happy: { x: 1.05, y: 1, tilt: 0 },
  alert: { x: 0.9, y: 1.35, tilt: 0 },
};

const spring = (v: Animated.Value, to: number) =>
  Animated.spring(v, { toValue: to, useNativeDriver: true, speed: 14, bounciness: 8 }).start();

export function Eve({ size = 120, mood = "idle" }: { size?: number; mood?: Mood }) {
  const float = useRef(new Animated.Value(0)).current; // 부유 0→1→0
  const blink = useRef(new Animated.Value(1)).current; // 눈 scaleY
  const talk = useRef(new Animated.Value(0)).current; // 말할 때 들썩
  const bounce = useRef(new Animated.Value(0)).current; // happy 폴짝
  const eyeX = useRef(new Animated.Value(1)).current;
  const eyeY = useRef(new Animated.Value(1)).current;
  const tilt = useRef(new Animated.Value(0)).current;
  const smile = useRef(new Animated.Value(0)).current; // happy 초승달 가림막

  // 부유는 늘 돈다 — 속도만 기분 따라 (말할 땐 빠르게, 생각할 땐 느리게)
  useEffect(() => {
    const ms = mood === "speaking" ? 700 : mood === "thinking" ? 2600 : 1900;
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: ms, easing: ease, useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: ms, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [float, mood]);

  // 기분 → 눈 모양·고개는 스프링으로 옮겨 간다
  useEffect(() => {
    const shape = SHAPE[mood];
    spring(eyeX, shape.x);
    spring(eyeY, shape.y);
    spring(tilt, shape.tilt);
    spring(smile, mood === "happy" ? 1 : 0);
  }, [mood, eyeX, eyeY, tilt, smile]);

  // 깜빡임: 2.6~5초마다 한 번. 생각 중·기쁠 땐 안 깜빡인다(눈이 이미 가늘다)
  useEffect(() => {
    if (mood === "happy" || mood === "thinking") return;
    let timer: ReturnType<typeof setTimeout>;
    const once = () =>
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.08, duration: 70, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 120, useNativeDriver: true }),
      ]).start(() => {
        timer = setTimeout(once, 2600 + Math.random() * 2400);
      });
    timer = setTimeout(once, 900);
    return () => clearTimeout(timer);
  }, [blink, mood]);

  // 말하기: 눈이 리듬 타듯 들썩인다
  useEffect(() => {
    if (mood !== "speaking") {
      talk.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(talk, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(talk, { toValue: 0, duration: 230, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [talk, mood]);

  // 기쁨: 한 번 폴짝
  useEffect(() => {
    if (mood !== "happy") return;
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
  }, [bounce, mood]);

  const lift = Animated.add(
    float.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.045] }),
    bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.14] }),
  );
  const rotate = tilt.interpolate({ inputRange: [-1, 1], outputRange: ["-8deg", "8deg"] });
  const scaleY = Animated.multiply(
    Animated.multiply(eyeY, blink),
    talk.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] }),
  );
  const eyeW = size * 0.15;
  const eyeH = size * 0.085;
  const eye = (side: -1 | 1) => {
    const base = {
      position: "absolute" as const,
      top: size * 0.355 - eyeH / 2,
      left: size * 0.5 + side * size * 0.115 - eyeW / 2,
      width: eyeW,
      height: eyeH,
      borderRadius: eyeH,
    };
    const slant = { rotate: side < 0 ? "-14deg" : "14deg" };
    return (
      <View key={side} pointerEvents="none" style={StyleSheet.absoluteFill}>
        {/* 빛 번짐 */}
        <Animated.View
          style={{
            ...base,
            backgroundColor: EYE,
            opacity: 0.35,
            transform: [slant, { scale: 1.45 }, { scaleX: eyeX }, { scaleY }],
          }}
        />
        <Animated.View
          style={{
            ...base,
            backgroundColor: EYE,
            transform: [slant, { scaleX: eyeX }, { scaleY }],
          }}
        />
        {/* 기쁠 때 아래를 가려 초승달 눈 */}
        <Animated.View
          style={{
            ...base,
            backgroundColor: VISOR,
            opacity: smile,
            transform: [
              slant,
              { translateY: eyeH * 0.55 },
              { scaleX: Animated.multiply(eyeX, 1.3) },
              { scaleY },
            ],
          }}
        />
      </View>
    );
  };

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
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Defs>
            <LinearGradient id="body" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#FFFFFF" />
              <Stop offset="1" stopColor="#D9E2EA" />
            </LinearGradient>
            <LinearGradient id="visor" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#1C2733" />
              <Stop offset="1" stopColor={VISOR} />
            </LinearGradient>
          </Defs>
          {/* 팔 — 몸에서 떨어져 떠 있는 두 조각 */}
          <Path
            d="M24 58c-6 9-8 21-4 29 2 3 6 2 7-1 3-10 2-19 1-27-1-3-3-3-4-1z"
            fill="url(#body)"
          />
          <Path
            d="M76 58c6 9 8 21 4 29-2 3-6 2-7-1-3-10-2-19-1-27 1-3 3-3 4-1z"
            fill="url(#body)"
          />
          {/* 몸 */}
          <Path d="M34 57c0-4 32-4 32 0 6 17-3 38-16 38S28 74 34 57z" fill="url(#body)" />
          <Ellipse cx="50" cy="66" rx="3.2" ry="3.2" fill={EYE} opacity="0.85" />
          {/* 머리 + 바이저 */}
          <Ellipse cx="50" cy="35" rx="30" ry="22" fill="url(#body)" />
          <Ellipse cx="50" cy="36.5" rx="26.5" ry="15.5" fill="url(#visor)" />
          <Ellipse cx="42" cy="26" rx="9" ry="3" fill="#FFFFFF" opacity="0.18" />
        </Svg>
        {eye(-1)}
        {eye(1)}
      </Animated.View>
    </View>
  );
}
