// 영시리 기분 → 포즈 그림 (0Siri_ClaudeCode_Kit, 마스터 2026-10-11). 그림 파일은 assets/osiri/<포즈>.png
// React Native 없이 테스트하려고 eve.tsx 에서 뗐다.

/** idle=쉼 · listening=듣는 중 · thinking=일하는 중 · speaking=말하는 중 · happy=완료 · alert=승인 대기 */
export type Mood = "idle" | "listening" | "thinking" | "speaking" | "happy" | "alert";
export const POSES = [
  "idle",
  "resting",
  "sleeping",
  "working",
  "working_alt",
  "thinking",
  "success",
] as const;
export type Pose = (typeof POSES)[number];

/** 오래 쉬면 눈을 감고(resting) 더 오래면 잠든다(sleeping) — 큰 캐릭터만. 목록의 작은 얼굴은 늘 깨어 있다 */
export const DOZE_MS = 45_000;
export const SLEEP_MS = 4 * 60_000;
export const DOZE_MIN_SIZE = 80;
/** 일하는 중 두 포즈를 번갈아 보이는 간격 */
export const WORK_SWAP_MS = 900;

/** drowse: 0 깨어 있음 · 1 졸음 · 2 잠. alt: 일하는 중 두 번째 포즈 차례 */
export function poseFor(mood: Mood, drowse: 0 | 1 | 2 = 0, alt = false): Pose {
  if (mood === "idle" && drowse) return drowse === 2 ? "sleeping" : "resting";
  if (mood === "thinking") return alt ? "working_alt" : "working";
  if (mood === "happy") return "success";
  // 승인 대기 = 고개를 갸웃(생각하는 포즈). 오류 전용 포즈는 키트에 없다
  if (mood === "alert") return "thinking";
  return "idle";
}

/** 화면 낭독용 상태 문구 */
export const POSE_LABEL: Record<Pose, string> = {
  idle: "기다리는 중",
  resting: "쉬는 중",
  sleeping: "자는 중",
  working: "일하는 중",
  working_alt: "일하는 중",
  thinking: "확인을 기다리는 중",
  success: "끝냈어요",
};
