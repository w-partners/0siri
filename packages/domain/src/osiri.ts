// 0Siri 공용 상수 (SSOT). 서버·앱이 같은 목록·라벨을 여기서만 가져온다.
// 순수 TS — node 전용 import 금지(React Native 가 그대로 import 한다). zod 스키마는 서버가 z.enum(X) 로 만든다.

// ---- 방 캐릭터 상태 (0SIRI-SPEC §5) ----
export const PRESENCE_STATES = ["working", "waiting", "done", "idle"] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];
export const PRESENCE_LABELS: Record<PresenceState, string> = {
  working: "작업 중",
  waiting: "승인 대기 중",
  done: "완료",
  idle: "휴식 중",
};
/** 워커가 직접 알릴 수 있는 상태. "waiting" 은 서버가 승인 카드에서만 판정한다. */
export const WORKER_PRESENCE_STATES = ["working", "done", "idle"] as const;
export type WorkerPresenceState = (typeof WORKER_PRESENCE_STATES)[number];

// ---- 활동 (§4.4, §10) ----
export const ACTIVITY_KINDS = [
  "approval",
  "publish",
  "report",
  "error",
  "goal",
  "system",
  "skill",
  "subscription",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  approval: "승인 요청",
  publish: "발행",
  report: "보고",
  error: "오류",
  goal: "목표 갱신",
  system: "알림",
  skill: "스킬",
  subscription: "구독",
};

// ---- 현황판 흐름 단계 · 목표 (§8) ----
export const BOARD_STAGES = [
  "detect",
  "draft",
  "geo",
  "review",
  "approval",
  "publish",
  "done",
] as const;
export type TaskStage = (typeof BOARD_STAGES)[number];
export const GOAL_LEVELS = ["long", "mid", "short", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];
export const GOAL_STATUSES = ["active", "paused", "completed", "blocked"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// ---- 계정 (§4.1, §20) ----
export const USER_ROLES = ["user", "operator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];
/** 파일럿(지인 20명) 기준. 마스터가 지정한 관리자 비밀번호 길이가 4다 */
export const PASSWORD_MIN = 4;

// ---- 스토어 (§4.6, §6) ----
/** 화면에 내는 카테고리 칩. "전체" 는 값이 아니라 필터 없음이다. */
export const STORE_CATEGORIES = ["legal", "content", "office"] as const;
/** 이전에 쓰던 id — 저장된 패키지가 깨지지 않게 계속 받는다. 칩으로는 내지 않는다. */
export const LEGACY_STORE_CATEGORIES = ["medical", "marketing", "other"] as const;
export const STORE_CATEGORY_IDS = [...STORE_CATEGORIES, ...LEGACY_STORE_CATEGORIES] as const;
export type StoreCategory = (typeof STORE_CATEGORY_IDS)[number];
export const STORE_CATEGORY_LABELS: Record<StoreCategory, string> = {
  legal: "법률",
  content: "콘텐츠",
  office: "사무",
  medical: "의료",
  marketing: "마케팅",
  other: "기타",
};
export const STORE_CATEGORY_ALL_LABEL = "전체";
/** 해지·탈퇴 후 데이터 보존 일수 (§6.2, §15.4.5, §24-13) */
export const RETENTION_DAYS = 30;
/** 팀 패키지·팀 YAML 이 반드시 가져야 하는 역할 키. 패키지 등록과 런타임 로드가 같은 목록을 본다. */
export const REQUIRED_TEAM_ROLES = ["root", "reviewer", "publisher", "analyst"] as const;
export type RequiredTeamRole = (typeof REQUIRED_TEAM_ROLES)[number];
/** 빠진 필수 역할 키. 비어 있으면 통과. */
export const missingTeamRoles = (names: readonly string[]): RequiredTeamRole[] =>
  REQUIRED_TEAM_ROLES.filter((role) => !names.includes(role));

// ---- 모델 라우팅 (§11, §13) ----
export const MODEL_PROVIDERS = ["openai", "anthropic", "google"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const MODEL_TIERS = [0, 1, 2, 3, 4] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
/** 사용자가 고정할 수 있는 서버 티어 */
export const FIXED_TIERS = [2, 3, 4] as const;
export type FixedTier = (typeof FIXED_TIERS)[number];
export const TIER_LABELS: Record<ModelTier, string> = {
  0: "기기 임베딩",
  1: "기기 LLM",
  2: "경량",
  3: "주력",
  4: "최고",
};
export const ROUTE_KINDS = ["chat", "monitor", "draft", "review", "report", "strategy"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
/** 답변 출처 (§11.1 배지, 메시지 answered_by.source) */
export const ANSWER_SOURCES = ["device", "server", "byok"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];
export const ANSWER_SOURCE_LABELS = {
  device: "기기에서 답함",
  server: "서버에서 답함",
  byok: "내 모델 계정으로 답함",
} as const satisfies Record<AnswerSource, string>;

// ---- 임베딩 (§11 티어 0, §22-5) ----
export const EMBED_MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const EMBED_DTYPE = "q8";
/** 위 모델(q8, 텍스트 전용)의 내려받기 크기. 안내 문구의 숫자는 이것 하나만 쓴다. */
export const EMBED_DOWNLOAD_MB = 299;
export const EMBED_QUERY_PREFIX = "task: search result | query: ";
export const EMBED_DOCUMENT_DEFAULT_TITLE = "none";
export const embedQueryText = (text: string) => `${EMBED_QUERY_PREFIX}${text}`;
export const embedDocumentText = (text: string, title: string = EMBED_DOCUMENT_DEFAULT_TITLE) =>
  `title: ${title} | text: ${text}`;

// ---- 개인 방 (일반 등급) ----
export const PERSONAL_CHARACTER_ID = "yeongsil";
export const PERSONAL_ROOM_TITLE = "영시리";
