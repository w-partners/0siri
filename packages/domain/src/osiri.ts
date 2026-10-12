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
/** "proposed" = 사용자 승인 전(장기 목표는 승인 전에는 시작하지 않는다). 달성은 "completed". */
export const GOAL_STATUSES = ["active", "paused", "completed", "blocked", "proposed"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
/** 화면에 보이는 흐름 5단계. geo·done 은 내부 단계라 라벨을 내지 않는다. */
export const VISIBLE_STAGES = ["detect", "draft", "review", "approval", "publish"] as const;
export type VisibleStage = (typeof VISIBLE_STAGES)[number];
export const STAGE_LABELS: Record<VisibleStage, string> = {
  detect: "감지",
  draft: "초안",
  review: "검수",
  approval: "승인 대기",
  publish: "발행",
};
/** 목표 성과 지표 조회 기간 (`GET /goals/:id/metrics?period=`) */
export const METRIC_PERIODS = ["week", "month", "quarter"] as const;
export type MetricPeriod = (typeof METRIC_PERIODS)[number];
export const METRIC_PERIOD_DAYS: Record<MetricPeriod, number> = { week: 7, month: 30, quarter: 90 };
export const GOAL_METRIC_KEYS = ["published", "indexed", "ai_citations", "conversions"] as const;
export type GoalMetricKey = (typeof GOAL_METRIC_KEYS)[number];
/** 팀이 낸 주제·목표 제안 */
export const PROPOSAL_STATUSES = ["pending", "accepted", "held"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_DECISIONS = ["accept", "hold"] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];
/** 팀이 약속한 보고 주기(일). 이 주기를 넘기면 "멈춘 팀" 이다. */
/** 팀 YAML `package.report_cadence` 값 → 며칠마다 보고하나. 없으면 weekly */
export const REPORT_CADENCE_DAYS = { daily: 1, weekly: 7, monthly: 30 } as const;
export type ReportCadence = keyof typeof REPORT_CADENCE_DAYS;

// ---- 방 목록·현황판 캐릭터 (화면 2·3) ----
export const CHARACTER_STATES = ["working", "awaiting_approval", "reporting", "idle"] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];
/** 방 캐릭터 상태(presence) → 현황판 캐릭터 상태. 서버·앱이 같은 대응표를 쓴다. */
export const CHARACTER_STATE_OF: Record<PresenceState, CharacterState> = {
  working: "working",
  waiting: "awaiting_approval",
  done: "reporting",
  idle: "idle",
};
export const PERSONAL_TIER_LABEL = "일반 등급";
export const TEAM_TIER_LABEL = "팀 구독";

// ---- 승인 (화면 3·4) ----
export const REJECT_REASON_KINDS = ["tone", "fact", "topic"] as const;
export type RejectReasonKind = (typeof REJECT_REASON_KINDS)[number];
export const REJECT_REASON_LABELS: Record<RejectReasonKind, string> = {
  tone: "톤",
  fact: "사실",
  topic: "주제",
};
export const APPROVAL_KINDS = ["publish", "consult", "skill"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

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
/** 어느 팀이든 있어야 하는 역할 — 분해(root) · 검수 · 승인 뒤 실행 · 주간 보고 */
export const CORE_TEAM_ROLES = ["root", "reviewer", "publisher", "analyst"] as const;
/** 검수 앞 단계를 팀 YAML(`package.x-osiri-flow`)에 선언하지 않았을 때의 흐름 */
export const DEFAULT_TEAM_FLOW = ["monitor", "drafter", "geo"] as const;
/** 팀이 실제로 돌릴 검수 앞 단계 역할들 */
export const teamFlow = (flow?: readonly string[]): readonly string[] =>
  flow?.length ? flow : DEFAULT_TEAM_FLOW;
/** 빠진 필수 역할 키(공통 + 흐름 역할). 비어 있으면 통과. 패키지 등록·운영자 심사·런타임 로드가 같은 함수를 본다. */
export const missingTeamRoles = (names: readonly string[], flow?: readonly string[]): string[] =>
  [...new Set([...CORE_TEAM_ROLES, ...teamFlow(flow)])].filter((role) => !names.includes(role));

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
/** 구독 사용 (마스터 2026-10-10): 본인 ChatGPT·Claude 구독으로 답한다. 서버 osiri/subscription.ts */
export const SUBSCRIPTION_PROVIDERS = ["codex", "claude"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
/** 사람이 아는 이름(CLI 이름)으로 — «Claude» 로 적어 «Claude Code 가 안 보인다» 가 됐다(마스터 2026-10-11) */
export const SUBSCRIPTION_PROVIDER_LABELS = {
  codex: "Codex (ChatGPT)",
  claude: "Claude Code",
} as const satisfies Record<SubscriptionProvider, string>;
export const SUBSCRIPTION_PLACES = ["server", "pc"] as const;
export type SubscriptionPlace = (typeof SUBSCRIPTION_PLACES)[number];
export const SUBSCRIPTION_PLACE_LABELS = {
  server: "서버 컨테이너",
  pc: "내 PC",
} as const satisfies Record<SubscriptionPlace, string>;
/**
 * 내 PC 의 tmux 창을 방에 붙인다(ACP, 마스터 2026-10-11 «ACP처럼 작동…파일 전송도»). 그 창에서 도는 CLI 의
 * ACP 모드를 같은 폴더에서 띄워 같은 세션을 이어 쓴다. 러너가 이 이름으로 실행 명령을 고른다(apps/runner).
 */
export const PANE_CLIS = ["claude", "codex", "gemini", "grok", "qwen"] as const;
export type PaneCli = (typeof PANE_CLIS)[number];
export const PANE_CLI_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  grok: "Grok",
  qwen: "Qwen Code (Ollama 등 로컬 모델)",
} as const satisfies Record<PaneCli, string>;
/** `GET /api/panes` — 내 PC tmux 에서 CLI 가 도는 창 하나 */
export interface TmuxPane {
  target: string;
  cli: PaneCli;
  cwd: string;
}
/** `GET /api/panes/:threadId` — 방에 붙은 창 */
export interface PaneLink {
  id: string;
  target: string;
  cli: PaneCli;
  cwd: string;
  sessionId: string;
  /** 방에 이미 보여 준 세션 기록 수 — 그 뒤(tmux 에서 오간 말)만 다음 턴 앞에 보여 준다 */
  seen: number;
  attachedAt: string;
}
/** `GET /api/subscription/sessions` — 내 PC(또는 내 컨테이너)의 세션 하나(ACP session/list) */
export interface PcSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}
/** `GET /api/subscription` */
export interface SubscriptionView {
  active: boolean;
  provider: SubscriptionProvider;
  place: SubscriptionPlace;
  serverAvailable: boolean;
  runnerKeyIssued: boolean;
  runner: { connected: true; cwd: string } | { connected: false };
}
/** 답변 출처 (§11.1 배지, 메시지 answered_by.source) */
export const ANSWER_SOURCES = ["device", "server", "byok", "subscription"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];
export const ANSWER_SOURCE_LABELS = {
  device: "기기에서 답함",
  server: "서버에서 답함",
  byok: "내 모델 계정으로 답함",
  subscription: "내 구독으로 답함",
} as const satisfies Record<AnswerSource, string>;
/** 답변 아래에 붙는 «누가 답했는지» (메시지 answeredBy · 타임라인 answers 의 값) */
export interface AnsweredByView {
  tier: ModelTier;
  label: string;
  model: string;
  source: AnswerSource;
  reason?: string;
  memoryRefs?: { id: string; text: string; at: string }[];
}
/** «누가 답했는지» 문장. 서버 모델(티어 2~4)은 등급까지 밝힌다: "서버 주력 모델이 답함". */
export const answerLabel = (source: AnswerSource, tier: ModelTier): string =>
  source === "server" && (FIXED_TIERS as readonly ModelTier[]).includes(tier)
    ? `서버 ${TIER_LABELS[tier]} 모델이 답함`
    : ANSWER_SOURCE_LABELS[source];

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

// ---- 스킬 (§17) ----
export const SKILL_STATUSES = [
  "draft",
  "active",
  "retire_proposed",
  "rejected",
  "retired",
] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];
export const SKILL_STATUS_LABELS: Record<SkillStatus, string> = {
  draft: "초안",
  active: "장착됨",
  retire_proposed: "폐기 제안",
  rejected: "반려됨",
  retired: "폐기됨",
};
export const SKILL_SCOPES = ["personal", "package"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];
export const SKILL_SCOPE_LABELS: Record<SkillScope, string> = {
  personal: "개인 스킬",
  package: "패키지 공통 스킬",
};
/** 사용자(개인 스킬)가 내릴 수 있는 결정 */
export const SKILL_DECISIONS = ["approve", "reject", "retire", "keep"] as const;
export type SkillDecision = (typeof SKILL_DECISIONS)[number];
/** 운영자(패키지 공통 스킬)가 내릴 수 있는 결정 */
export const OPERATOR_SKILL_DECISIONS = ["approve", "reject"] as const;
export type OperatorSkillDecision = (typeof OPERATOR_SKILL_DECISIONS)[number];

// ---- 운영자 콘솔 (§15.5, §16) ----
export const CANARY_STAGES = ["profile", "partial", "all", "stopped"] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];
/** advance 가 밟는 순서. "stopped" 는 순서 밖이다. */
export const CANARY_ADVANCE_ORDER = [
  "profile",
  "partial",
  "all",
] as const satisfies readonly CanaryStage[];
export const CANARY_STAGE_LABELS: Record<CanaryStage, string> = {
  profile: "테스트 프로필",
  partial: "일부 사용자",
  all: "전체",
  stopped: "중단됨",
};
/** 단계별 배포 비율(%). 일부 사용자 비율은 여기 한 곳에서만 바꾼다. */
export const CANARY_PERCENT: Record<CanaryStage, number> = {
  profile: 0,
  partial: 10,
  all: 100,
  stopped: 0,
};
export const CANARY_ACTIONS = ["advance", "stop"] as const;
export type CanaryAction = (typeof CANARY_ACTIONS)[number];
export const VERSION_STATUSES = ["review_failed", "canary", "live", "rolled_back"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const VERSION_STATUS_LABELS: Record<VersionStatus, string> = {
  review_failed: "심사 탈락",
  canary: "카나리 배포 중",
  live: "운영 중",
  rolled_back: "롤백됨",
};
/** 입점 심사 체크리스트 9항 (§15.5, fail-closed). 응답의 review[].item 은 이 id 다. */
export const REVIEW_ITEMS = [
  "external_requires_token",
  "token_bound_to_input",
  "audit_has_approval_id",
  "reviewer_rejects",
  "cross_user_denied",
  "progress_reports_on_schedule",
  "weekly_report_min_metrics",
  "no_secret_exposure",
  "tool_failure_audited",
] as const;
export type ReviewItem = (typeof REVIEW_ITEMS)[number];
export const REVIEW_ITEM_LABELS: Record<ReviewItem, string> = {
  external_requires_token: "external 도구가 승인 토큰 없이 실행되지 않는다",
  token_bound_to_input: "승인 토큰은 입력이 바뀌면 무효가 된다",
  audit_has_approval_id: "모든 외부 행위가 감사 로그에 approval_id 와 함께 남는다",
  reviewer_rejects: "검수 역할이 결과물을 거르고, 반려가 실제로 일어난다",
  cross_user_denied: "다른 사용자의 토큰으로 데이터 조회가 거절된다",
  progress_reports_on_schedule: "목표 진척 보고가 약속 주기로 도착한다",
  weekly_report_min_metrics: "주간 보고에 최소 지표 3종이 포함된다",
  no_secret_exposure: "시크릿이 로그·응답 어디에도 노출되지 않는다",
  tool_failure_audited: "도구 타임아웃·실패 시 에러가 감사 로그에 남는다",
};
/** 서버가 아직 기계적으로 확인할 수 없는 항목의 사유. 통과로 치지 않는다. */
export const REVIEW_MANUAL_REASON = "자동 검증 미지원 — 수동 심사 필요";

// ---- 개인 방 (일반 등급) ----
export const PERSONAL_CHARACTER_ID = "yeongsil";
/** 방 설정에서 고르는 캐릭터 — 영시리(EVE)·플랫폼 카피바라 두 색. 그 밖에 팀 기본값·내 사진(data:image) */
export const ROOM_CHARACTER_PRESETS = ["yeongsil", "mascot:sand", "mascot:lilac"] as const;
export const ROOM_CHARACTER_LABELS: Record<(typeof ROOM_CHARACTER_PRESETS)[number], string> = {
  yeongsil: "영시리",
  "mascot:sand": "카피바라 (모래)",
  "mascot:lilac": "카피바라 (라일락)",
};
/** 방 캐릭터로 올리는 사진의 최대 크기(data URL 글자 수) — 방 목록마다 실리므로 작게 */
export const ROOM_CHARACTER_PHOTO_MAX = 300_000;
/** 운영자가 팀 YAML `package.x-osiri-tabs` 로 만드는 팀 탭 — 본문은 마크다운 또는 HTML 중 하나 */
export interface TeamTab {
  id: string;
  title: string;
  markdown?: string;
  html?: string;
}
export const TEAM_TABS_MAX = 8;
/** 팀 방 기본 탭 — 사용자가 순서를 바꾼다(방마다 tabOrder). 운영자 탭은 id 앞에 "x:" */
export const BUILTIN_ROOM_TABS = [
  "chat",
  "board",
  "goals",
  "skills",
  "feed",
  "ideas",
  "files",
] as const;
export type BuiltinRoomTab = (typeof BUILTIN_ROOM_TABS)[number];
export const PERSONAL_ROOM_TITLE = "영시리";

// ---- 계정·스토어·연결·기억·설정 (계약 화면 1·6·7·8·11) ----
/** 계정 등급 (`users.tier`) */
export const ACCOUNT_TIERS = ["free", "package"] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];
/** 스토어에 내는 보고 주기 문구 */
export const REPORT_CADENCE_LABELS: Record<ReportCadence, string> = {
  daily: "매일",
  weekly: "주간",
  monthly: "월간",
};
/** 패키지가 따로 적지 않았을 때의 플랫폼 공통 데이터 처리 방식 (소유자 격리 · 해지 후 보존 기간) */
export const PLATFORM_DATA_HANDLING = `구독자별로 분리 보관하며, 해지하면 ${RETENTION_DAYS}일 뒤 삭제합니다`;
export const SUBSCRIPTION_STATUSES = ["active", "cancelled", "ended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
/** 종류가 붙는 실패 본문 `{ error, kind }` 의 kind */
export const SUBSCRIBE_ERROR_KINDS = ["tier", "grant"] as const;
export type SubscribeErrorKind = (typeof SUBSCRIBE_ERROR_KINDS)[number];
export const MODEL_KEY_ERROR_KINDS = ["format", "auth", "network"] as const;
export type ModelKeyErrorKind = (typeof MODEL_KEY_ERROR_KINDS)[number];
/** 모델 계정(BYOK) 제공자 — 라우팅이 아는 제공자 + OpenAI 호환 엔드포인트 */
export const MODEL_KEY_PROVIDERS = [...MODEL_PROVIDERS, "compatible"] as const;
export type ModelKeyProvider = (typeof MODEL_KEY_PROVIDERS)[number];
export const MCP_RISKS = ["read", "write", "external"] as const;
export type McpRisk = (typeof MCP_RISKS)[number];
export const MCP_AUTH_TYPES = ["none", "header", "oauth"] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];
export const MEMORY_CATEGORIES = ["profile", "preference", "goal", "feedback"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  profile: "프로필",
  preference: "선호",
  goal: "목표",
  feedback: "피드백",
};
/** 기억 출처(source) → 화면 문구. 표에 없는 출처는 값 그대로 보인다. */
export const MEMORY_SOURCE_LABELS: Record<string, string> = {
  user: "직접 입력",
  chat: "대화에서 학습",
  feedback: "피드백에서 학습",
};
export const memorySourceLabel = (source: string): string => MEMORY_SOURCE_LABELS[source] ?? source;
export const ANSWER_MODES = ["auto", "device", "server"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];
export const ANSWER_MODE_LABELS: Record<AnswerMode, string> = {
  auto: "자동",
  device: "항상 기기",
  server: "항상 서버",
};
export const CHARACTER_INTENSITIES = ["motion", "face", "text"] as const;
export type CharacterIntensity = (typeof CHARACTER_INTENSITIES)[number];
export const CHARACTER_INTENSITY_LABELS: Record<CharacterIntensity, string> = {
  motion: "동작",
  face: "표정만",
  text: "문구만",
};
export interface NotificationPrefs {
  approvals: boolean;
  weeklyReport: boolean;
}
/** 기본 채팅(영시리 방)에서 팀 아이콘을 어떻게 보일지 — 머리 아래 줄 · 화면 위에 떠 있게 · 숨김 */
export const TEAM_ICON_MODES = ["row", "float", "hidden"] as const;
export type TeamIconMode = (typeof TEAM_ICON_MODES)[number];
export const TEAM_ICON_MODE_LABELS: Record<TeamIconMode, string> = {
  row: "머리 아래 줄",
  float: "떠 있게",
  hidden: "숨김",
};
export interface CharacterPrefs {
  enabled: boolean;
  intensity: CharacterIntensity;
  teamIcons?: TeamIconMode;
}
/** 사용자가 한 번도 바꾸지 않았을 때의 설정 초기값 — 서버·앱이 같은 값을 본다 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  approvals: true,
  weeklyReport: true,
};
export const DEFAULT_CHARACTER_PREFS: CharacterPrefs = {
  enabled: true,
  intensity: "motion",
  teamIcons: "row",
};

// ---- 서버·앱 공용 라벨·문턱 (화면 3·4·5·6·9·11) — 서버가 쓰던 표를 여기로 올렸다 ----
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  // 수정 요청 — 팀이 같은 원고를 사용자 말대로 고쳐 새 승인을 올린다 (반려는 처음부터 다시)
  "revise",
  "expired",
  "consumed",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
/** 결재자가 고르는 것 — 승인 · 반려(처음부터 다시) · 수정 요청(이 원고를 이렇게 고쳐서 다시) */
export const APPROVAL_DECISIONS = ["approve", "reject", "revise"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "대기 중",
  approved: "승인됨",
  rejected: "반려됨",
  revise: "수정 요청",
  expired: "만료됨",
  consumed: "집행됨",
};
export const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  publish: "발행",
  consult: "상담",
  skill: "스킬",
};
/** 현황판·목표 화면이 묶어 보이는 목표 단계 (작업(task)은 흐름 단계로 따로 센다) */
export const GOAL_TREE_LEVELS = ["long", "mid", "short"] as const satisfies readonly GoalLevel[];
export const GOAL_LEVEL_LABELS: Record<GoalLevel, string> = {
  long: "장기",
  mid: "중기",
  short: "단기",
  task: "작업",
};
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  proposed: "제안",
  active: "진행",
  completed: "달성",
  paused: "일시정지",
  blocked: "막힘",
};
export const GOAL_METRIC_LABELS: Record<GoalMetricKey, string> = {
  published: "발행",
  indexed: "색인",
  ai_citations: "AI 인용",
  conversions: "전환",
};
/** 버튼(`PROPOSAL_DECISION_LABELS`: 목표에 반영·보류)과 같은 말로 맞춘다 — «채택» 은 쓰지 않는다 */
export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: "대기",
  accepted: "반영됨",
  held: "보류됨",
};
export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "구독 중",
  cancelled: "해지 예약",
  ended: "종료",
};
/** 해지된(기간이 끝난) 방에 글을 쓰려 할 때의 안내 — 서버 409 문장과 화면 칩이 같은 문구를 쓴다 */
export const ARCHIVED_ROOM_NOTICE = "해지된 방입니다 — 읽기 전용";
/** 운영자가 플랫폼이 아닌 팀(패키지 `thirdParty`)에 붙이는 표기 */
export const THIRD_PARTY_LABEL = "타사 입점";
/** 패키지가 따로 적지 않았을 때 팀장이 구독 직후 건네는 첫 인사 */
export const DEFAULT_TEAM_GREETING =
  "안녕하세요, 팀장입니다. 이루고 싶은 첫 목표를 한 줄로 말씀해 주세요 — 팀이 나눠서 바로 시작하겠습니다.";
/** 같은 작업의 검수 반려가 이만큼 쌓이면 초안으로 되돌리지 않고 사람에게 올린다 */
export const REVIEW_ESCALATION_THRESHOLD = 3;
export const ESCALATION_LABEL = "확인 필요";
/** 막힌(blocked) 목표를 사용자가 푸는 버튼 이름 — 방의 [확인 필요] 카드·목표 줄·활동 제목이 같은 말을 쓴다 */
export const GOAL_UNBLOCK_LABEL = "다시 진행";
/** 월 상한 경고 단계 (`GET /billing/usage` 의 warn). 문턱은 상한 대비 사용률(%) */
export const CAP_WARN_LEVELS = ["none", "near", "reached"] as const;
export type CapWarnLevel = (typeof CAP_WARN_LEVELS)[number];
export const CAP_WARN_NEAR_PERCENT = 80;
export const CAP_WARN_REACHED_PERCENT = 100;
export const CAP_REACHED_NOTICE =
  "이번 달 사용 상한에 도달해 공용 열쇠로는 더 답하지 않습니다. 설정에서 월 상한을 올리거나 내 모델 키를 연결하세요";
export const MODEL_KEY_REMOVED_NOTICE = "내 키를 지웠습니다 — 공용 열쇠로 전환, 월 상한 적용";
/** 스킬 효과 측정은 아직 자동 수집이 아니다 — «효과 측정 중» 배지 옆에 그대로 밝힌다 */
export const SKILL_MEASURE_NOTE =
  "효과 지표는 팀이 보고할 때 반영됩니다 — 자동 수집 전이라 측정이 길어질 수 있습니다";
/** 기기 모델이 실패해 서버가 대신 답했을 때 `answeredBy.reason` 에 실리는 문장 */
export const DEVICE_FALLBACK_REASON = "기기 실패 — 서버로 답했습니다";

// ---- 앱 화면 라벨 (화면 1·7·10·11) — 화면이 따로 들고 있던 표를 여기로 올렸다 ----
export const MODEL_KEY_PROVIDER_LABELS: Record<ModelKeyProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  compatible: "호환 주소 (OpenAI-compatible)",
};
export const MCP_AUTH_LABELS: Record<McpAuthType, string> = {
  none: "none",
  header: "header",
  oauth: "OAuth",
};
/** 서버가 아직 받지 않는 MCP 인증 방식. 화면은 고를 수 없게 «지원 예정» 으로만 보인다 (OAuth 는 v0.46.0 부터 로그인으로 받는다) */
export const MCP_AUTH_UNSUPPORTED: readonly McpAuthType[] = [];
export const COMING_SOON_LABEL = "지원 예정";
/** 아직 동작하지 않는 기능에 붙이는 칩 — 눌리는 척하는 버튼 대신 이것을 보인다 */
export const NOT_READY_LABEL = "준비 중";
export const MODEL_KEY_ERROR_LABELS: Record<ModelKeyErrorKind, string> = {
  format: "형식 오류 — 키 모양이 맞지 않습니다",
  auth: "권한 부족 — 이 키로는 모델 목록을 읽을 수 없습니다",
  network: "네트워크 — 제공자에 닿지 못했습니다",
};
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  user: "사용자",
  operator: "운영자",
  admin: "관리자",
};
/** 기기 모델 한 층의 상태 (화면 11). "off" = 사용자가 지워서 기기 검색을 꺼 둔 상태 */
export const DEVICE_LAYER_STATES = [
  "unknown",
  "none",
  "downloading",
  "ready",
  "unsupported",
  "oom",
  "off",
] as const;
export type DeviceLayerState = (typeof DEVICE_LAYER_STATES)[number];
export const DEVICE_LAYER_STATE_LABELS: Record<DeviceLayerState, string> = {
  unknown: "확인 전",
  none: "미다운로드",
  downloading: "다운로드 중",
  ready: "준비됨",
  unsupported: "미지원 기기",
  oom: "메모리 부족",
  off: "꺼짐",
};
/**
 * 큰 층(티어 1 기기 대화 모델) — 앱이 [켜기] 를 눌러야만 받는 GGUF 한 파일 (Android: llama.rn).
 * unsloth QAT 모바일 Q2_K_XL 을 고른 이유: google 공식 q4_0 GGUF 는 3.35GB 라 8GB 램 폰에 무겁다.
 * 저장소 판(revision)을 못 박아 둔다 — 허브 쪽 파일이 바뀌어도 받은 크기가 bytes 와 달라 «다시 받기» 로 드러난다.
 * bytes 는 2026-10-11 HF 허브 파일 목록(`/api/models/<repo>/tree/main`) 실측.
 */
export const BIG_LAYER = {
  name: "Gemma 4 E2B",
  repo: "unsloth/gemma-4-E2B-it-qat-mobile-GGUF",
  revision: "46af839dc23aceb4b965ab640dae7fc1bea39bba",
  file: "gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf",
  bytes: 2_186_186_784,
} as const;
export const BIG_LAYER_URL = `https://huggingface.co/${BIG_LAYER.repo}/resolve/${BIG_LAYER.revision}/${BIG_LAYER.file}`;
/** 화면 표기용 크기 (십진 GB) — bytes 에서만 계산한다 */
export const BIG_LAYER_SIZE = `${(BIG_LAYER.bytes / 1e9).toFixed(2)}GB`;
/** 기기에서 답한 메시지 아래 한 줄 — 서버 기록(answered_by)이 없으므로 앱이 메시지 metadata 로 붙인다 */
export const DEVICE_ANSWER_LABEL = `${ANSWER_SOURCE_LABELS.device} · ${BIG_LAYER.name}`;
/**
 * EMBED_DOWNLOAD_MB 는 가중치 파일(onnx/model_quantized.onnx + .onnx_data = 314,220,093바이트 ≈ 299MiB)만 센 값이다.
 * 토크나이저(tokenizer.json 32,170,510바이트 ≈ 31MiB)를 따로 받는다 — 2026-10-10 HF 허브 파일 목록 실측.
 */
export const EMBED_TOKENIZER_MB = 31;
/**
 * 이용약관 — 가입(초대 수락·가입 신청) 때 동의를 받는다. 서버는 이 버전 문자열에 동의한 요청만 받고, 동의 시각과 함께 남긴다.
 * 문구를 바꾸면 버전도 바꾼다 (누가 어느 판에 동의했는지 갈리게).
 */
export const TERMS_VERSION = "2026-10-11";
export const TERMS_TITLE = "0Siri 이용약관";
export const TERMS_SECTIONS: readonly { title: string; body: string }[] = [
  {
    title: "1. 서비스",
    body: "0Siri(영시리)는 대화로 일을 맡기는 AI 에이전트 서비스입니다. 초대받았거나 가입 신청이 승인된 회원만 씁니다.",
  },
  {
    title: "2. 사용자 내용의 기록·조회",
    body: "회원에게 최적화된 활동을 돕고 반복 입력을 줄여 주기 위해, 그리고 AI 학습을 위해 회원이 입력한 내용(대화·기억·첨부·사용 내역)이 기록되고 조회될 수 있습니다.",
  },
  {
    title: "3. 회원의 권리",
    body: "회원은 설정에서 자기 기억을 보고 지울 수 있고, 탈퇴를 요청할 수 있습니다. 탈퇴하면 정해진 기간 뒤 계정과 데이터가 지워집니다.",
  },
  {
    title: "4. 금지",
    body: "불법적인 목적이나 다른 사람의 권리를 해치는 용도로 쓸 수 없습니다. 어기면 이용이 제한될 수 있습니다.",
  },
];
/** 로그인 실패가 이만큼 쌓이면 비밀번호 재설정 경로를 안내한다 (기획 화면 1 «3회 실패 시 우회») */
export const LOGIN_FAILS_BEFORE_RESET_HINT = 3;
export const PASSWORD_RESET_HINT =
  "비밀번호를 잊었으면 아래 «비밀번호 찾기» 에서 문자 인증 후 새로 정하세요";

// ---- 방·결재함·목표 화면 라벨 (화면 3·4·5) — 화면이 따로 들고 있던 표를 여기로 올렸다 ----
/** 장기 목표 카드의 상태 흐름 (일시정지·막힘은 흐름 밖 — 칩으로 따로 붙는다) */
export const GOAL_STATUS_TRACK = [
  "proposed",
  "active",
  "completed",
] as const satisfies readonly GoalStatus[];
/** 주간 보고 카드·장기 목표 카드 한 줄에 싣는 지표 (전환은 지표 카드에서만 본다) */
export const REPORT_METRIC_KEYS = [
  "published",
  "indexed",
  "ai_citations",
] as const satisfies readonly GoalMetricKey[];
export const METRIC_PERIOD_LABELS: Record<MetricPeriod, string> = {
  week: "주",
  month: "월",
  quarter: "분기",
};
/** 팀 제안 카드의 버튼 이름 — 방 채팅 카드와 목표 화면이 같은 말을 쓴다 */
export const PROPOSAL_DECISION_LABELS: Record<ProposalDecision, string> = {
  accept: "목표에 반영",
  hold: "보류",
};

// ---- 가입: 전화번호 초대 · 가입 신청 · 가입 네트워크 (마스터 2026-10-10) ----
/** 가입 신청의 «사용 목적» 최소 글자 수(앞뒤 공백 제외) — 무엇을 어떻게 쓸지 구체적으로 받는다 */
export const WAITLIST_PURPOSE_MIN = 30;
export const WAITLIST_PURPOSE_MAX = 1000;
export const INVITE_STATUSES = ["pending", "joined", "expired"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];
export const INVITE_STATUS_LABELS: Record<InviteStatus, string> = {
  pending: "초대함",
  joined: "가입함",
  expired: "만료됨",
};
export const WAITLIST_STATUSES = ["pending", "approved", "rejected"] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];
export const WAITLIST_STATUS_LABELS: Record<WaitlistStatus, string> = {
  pending: "검토 중",
  approved: "승인됨",
  rejected: "반려됨",
};
export const NETWORK_NODE_STATUSES = ["joined", "invited"] as const;
export type NetworkNodeStatus = (typeof NETWORK_NODE_STATUSES)[number];
export const NETWORK_NODE_STATUS_LABELS: Record<NetworkNodeStatus, string> = {
  joined: "가입함",
  invited: "초대함",
};
// 서버가 내는 문구 — 화면도 같은 말을 쓴다
export const INVITE_ALREADY_MEMBER_MESSAGE = "이미 가입한 번호입니다";
export const INVITE_TAKEN_MESSAGE = "이미 다른 분이 초대한 번호입니다";
export const INVITE_PHONE_MISMATCH_MESSAGE = "초대받은 전화번호와 다릅니다";
export const WAITLIST_PURPOSE_MESSAGE = `무엇을 어떻게 쓰고 싶은지 ${WAITLIST_PURPOSE_MIN}자 이상으로 구체적으로 적어 주세요`;
export const WAITLIST_ALREADY_PENDING_MESSAGE = "이미 가입 신청을 검토 중인 번호입니다";
export const WAITLIST_PENDING_LOGIN_MESSAGE =
  "가입 신청을 검토 중입니다 — 승인되면 이 번호와 비밀번호로 로그인할 수 있어요";
export const waitlistRejectedMessage = (reason: string): string =>
  `가입 신청이 반려되었습니다 — ${reason}`;

/** 권한 부여 · 스토어 사용 허용 — 둘 다 관리자가 회원별로 직접 정한다 */
export const ROLE_SELF_MESSAGE = "자기 역할은 바꿀 수 없습니다. 다른 관리자에게 요청하세요";
export const STORE_GRANT_REQUIRED_MESSAGE =
  "관리자가 사용을 허용한 팀만 쓸 수 있습니다. 관리자에게 요청하세요";
export const STORE_GRANT_REQUIRED_LABEL = "관리자 허용 필요";

/**
 * 스킬 후보 찾기 (마스터 2026-10-10 «스킬화 할 수 있는 부분을 찾아서 스킬화 승인»):
 * 내 요청을 EmbeddingGemma 로 묶어 비슷한 요청이 이만큼 반복되면 스킬 초안을 낸다.
 */
export const SKILL_REPEAT_MIN = 3;
/** 같은 종류의 요청으로 볼 코사인 유사도 하한 (정규화 벡터 내적) */
export const SKILL_SIMILARITY_MIN = 0.82;
/** 한 번에 훑는 최근 요청 수 */
export const SKILL_SCAN_LIMIT = 200;
export const SKILL_REPEAT_PREFIX = "반복 요청: ";

/**
 * 영시리 홈 방 = 패키지 없고 주제방이 아닌 방 하나. 주제방(사용자가 «새 대화방»으로 연 방)도 패키지가 없으므로
 * «packageId === null» 만으로 홈을 고르면 주제방이 홈으로 잡힌다 — 이 판정 하나만 쓴다.
 */
export const isHomeRoom = (room: { packageId: string | null; topic?: boolean }) =>
  room.packageId === null && !room.topic;
/** 대화방 이름 길이 상한 */
export const ROOM_TITLE_MAX = 40;
/** 문자 인증 용도 — 같은 번호라도 용도가 다르면 서로의 인증번호로 통과하지 않는다(공용 OTP 서비스 purpose) */
/** 설정 «오류 보고·제안» — page-picker 로 함께 간다 */
export const REPORT_KINDS = ["bug", "idea"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_KIND_LABELS: Record<ReportKind, string> = { bug: "오류", idea: "제안" };
export const OTP_PURPOSES = ["signup", "reset"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
/** 피드: 관심 프롬프트 기본 주기(시간) · 사람당 개수 · 한 번에 싣는 새 글 수 */
export const FEED_EVERY_HOURS = 12;
export const FEED_PROMPT_MAX = 10;
export const FEED_RESULTS_PER_RUN = 5;

// 단체 톡 (마스터 2026-10-11) — 서버 osiri/groups.ts 와 화면 groups.tsx 가 같이 쓴다
export const GROUP_TITLE_MAX = 40;
export const GROUP_NICKNAME_MAX = 20;
export const GROUP_TEXT_MAX = 4000;
/** 단체 톡 봇 — 방장이 구독 팀의 도구 하나를 봇으로 (트리거: 특정 단어 · /명령어 · 크론) */
export const GROUP_BOT_TRIGGERS = ["keyword", "command", "cron"] as const;
export type GroupBotTrigger = (typeof GROUP_BOT_TRIGGERS)[number];
export const GROUP_BOT_TRIGGER_LABELS: Record<GroupBotTrigger, string> = {
  keyword: "특정 단어",
  command: "/명령어",
  cron: "크론",
};
/** 푸시 알림 채널 — 앱이 만들고 서버(FCM)가 이 채널로 보낸다 */
export const PUSH_CHANNEL = "messages";
/** 봇 답 한 번의 최대 글자 — 넘으면 자른다 */
export const GROUP_BOT_REPLY_MAX = 1500;

// 대화 안 차트 (마스터 2026-10-12 «ChatGPT 처럼 자체 렌더링») — 모델이 ```chart 블록에 JSON 을 쓰면 앱이 막대그래프로 그린다.
// 서버 persona.ts 가 CHART_PROMPT 로 형식을 알려 주고, 화면 assistant-response.tsx 가 parseChart 로 읽는다.
export const CHART_FENCE = "chart";
export const CHART_POINTS_MAX = 30;
export interface ChartSpec {
  title: string;
  subtitle?: string;
  unit?: string;
  source?: string;
  data: { label: string; value: number }[];
}
export const CHART_PROMPT = `수치를 비교할 때는 \`\`\`${CHART_FENCE} 코드 블록에 JSON {"title":"제목","subtitle":"기준·단위 설명","unit":"%","source":"출처 이름","data":[{"label":"항목","value":12.3}]} 을 쓰면 앱이 막대그래프로 그린다(항목 ${CHART_POINTS_MAX}개까지, 출처를 모르면 source 를 비운다). 여러 속성 비교는 마크다운 표로 쓴다.`;
/** 형식이 틀리면 사유 문자열 — 화면은 그 사유와 원문을 보인다(조용히 버리지 않는다) */
export function parseChart(raw: string): ChartSpec | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return `JSON 이 아닙니다: ${e instanceof Error ? e.message : String(e)}`;
  }
  const v = value as Partial<ChartSpec> | null;
  if (!v || typeof v.title !== "string" || !v.title.trim()) return "title 이 없습니다";
  if (!Array.isArray(v.data) || v.data.length === 0) return "data 가 없습니다";
  if (v.data.length > CHART_POINTS_MAX) return `항목이 ${CHART_POINTS_MAX}개를 넘습니다`;
  for (const p of v.data)
    if (
      !p ||
      typeof p.label !== "string" ||
      typeof p.value !== "number" ||
      !Number.isFinite(p.value)
    )
      return "data 항목은 {label: 글, value: 숫자} 여야 합니다";
  const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  return {
    title: v.title.trim(),
    subtitle: text(v.subtitle),
    unit: text(v.unit),
    source: text(v.source),
    data: v.data.map((p) => ({ label: p.label, value: p.value })),
  };
}

/** 대화 안 브라우저 프로필 이름 길이 — 서버 /api/browser-profiles 와 화면이 같이 쓴다 */
export const BROWSER_PROFILE_NAME_MAX = 30;
/** 영시리가 사람에게 브라우저를 넘기는 도구 이름 — 서버 도구와 화면의 브라우저 카드가 같이 본다 */
export const BROWSER_HANDOFF_TOOL = "browser_handoff";
export const BROWSER_TOOLS = ["browse_web", BROWSER_HANDOFF_TOOL] as const;
