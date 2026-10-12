// 0Siri 화면 11 · 설정 (모델 · 사용량 · 과금). 계약: docs/0siri-api-contract.md «설정 (화면 11)».
// 짧은 한 장 + 하위 화면(연결 7 · 기억 8 · 스킬 9 · 운영자 콘솔 10 …). 웹은 /settings/<sub> 로 주소에 남긴다.
import {
  Activity,
  ArrowLeft,
  Brain,
  Bug,
  LogOut,
  type LucideIcon,
  Network,
  Plug,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  UserCog,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  ANSWER_MODE_LABELS,
  ANSWER_MODES,
  type AnswerMode,
  BIG_LAYER,
  BIG_LAYER_SIZE,
  CHARACTER_INTENSITIES,
  CHARACTER_INTENSITY_LABELS,
  DEVICE_LAYER_STATE_LABELS,
  type DeviceLayerState,
  EMBED_DOWNLOAD_MB,
  EMBED_DTYPE,
  EMBED_TOKENIZER_MB,
  FIXED_TIERS,
  MODEL_KEY_PROVIDER_LABELS,
  MODEL_KEY_PROVIDERS,
  type ModelTier,
  NOT_READY_LABEL,
  RETENTION_DAYS,
  ROLE_SELF_MESSAGE,
  TEAM_ICON_MODE_LABELS,
  TEAM_ICON_MODES,
  TIER_LABELS,
  USER_ROLE_LABELS,
  USER_ROLES,
  type UserRole,
  WAITLIST_STATUS_LABELS,
  type WaitlistStatus,
} from "../../../../packages/domain/src/osiri";
import type { MeResponse } from "../../../server/src/osiri/account-routes.ts";
import type { Accounts, WaitlistView } from "../../../server/src/osiri/accounts.ts";
import type {
  ModelKeyRow,
  ModelsView,
  Routing,
  SettingsView,
} from "../../../server/src/osiri/routing.ts";
import type { publicPackage } from "../../../server/src/osiri/store.ts";
import appJson from "../../app.json";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  dateLabel,
  ErrorNotice,
  Field,
  LinkRow,
  SectionHeading,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { takeAuthIssues } from "./auth";
import { Confirm, ConnectionsScreen, column, columns, Loaded, mono } from "./connections";
import {
  bigModel,
  clearBigCrash,
  deviceChatAvailable,
  downloadBigModel,
  networkKind,
  removeBigModel,
} from "./device-chat";
import { downloadGate } from "./device-chat-logic";
import {
  DOWNLOADS_ON_FIRST_USE,
  deviceAvailable,
  deviceModel,
  measureDevice,
  prepareDevice,
  removeModel,
} from "./device-embed";
import { DeviceMemoryError } from "./device-embed.types";
import { openReport } from "./diag";
import { setCharacterPref } from "./eve";
import { type LocationState, locationState, setLocationEnabled } from "./location";
import { MemoryScreen } from "./memory";
import { NetworkScreen } from "./network";
import { OperatorScreen } from "./operator";
import { SkillsScreen } from "./skills";
import { Block, Choice, ToolListEditor, useAction, useLoad, won } from "./store";
import { deviceSearchOff, setDeviceSearchOff } from "./tier0";

/** `GET /billing/usage` — 서버 `Routing.billing()`. percent 는 상한 대비 0~100, null = 측정 중 */
type BillingUsage = Awaited<ReturnType<Routing["billing"]>>;
type MonthUsage = Awaited<ReturnType<Routing["month"]>>;
/** `GET /admin/users[?q=]` 항목 — 서버 `Accounts.listUsers()` (이름은 프로필의 표시 이름, 없으면 null) */
type AdminUser = Awaited<ReturnType<Accounts["listUsers"]>>[number];
type StorePkg = ReturnType<typeof publicPackage>;

// ---- 하위 화면 ----
const SUBS = [
  "connections",
  "memory",
  "skills",
  "network",
  "operator",
  "admin",
  "profile",
  "usage",
] as const;
type Sub = (typeof SUBS)[number];
const isSub = (value: string | undefined): value is Sub => SUBS.some((sub) => sub === value);
const SUB_TITLES: Record<Sub, string> = {
  connections: "연결",
  memory: "기억",
  skills: "스킬",
  network: "초대 · 네트워크",
  operator: "운영자 콘솔",
  admin: "관리자",
  profile: "프로필",
  usage: "사용량 상세",
};
/** 역할이 있어야 열리는 하위 화면 — 메뉴와 주소 진입이 같은 표를 본다 */
const SUB_ROLES: Partial<Record<Sub, UserRole[]>> = {
  operator: ["operator", "admin"],
  admin: ["admin"],
};
function readSub(): Sub | undefined {
  if (Platform.OS !== "web" || typeof location === "undefined") return undefined;
  const [, first, second] = location.pathname.split("/");
  return first === "settings" && isSub(second) ? second : undefined;
}
function writeSub(sub: Sub | undefined) {
  if (Platform.OS !== "web" || typeof history === "undefined") return;
  const path = sub ? `/settings/${sub}` : "/settings";
  if (location.pathname !== path) history.replaceState(null, "", path);
}

// ---- 기기 모델 2층 ----
type LayerState = DeviceLayerState;
const layerTint: Partial<Record<LayerState, string>> = {
  ready: colors.okBg,
  downloading: colors.accentSoft,
  unsupported: colors.warnBg,
  oom: colors.missBg,
};
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
// ponytail: 메모리 부족은 런타임이 던진 오류 문장으로만 가린다 — 런타임이 종류를 알려 주면 그걸로 바꾼다
const isOutOfMemory = (e: unknown) =>
  e instanceof DeviceMemoryError ||
  e instanceof RangeError ||
  /out of memory|allocation failed|bad_alloc/i.test(reasonOf(e));
const megabytes = (bytes: number) => Math.round(bytes / 1048576);

const text = {
  back: "설정",
  save: "저장",
  saved: "저장했습니다",
  add: "추가",
  cancel: "취소",
  tierTitle: "등급 · 구독",
  subscribed: (name: string) => `${name} 구독 중`,
  noSubscription: "구독 중인 팀이 없습니다",
  goStore: "스토어 보기",
  modelTitle: "답변 방식 · 모델",
  answerMode: "답변 방식",
  answerModeHints: {
    auto: "자동: 티어 0 임베딩 신호 → 티어 1 기기 답변 → 서버 경량·주력·최고로 상향",
    device: `항상 기기: 영시리 대화를 이 기기의 ${BIG_LAYER.name} 가 답합니다. 기기가 실패하면 그 사유를 보이고 서버가 답합니다`,
    server: "항상 서버: 기기 답변을 쓰지 않습니다",
  } satisfies Record<AnswerMode, string>,
  deviceModeNotReady: `${ANSWER_MODE_LABELS.device}는 아래 «기기 모델» 에서 큰 층(${BIG_LAYER.name})을 켜서 받은 뒤에 고를 수 있습니다`,
  deviceModeMissing: `${ANSWER_MODE_LABELS.device}로 두었지만 이 기기에 큰 층(${BIG_LAYER.name})이 없습니다 — 대화는 서버가 답하고, 답마다 그 사유를 보입니다`,
  deviceModeScope:
    "기기 답변은 영시리 기본 대화에만 씁니다. 날씨·기억 같은 도구는 기기에서 쓸 수 없고, 팀 방은 서버가 답합니다.",
  autoEconomy: "가성비 자동 라우팅",
  fixedModel: "모델 직접 고르기",
  fixedNone: "고르지 않음",
  deviceTitle: "기기 모델",
  smallLayer: "작은 층 · 임베딩젬마 2",
  smallLayerHint: `기본 다운로드 ${EMBED_DOWNLOAD_MB}MB(${EMBED_DTYPE} 가중치) + 토크나이저 ${EMBED_TOKENIZER_MB}MB · 기억 검색·분류 신호`,
  status: "상태",
  download: "받기",
  remove: "삭제",
  removeSmall:
    "작은 층을 지우면 이 기기의 기기 검색이 꺼지고, 기억 검색은 서버 임베딩으로 대체됩니다. [다시 켜기]를 누르기 전에는 모델을 다시 받지 않습니다. 이미 올라온 모델은 이 화면을 새로 고칠 때까지 메모리에 남습니다.",
  turnBackOn: "다시 켜기",
  cacheUnreadable: "이 환경은 모델 저장소를 조회할 수 없어 내려받았는지 확인하지 못합니다",
  downloadProgress: (received: number, total: number) =>
    `${megabytes(received)} / ${megabytes(total)}MB (${Math.floor((received / total) * 100)}%)`,
  prepared: (loadMs: number, embedMs: number) =>
    `모델 올리기 ${loadMs}ms · 문장 1개 ${embedMs}ms (이 기기 실측)`,
  smallStates: {
    unknown: "아직 확인하지 않았습니다",
    none: "내려받지 않았습니다 — 기억 검색은 서버 임베딩으로 합니다",
    downloading: "내려받는 중입니다",
    ready: "이 기기에 있습니다 — 기억 검색을 기기에서 합니다",
    unsupported: "이 기기에서는 쓸 수 없습니다 — 기억 검색은 서버 임베딩으로 합니다",
    oom: "메모리가 모자라 올리지 못했습니다 — 기억 검색은 서버 임베딩으로 합니다",
    off: "기기 검색을 꺼 두었습니다 — 기억 검색은 서버 임베딩으로 하고, 모델을 다시 받지 않습니다",
  } satisfies Record<LayerState, string>,
  bigLayer: `큰 층 · ${BIG_LAYER.name}`,
  bigLayerHint: `${BIG_LAYER_SIZE} (${BIG_LAYER.file}) · 사용자가 켜면 Wi-Fi로 다운로드 · 기기 대화 답변`,
  bigRule: "[켜기]를 눌러야만 내려받고, Wi-Fi 가 아니면 시작 전에 확인을 요구합니다.",
  turnOn: "켜기",
  retryLoad: "다시 올려 보기",
  meteredConfirm: (kind: "metered" | "unknown") =>
    `${kind === "metered" ? "지금 Wi-Fi 가 아니라 모바일 데이터입니다" : "지금 연결이 Wi-Fi 인지 확인하지 못했습니다"} — ${BIG_LAYER_SIZE} 를 받으면 데이터 요금이 나올 수 있습니다. 그래도 받을까요?`,
  downloadAnyway: "그래도 받기",
  offline: "인터넷에 연결되어 있지 않아 받을 수 없습니다",
  removeBig: `큰 층(${BIG_LAYER.name})을 지우면 ${BIG_LAYER_SIZE} 를 다시 받기 전까지 대화는 서버가 답합니다. 지울까요?`,
  bigStates: {
    unknown: "아직 확인하지 않았습니다",
    none: "내려받지 않았습니다 — 대화는 서버가 답합니다",
    downloading:
      "내려받는 중입니다 — 화면을 떠나도 받기는 이어지지만, 앱을 닫으면 멈춥니다(다음 [켜기] 가 이어 받습니다)",
    ready: `이 기기에 있습니다 — 위 «답변 방식» 에서 [${ANSWER_MODE_LABELS.device}] 를 고르면 대화를 기기에서 답합니다`,
    unsupported: "이 기기·빌드에서는 쓸 수 없습니다 — 대화는 서버가 답합니다",
    oom: "메모리가 모자라 올리지 못했습니다 — 대화는 서버가 답합니다",
    off: "꺼 두었습니다",
  } satisfies Record<LayerState, string>,
  usageTitle: "이번 달 사용량 (공용 열쇠 기준)",
  percentOfCap: (n: number) => `상한의 ${Math.round(n)}%`,
  spent: (cost: string, cap: string) => `${cost} / ${cap}`,
  noCap: "월 상한이 없습니다 — 상한을 정하면 사용량 비율이 보입니다",
  measuring: "측정 중",
  byokUsage: "본인 계정 청구 · 상한 제외",
  warnNear: "월 상한에 가까워졌습니다",
  unpriced: (n: number) => `단가 미설정 ${n}건 — 상한 계산 제외`,
  capReached: "월 상한에 도달해 공용 경로가 멈췄습니다 — 내 API 키를 등록하거나 상한을 올려 주세요",
  cap: "월 예산 상한 (원, 비우면 없음)",
  capInvalid: "월 상한은 0 이상의 숫자여야 합니다",
  saving: "라우팅으로 아낀 금액",
  byokRule: "자기 키 사용분은 상한에서 제외 · 본인 계정으로 직접 청구",
  krw: (n: number) => `${n.toLocaleString("ko-KR")}원`,
  keysTitle: "내 API 키",
  keyActive: (label: string, last4: string | null) =>
    last4 === null ? `${label} 활성` : `${label} 활성 (•••• ${last4})`,
  noKeys: "등록된 키 없음 — 공용 열쇠로 동작 중",
  manageKeys: "관리: 연결 화면",
  notifyTitle: "알림",
  notifyApprovals: "승인 대기",
  notifyWeekly: "주간 보고",
  notifyNotReady: "알림 발송이 아직 없습니다 — 준비되면 여기서 켜고 끌 수 있습니다",
  onOff: (on: boolean) => (on ? "켜짐" : "꺼짐"),
  characterTitle: "캐릭터",
  locationTitle: "위치",
  locationOn: "내 위치를 영시리에게 알려 주기 (날씨·주변·길 안내)",
  locationHint:
    "대화 화면을 열 때 휴대폰 위치(GPS)를 10분에 한 번 서버에 둡니다. 6시간이 지난 위치는 쓰지 않고, 끄면 저장된 위치를 지웁니다.",
  locationStates: {
    ok: "위치를 받고 있습니다",
    denied: "위치 권한이 거절되어 있습니다 — 휴대폰 설정의 0Siri 앱 권한에서 위치를 허용하세요",
    off: "꺼져 있습니다",
    error: "위치를 읽지 못했습니다 — 위치 서비스(GPS)가 켜져 있는지 확인하세요",
  } satisfies Record<LocationState, string>,
  characterOn: "캐릭터 표시",
  intensity: "반응 강도",
  teamIcons: "기본 채팅의 팀 아이콘",
  menuTitle: "더 보기",
  menu: {
    connections: "MCP 도구 · 모델 계정(내 API 키)",
    memory: "에이전트가 나에 대해 아는 사실 · 개인 스킬",
    skills: "스킬 초안 승인 · 버전",
    network: "전화번호로 초대 · 내가 들인 사람들",
    operator: "패키지 버전 · 지표 · 공지",
    admin: "가입 신청 검토 · 사용자 · 패키지 가격",
    profile: "표시 이름 · 소개",
    usage: "호출 · 토큰 · 등급별",
  } satisfies Record<Sub, string>,
  deleteData: "데이터 삭제",
  deleteHint: "탈퇴 — 로그인이 바로 막히고, 기록은 법령에 따라 분리 보관합니다",
  deleteConfirm: `탈퇴를 요청하면 로그인이 바로 막히고 되돌릴 수 없습니다. ${RETENTION_DAYS}일 뒤 계정이 보관 상태로 바뀌고, 개인정보·이용 기록은 관계 법령과 분쟁 대응을 위해 분리 보관됩니다(openagentx.org/privacy).`,
  deleteAction: "삭제 요청",
  deleteAccepted: (date: string) =>
    `탈퇴 요청을 접수했습니다. ${date}부터 계정이 보관 상태로 바뀝니다.`,
  logout: "로그아웃",
  forbidden: "이 화면을 볼 권한이 없습니다",
  // 프로필 · 사용량 상세 · 관리자 (기존 기능을 하위 화면으로 옮겼다)
  phone: "전화번호",
  displayName: "표시 이름",
  credential: "소개 한 줄",
  credentialHint: "예: ○○법률사무소 변호사",
  month: (m: string) => `${m} 기준`,
  calls: "호출",
  tokens: "토큰 (입력/출력)",
  cost: "지출",
  scriptSaved: "스크립트 대체",
  byokCalls: "내 계정(BYOK) 호출",
  times: (n: number) => `${n}회`,
  byTier: "등급별",
  // 관리자: 가입 신청(초대 대기) 검토 — 초대는 관리자도 «초대 · 네트워크» 에서 전화번호로 한다
  waitlist: "가입 신청 검토",
  noWaitlist:
    "가입 신청이 없습니다 — 로그인 화면의 «초대 대기 신청» 으로 들어온 신청이 여기에 보입니다",
  noPendingWaitlist: "검토를 기다리는 신청이 없습니다",
  decided: "처리한 신청",
  requested: (date: string) => `${date} 신청`,
  purpose: "사용 목적",
  noPurpose: "사용 목적이 없는 옛 신청입니다",
  parent: "연결할 상위 회원",
  parentHint: "이 신청자를 누구 아래에 붙일지 고릅니다. 승인하면 그 회원의 네트워크에 들어갑니다.",
  parentSearch: "이름 또는 전화번호로 찾기",
  search: "찾기",
  searchRequired: "찾을 이름이나 전화번호를 입력해 주세요",
  noHits: "찾은 회원이 없습니다 — 다른 이름이나 번호로 찾아 보세요",
  change: "바꾸기",
  approve: "승인",
  approveBlocked: "상위 회원을 골라야 승인할 수 있습니다",
  approved: (phone: string) => `${phone} 가입 신청을 승인했습니다`,
  reject: "반려",
  rejectReason: "반려 사유 (신청자가 로그인할 때 보게 됩니다)",
  rejectBlocked: "반려 사유를 적어야 반려할 수 있습니다",
  rejectConfirm: "반려 확정",
  rejected: (phone: string) => `${phone} 가입 신청을 반려했습니다`,
  rejectedWhy: (reason: string) => `반려 사유: ${reason}`,
  users: "사용자 목록",
  noUsers: "사용자가 없습니다 — 초대를 수락하거나 가입 신청이 승인된 사용자가 여기에 보입니다",
  prices: "패키지 가격",
  slug: "패키지 슬러그",
  price: "월 가격 (원, 0 = 무료)",
  priceInvalid: "가격은 0 이상의 숫자여야 합니다",
  noPrices: "설정된 가격이 없습니다 (전부 파일럿 무료)",
  role: "역할 (권한)",
  roleChanged: (who: string, role: string) => `${who} — ${role} 권한으로 바꿨습니다`,
  grants: (n: number) => `스토어 사용 허용 (${n})`,
  grantsHide: "접기",
  grantsHint:
    "누른 팀만 이 회원이 구독해 쓸 수 있습니다. 허용을 거두면 쓰고 있던 구독은 해지 예약됩니다.",
  noPackages: "등록된 팀이 없습니다 — 아래 «스토어 등록» 에서 올리세요",
  register: "스토어 등록",
  registerHint:
    "팀 YAML 이 이름·캐릭터·분야·역할·승인 지점의 정본입니다. 같은 slug 로 다시 올리면 고쳐집니다.",
  yaml: "팀 YAML",
  summary: "스토어 소개 (목록·상세에 보이는 설명)",
  image: "실행 이미지",
  listing: "올린 뒤 상태",
  listReviewing: "입점 심사 중 (구독 불가)",
  listOpen: "바로 공개",
  registerSubmit: "등록",
  registered: (name: string) => `${name} 을(를) 스토어에 등록했습니다`,
  oversight: "감독 (정지·사용 내역)",
  oversightHide: "감독 접기",
  oversightAudited: "이 회원의 기록을 열면 관리자 감사 기록에 남습니다.",
  suspendReason: "정지 사유 (회원에게 보입니다)",
  suspend: "이용 정지",
  unsuspend: "정지 해제",
  suspended: (name: string) => `${name} 의 이용을 정지했습니다`,
  unsuspended: (name: string) => `${name} 의 정지를 풀었습니다`,
  suspendedNow: (reason: string) => `이용 정지 중 — ${reason}`,
  usageLine: (month: string, calls: number, tokens: number, cost: number) =>
    `${month} 사용: 호출 ${calls}회 · 토큰 ${tokens.toLocaleString()} · ${cost.toLocaleString()}원`,
  roomsLine: (titles: string[]) =>
    `대화방 ${titles.length}개${titles.length ? `: ${titles.join(", ")}` : ""}`,
  noAudit: "감사 기록이 없습니다",
  restrict: "팀 제한 (판매·실행 중지)",
  restrictHint:
    "판매 중지는 새 구독만 막습니다. 실행 중지는 그 팀이 지금 도는 것까지 멈추고, YAML 을 다시 올려도 풀리지 않습니다. 모두 감사 기록에 남습니다.",
  restrictReason: "사유 (실행 중지에는 필수)",
  stopSale: "판매 중지",
  resumeSale: "판매 재개",
  halt: "실행 중지",
  resume: "실행 재개",
  haltedNow: (reason: string) => `실행 중지 중 — ${reason}`,
  saleStopped: "판매 중지(심사 중)",
  restricted: (name: string) => `${name} 의 제한을 바꿨습니다`,
  blocked: "차단 도구",
  blockedHint: "여기 적은 도구는 어떤 팀도 부를 수 없습니다. 형식: 서버:도구",
};

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const { api } = useWorkspace();
  const me = useLoad(() => api.request<MeResponse>("/api/me"));
  const [sub, setSub] = useState(readSub);
  useEffect(() => writeSub(sub), [sub]);
  // 앱을 켤 때 쌓인 저장소 경고(auth.tsx) — 로그인 화면을 거치지 않고 들어왔으면 여기서 보인다
  const [authIssues] = useState(takeAuthIssues);
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 20 }}
      keyboardShouldPersistTaps="handled"
    >
      {sub && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setSub(undefined)}
          style={[s.row, { gap: 8 }]}
        >
          <ArrowLeft size={16} color={colors.muted} />
          <Text style={s.small}>{text.back}</Text>
          <Text style={[s.text, { fontWeight: "600" }]}>{SUB_TITLES[sub]}</Text>
        </Pressable>
      )}
      <ErrorNotice error={authIssues} />
      <Loaded state={me} rows={4} height={88}>
        {(account) =>
          sub ? (
            <SubScreen sub={sub} me={account} onProfile={me.setData} />
          ) : (
            <Main me={account} open={setSub} onLogout={onLogout} />
          )
        }
      </Loaded>
      {/* 버전 표시는 여기 한 곳만 (app.json 이 정본, 마스터 2026-10-10 «버전 표시는 설정에다가 해») */}
      {!sub && (
        <Text style={[s.small, mono, { textAlign: "center" }]}>0Siri v{appJson.expo.version}</Text>
      )}
    </ScrollView>
  );
}

const allowed = (sub: Sub, role: UserRole) => SUB_ROLES[sub]?.includes(role) ?? true; // 표에 없으면 누구나

function SubScreen({
  sub,
  me,
  onProfile,
}: {
  sub: Sub;
  me: MeResponse;
  onProfile: (me: MeResponse) => void;
}) {
  if (!allowed(sub, me.user.role)) return <ErrorNotice error={text.forbidden} />;
  switch (sub) {
    case "connections":
      return <ConnectionsScreen admin={me.user.role === "admin"} />;
    case "memory":
      return <MemoryScreen />;
    case "skills":
      return <SkillsScreen />;
    case "network":
      return <NetworkScreen />;
    case "operator":
      return <OperatorScreen />;
    case "admin":
      return <Admin meId={me.user.id} />;
    case "profile":
      return <Profile me={me} onSaved={onProfile} />;
    case "usage":
      return <UsageDetail />;
  }
}

function Main({
  me,
  open,
  onLogout,
}: {
  me: MeResponse;
  open: (sub: Sub) => void;
  onLogout: () => void;
}) {
  const { api } = useWorkspace();
  const settings = useLoad(() => api.request<SettingsView>("/api/settings"));
  const usage = useLoad(() => api.request<BillingUsage>("/api/billing/usage"));
  // 큰 층 상태 — «기기 모델» 카드가 확인·받기·지우기로 바꾸고, «답변 방식» 이 [기기] 를 열지 정한다
  const [big, setBig] = useState<LayerState>("unknown");
  return (
    <View style={columns}>
      <View style={column}>
        <Loaded state={settings} rows={3} height={110}>
          {(data) => (
            <>
              <TierCard tier={data.tier} />
              <ModelCard
                settings={data}
                onSaved={(next) => {
                  settings.setData(next);
                  usage.retry(); // 상한이 바뀌면 비율도 바뀐다 — 서버가 다시 계산한 값을 읽는다
                }}
                usage={usage}
                openConnections={() => open("connections")}
                bigReady={big === "ready"}
              />
            </>
          )}
        </Loaded>
        <DeviceCard big={big} setBig={setBig} />
      </View>
      <View style={column}>
        <KeysCard openConnections={() => open("connections")} />
        <Loaded state={settings} rows={1} height={110}>
          {(data) => <PreferencesCard settings={data} onSaved={settings.setData} />}
        </Loaded>
        <Menu role={me.user.role} open={open} onLogout={onLogout} />
      </View>
    </View>
  );
}

function TierCard({ tier }: { tier: SettingsView["tier"] }) {
  const { navigate } = useWorkspace();
  return (
    <View>
      <SectionHeading title={text.tierTitle} />
      <Card style={{ gap: 10 }}>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Chip tint={colors.accentSoft}>{tier.label}</Chip>
          <Text style={[s.text, { fontWeight: "600" }]}>
            {tier.subscription === null ? text.noSubscription : text.subscribed(tier.subscription)}
          </Text>
        </View>
        {tier.subscription === null && (
          <Button small onPress={() => navigate("store")}>
            {text.goStore}
          </Button>
        )}
      </Card>
    </View>
  );
}

type UsageState = ReturnType<typeof useLoad<BillingUsage>>;

function ModelCard({
  settings,
  onSaved,
  usage,
  openConnections,
  bigReady,
}: {
  settings: SettingsView;
  onSaved: (next: SettingsView) => void;
  usage: UsageState;
  openConnections: () => void;
  /** 큰 층(기기 대화 모델)이 이 기기에 받아져 있는가 — 아니면 [기기] 를 고를 수 없다 */
  bigReady: boolean;
}) {
  const { api, notify } = useWorkspace();
  const act = useAction();
  const [cap, setCap] = useState<string>();
  // 서버가 받아들인 뒤에 서버 값을 다시 읽어 보인다 (낙관적 표시 없음)
  const patch = (body: Partial<Pick<SettingsView, "answerMode" | "autoEconomy" | "fixedModel">>) =>
    act.run(async () => {
      await api.request("/api/settings/model", body, "PATCH");
      onSaved(await api.request<SettingsView>("/api/settings"));
    });
  const saveCap = () =>
    act.run(async () => {
      const raw = (cap ?? "").trim();
      const value = raw === "" ? null : Number(raw);
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new Error(text.capInvalid);
      await api.request("/api/settings/model", { monthlyCapKrw: value }, "PATCH");
      onSaved(await api.request<SettingsView>("/api/settings"));
      setCap(undefined);
      notify(text.saved);
    });
  return (
    <>
      <View>
        <SectionHeading title={text.modelTitle} />
        <Card style={{ gap: 12 }}>
          <Block title={text.answerMode}>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              {ANSWER_MODES.map((mode) => (
                <Choice
                  key={mode}
                  label={ANSWER_MODE_LABELS[mode]}
                  selected={settings.answerMode === mode}
                  // 큰 층을 받기 전에는 고를 수 없게 두고 아래에 사유를 적는다 (이미 기기면 다른 쪽으로 바꿀 수 있게 둔다)
                  disabled={mode === "device" && !bigReady && settings.answerMode !== "device"}
                  onPress={() => patch({ answerMode: mode })}
                />
              ))}
            </View>
            <Text style={s.small}>{text.answerModeHints[settings.answerMode]}</Text>
            {settings.answerMode === "device" && (
              <Text style={s.small}>{text.deviceModeScope}</Text>
            )}
            {!bigReady &&
              (settings.answerMode === "device" ? (
                <Text style={[s.small, { color: colors.warn }]}>{text.deviceModeMissing}</Text>
              ) : (
                <Text style={s.small}>{text.deviceModeNotReady}</Text>
              ))}
          </Block>
          <CheckRow
            label={text.autoEconomy}
            checked={settings.autoEconomy}
            onPress={() => patch({ autoEconomy: !settings.autoEconomy })}
          />
          {!settings.autoEconomy && (
            <Block title={text.fixedModel}>
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Choice
                  label={text.fixedNone}
                  selected={settings.fixedModel === null}
                  onPress={() => patch({ fixedModel: null })}
                />
                {FIXED_TIERS.map((tier) => (
                  <Choice
                    key={tier}
                    label={TIER_LABELS[tier]}
                    selected={settings.fixedModel === `${tier}`}
                    onPress={() => patch({ fixedModel: `${tier}` as const })}
                  />
                ))}
              </View>
            </Block>
          )}
          <ErrorNotice error={act.error} />
        </Card>
      </View>
      <View>
        <SectionHeading title={text.usageTitle} />
        <Card style={{ gap: 12 }}>
          <Loaded state={usage} rows={2} height={36}>
            {(u) => <UsageSummary usage={u} openConnections={openConnections} />}
          </Loaded>
          <Field
            label={text.cap}
            keyboardType="numeric"
            value={cap ?? (settings.monthlyCapKrw === null ? "" : String(settings.monthlyCapKrw))}
            onChangeText={setCap}
          />
          <Button small busy={act.busy} disabled={cap === undefined} onPress={saveCap}>
            {text.save}
          </Button>
          <Text style={s.small}>{text.byokRule}</Text>
        </Card>
      </View>
    </>
  );
}

function UsageSummary({
  usage,
  openConnections,
}: {
  usage: BillingUsage;
  openConnections: () => void;
}) {
  const { percent } = usage;
  // 경고 단계는 서버가 정한다(문턱은 도메인 CAP_WARN_*) — 화면은 단계를 색으로 옮길 뿐이다
  const level = usage.warn === "reached" ? "miss" : usage.warn === "near" ? "warn" : undefined;
  return (
    <>
      {usage.byok ? (
        // 자기 키 활성: 사용량 바 대신 이 한 줄
        <Chip tint={colors.okBg}>{text.byokUsage}</Chip>
      ) : (
        <>
          {level && (
            <View
              accessibilityRole="alert"
              style={{
                gap: 8,
                padding: 12,
                borderRadius: 10,
                backgroundColor: level === "miss" ? colors.missBg : colors.warnBg,
              }}
            >
              <Text style={[s.text, { color: level === "miss" ? colors.miss : colors.warn }]}>
                {level === "miss" ? text.capReached : text.warnNear}
              </Text>
              {level === "miss" && (
                <Button small onPress={openConnections}>
                  {text.manageKeys}
                </Button>
              )}
            </View>
          )}
          {usage.capKrw === null ? (
            <Text style={s.small}>{text.noCap}</Text>
          ) : percent === null ? (
            <Chip>{text.measuring}</Chip>
          ) : (
            <>
              <View style={s.between}>
                <Text style={[s.text, mono, { fontWeight: "600" }]}>
                  {text.percentOfCap(percent)}
                </Text>
                <Text style={[s.small, mono]}>
                  {text.spent(text.krw(usage.costKrw), text.krw(usage.capKrw))}
                </Text>
              </View>
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: colors.sunk,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${Math.min(Math.max(percent, 0), 100)}%`,
                    height: 8,
                    backgroundColor:
                      level === "miss"
                        ? colors.miss
                        : level === "warn"
                          ? colors.warn
                          : colors.accent,
                  }}
                />
              </View>
            </>
          )}
        </>
      )}
      {usage.unpricedCalls > 0 && (
        <Text style={[s.small, mono, { color: colors.warn }]}>
          {text.unpriced(usage.unpricedCalls)}
        </Text>
      )}
      <View style={s.between}>
        <Text style={s.small}>{text.saving}</Text>
        {usage.savedKrw === null ? (
          <Chip>{text.measuring}</Chip>
        ) : (
          <Text style={[s.text, mono]}>{text.krw(usage.savedKrw)}</Text>
        )}
      </View>
    </>
  );
}

function KeysCard({ openConnections }: { openConnections: () => void }) {
  const { api } = useWorkspace();
  const keys = useLoad(() => api.request<ModelKeyRow[]>("/api/model-keys"));
  return (
    <View>
      <SectionHeading title={text.keysTitle} />
      <Card style={{ gap: 8 }}>
        <Loaded state={keys} rows={1}>
          {(items) => {
            const active = MODEL_KEY_PROVIDERS.flatMap((provider) =>
              items.filter((item) => item.provider === provider && item.status === "active"),
            );
            return active.length === 0 ? (
              <Text style={s.small}>{text.noKeys}</Text>
            ) : (
              active.map((item) => (
                <Text key={item.provider} style={[s.text, mono]}>
                  {text.keyActive(MODEL_KEY_PROVIDER_LABELS[item.provider], item.last4)}
                </Text>
              ))
            );
          }}
        </Loaded>
        <Button small onPress={openConnections}>
          {text.manageKeys}
        </Button>
      </Card>
    </View>
  );
}

function DeviceCard({ big, setBig }: { big: LayerState; setBig: (state: LayerState) => void }) {
  const [state, setState] = useState<LayerState>("unknown");
  const [detail, setDetail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const act = useAction();
  const check = async () => {
    setDetail("");
    if (!deviceAvailable()) {
      const report = await measureDevice(); // 쓸 수 없는 이유를 기기 쪽에서 받아 그대로 보인다
      setState("unsupported");
      setDetail(report.reason ?? "");
      return;
    }
    // 사용자가 지워서 꺼 둔 상태 — tier0.ts 가 같은 값을 보고 곧장 서버 검색으로 간다
    if (deviceSearchOff()) {
      setState("off");
      return;
    }
    const model = await deviceModel();
    setState(model.state);
    if (model.state === "unknown") setDetail(text.cacheUnreadable);
    else if (model.prepared)
      setDetail(text.prepared(model.prepared.loadMs, model.prepared.embedMs));
    else setDetail(model.reason ?? "");
  };
  const inspect = () => act.run(check);
  const turnBackOn = () =>
    act.run(async () => {
      setDeviceSearchOff(false);
      await check();
    });
  useEffect(() => {
    void inspect();
  }, []);
  const download = () =>
    act.run(async () => {
      setDetail("");
      setState("downloading");
      try {
        // 모델을 내려받아(네이티브는 진행률·이어 받기) 올리고, 문장 하나를 돌려 본다
        const prepared = await prepareDevice(({ receivedBytes, totalBytes }) =>
          setDetail(text.downloadProgress(receivedBytes, totalBytes)),
        );
        setState("ready");
        setDetail(prepared ? text.prepared(prepared.loadMs, prepared.embedMs) : "");
      } catch (e) {
        setState(isOutOfMemory(e) ? "oom" : "none");
        throw e; // 사유는 아래 ErrorNotice 에 보인다
      }
    });
  const remove = () =>
    act.run(async () => {
      // 먼저 «기기 검색 끔» 을 저장한다 — 저장에 실패하면 지우지 않고 사유를 보인다(지웠는데 다음 검색이 다시 받는 일이 없게)
      // (네이티브는 [받기] 를 눌러야만 받으므로 꺼 둘 것이 없다 — 지우면 그대로 «미다운로드» 다)
      if (DOWNLOADS_ON_FIRST_USE) setDeviceSearchOff(true);
      await removeModel();
      setConfirming(false);
      setDetail("");
      setState(DOWNLOADS_ON_FIRST_USE ? "off" : "none");
    });
  const canRemove = state === "ready";
  return (
    <View>
      <SectionHeading title={text.deviceTitle} />
      <Card style={{ gap: 14 }}>
        <View style={{ gap: 6 }}>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            <Text style={[s.text, { fontWeight: "600" }]}>{text.smallLayer}</Text>
            <Chip tint={layerTint[state]}>{DEVICE_LAYER_STATE_LABELS[state]}</Chip>
          </View>
          <Text style={[s.small, mono]}>{text.smallLayerHint}</Text>
          <Text style={s.small}>{text.smallStates[state]}</Text>
          {!!detail && <Text style={s.small}>{detail}</Text>}
          <ErrorNotice error={act.error} />
          {confirming ? (
            <Confirm
              message={text.removeSmall}
              action={text.remove}
              busy={act.busy}
              onCancel={() => setConfirming(false)}
              onConfirm={remove}
            />
          ) : (
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button small busy={act.busy && state !== "downloading"} onPress={inspect}>
                {text.status}
              </Button>
              {state === "off" && (
                <Button small primary busy={act.busy} onPress={turnBackOn}>
                  {text.turnBackOn}
                </Button>
              )}
              {(state === "none" || state === "oom" || state === "downloading") && (
                <Button small primary busy={state === "downloading"} onPress={download}>
                  {text.download}
                </Button>
              )}
              <Button small danger disabled={!canRemove} onPress={() => setConfirming(true)}>
                {text.remove}
              </Button>
            </View>
          )}
        </View>
        <BigLayer state={big} setState={setBig} />
      </Card>
    </View>
  );
}

/** 큰 층(기기 대화 모델): [켜기] → (Wi-Fi 가 아니면 확인) → 내려받기·진행률 → 준비됨 · [삭제] */
function BigLayer({
  state,
  setState,
}: {
  state: LayerState;
  setState: (state: LayerState) => void;
}) {
  const [detail, setDetail] = useState("");
  // 받기 전 확인 (모바일 데이터·연결 종류 모름) / 지우기 전 확인
  const [asking, setAsking] = useState<"metered" | "unknown" | "remove">();
  const act = useAction();
  const check = async () => {
    setDetail("");
    if (!deviceChatAvailable()) {
      const model = await bigModel(); // 쓸 수 없는 이유를 기기 쪽에서 받아 그대로 보인다
      setState("unsupported");
      setDetail(model.reason ?? "");
      return;
    }
    const model = await bigModel();
    setState(model.state);
    setDetail(model.reason ?? "");
  };
  const inspect = () => act.run(check);
  useEffect(() => {
    void inspect();
  }, []);
  const fetchModel = async () => {
    setAsking(undefined);
    setDetail("");
    setState("downloading");
    try {
      await downloadBigModel(({ receivedBytes, totalBytes }) =>
        setDetail(text.downloadProgress(receivedBytes, totalBytes)),
      );
      await check();
    } catch (e) {
      setState("none");
      throw e; // 사유는 아래 ErrorNotice 에 보인다
    }
  };
  const download = () => act.run(fetchModel);
  // [켜기]: Wi-Fi 면 바로 받고, 아니면 먼저 묻는다
  const turnOn = () =>
    act.run(async () => {
      const kind = await networkKind();
      const gate = downloadGate(kind);
      if (gate === "offline") throw new Error(text.offline);
      if (gate === "start") await fetchModel();
      else setAsking(kind === "metered" ? "metered" : "unknown");
    });
  const retryLoad = () =>
    act.run(async () => {
      await clearBigCrash();
      await check();
    });
  const remove = () =>
    act.run(async () => {
      await removeBigModel();
      setAsking(undefined);
      await check();
    });
  return (
    <View style={{ gap: 6, paddingTop: 14, borderTopWidth: 1, borderColor: colors.line }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Text style={[s.text, { fontWeight: "600" }]}>{text.bigLayer}</Text>
        <Chip tint={layerTint[state]}>{DEVICE_LAYER_STATE_LABELS[state]}</Chip>
      </View>
      <Text style={[s.small, mono]}>{text.bigLayerHint}</Text>
      <Text style={s.small}>{text.bigStates[state]}</Text>
      {!!detail && <Text style={s.small}>{detail}</Text>}
      {(state === "none" || state === "unknown") && <Text style={s.small}>{text.bigRule}</Text>}
      <ErrorNotice error={act.error} />
      {asking ? (
        <Confirm
          message={asking === "remove" ? text.removeBig : text.meteredConfirm(asking)}
          action={asking === "remove" ? text.remove : text.downloadAnyway}
          busy={act.busy}
          onCancel={() => setAsking(undefined)}
          onConfirm={asking === "remove" ? remove : download}
        />
      ) : (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button small busy={act.busy && state !== "downloading"} onPress={inspect}>
            {text.status}
          </Button>
          {(state === "none" || state === "downloading") && (
            <Button small primary busy={state === "downloading"} onPress={turnOn}>
              {text.turnOn}
            </Button>
          )}
          {state === "oom" && (
            <Button small primary busy={act.busy} onPress={retryLoad}>
              {text.retryLoad}
            </Button>
          )}
          <Button
            small
            danger
            disabled={state !== "ready" && state !== "oom"}
            onPress={() => setAsking("remove")}
          >
            {text.remove}
          </Button>
        </View>
      )}
    </View>
  );
}

function LocationBlock() {
  const { api } = useWorkspace();
  const act = useAction();
  const [enabled, setEnabled] = useState<boolean>();
  const [status, setStatus] = useState<LocationState | undefined>(locationState());
  useEffect(() => {
    api.request<{ enabled: boolean }>("/api/location").then(
      (where) => setEnabled(where.enabled),
      () => setStatus("error"),
    );
  }, [api]);
  const toggle = () =>
    act.run(async () => {
      const next = !enabled;
      setStatus(await setLocationEnabled(api, next));
      setEnabled(next);
    });
  return (
    <Block title={text.locationTitle}>
      <CheckRow label={text.locationOn} checked={enabled === true} onPress={toggle} />
      <Text style={s.small}>{text.locationHint}</Text>
      {status && <Text style={s.small}>{text.locationStates[status]}</Text>}
    </Block>
  );
}

function PreferencesCard({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: (next: SettingsView) => void;
}) {
  const { api } = useWorkspace();
  const act = useAction();
  const patch = (body: Partial<Pick<SettingsView, "notifications" | "character">>) =>
    act.run(async () => {
      await api.request("/api/settings", body, "PATCH");
      const next = await api.request<SettingsView>("/api/settings");
      setCharacterPref(next.character); // 열려 있는 모든 캐릭터에 바로 반영
      onSaved(next);
    });
  const { notifications, character } = settings;
  return (
    <View>
      <SectionHeading title={`${text.notifyTitle} · ${text.characterTitle}`} />
      <Card style={{ gap: 10 }}>
        <Block title={text.notifyTitle}>
          {settings.notificationsReady ? (
            <>
              <CheckRow
                label={text.notifyApprovals}
                checked={notifications.approvals}
                onPress={() =>
                  patch({
                    notifications: { ...notifications, approvals: !notifications.approvals },
                  })
                }
              />
              <CheckRow
                label={text.notifyWeekly}
                checked={notifications.weeklyReport}
                onPress={() =>
                  patch({
                    notifications: { ...notifications, weeklyReport: !notifications.weeklyReport },
                  })
                }
              />
            </>
          ) : (
            // 알림 발송이 아직 없다 — 눌러도 달라지는 것이 없는 토글을 두지 않고, 저장된 값만 흐리게 보인다
            <>
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Chip tint={colors.warnBg}>{NOT_READY_LABEL}</Chip>
                <Text style={[s.small, { flex: 1 }]}>{text.notifyNotReady}</Text>
              </View>
              <Text style={[s.text, { opacity: 0.5 }]}>
                {text.notifyApprovals} · {text.onOff(notifications.approvals)}
              </Text>
              <Text style={[s.text, { opacity: 0.5 }]}>
                {text.notifyWeekly} · {text.onOff(notifications.weeklyReport)}
              </Text>
            </>
          )}
        </Block>
        <LocationBlock />
        <Block title={text.characterTitle}>
          <CheckRow
            label={text.characterOn}
            checked={character.enabled}
            onPress={() => patch({ character: { ...character, enabled: !character.enabled } })}
          />
          {character.enabled && (
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Text style={s.small}>{text.intensity}</Text>
              {CHARACTER_INTENSITIES.map((intensity) => (
                <Choice
                  key={intensity}
                  label={CHARACTER_INTENSITY_LABELS[intensity]}
                  selected={character.intensity === intensity}
                  onPress={() => patch({ character: { ...character, intensity } })}
                />
              ))}
            </View>
          )}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Text style={s.small}>{text.teamIcons}</Text>
            {TEAM_ICON_MODES.map((teamIcons) => (
              <Choice
                key={teamIcons}
                label={TEAM_ICON_MODE_LABELS[teamIcons]}
                selected={(character.teamIcons ?? "row") === teamIcons}
                onPress={() => patch({ character: { ...character, teamIcons } })}
              />
            ))}
          </View>
        </Block>
        <ErrorNotice error={act.error} />
      </Card>
    </View>
  );
}

const MENU: { sub: Sub; icon: LucideIcon }[] = [
  { sub: "connections", icon: Plug },
  { sub: "memory", icon: Brain },
  { sub: "skills", icon: Sparkles },
  { sub: "network", icon: Network },
  { sub: "operator", icon: ShieldCheck },
  { sub: "admin", icon: UserCog },
  { sub: "profile", icon: User },
  { sub: "usage", icon: Activity },
];

function Menu({
  role,
  open,
  onLogout,
}: {
  role: UserRole;
  open: (sub: Sub) => void;
  onLogout: () => void;
}) {
  const { api } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [deleteAfter, setDeleteAfter] = useState<string>();
  const remove = useAction();
  return (
    <View>
      <SectionHeading title={text.menuTitle} />
      <Card>
        {MENU.filter((item) => allowed(item.sub, role)).map((item) => (
          <LinkRow
            key={item.sub}
            icon={item.icon}
            title={SUB_TITLES[item.sub]}
            detail={text.menu[item.sub]}
            onPress={() => open(item.sub)}
          />
        ))}
        <LinkRow
          icon={Bug}
          title="오류 보고 · 제안"
          detail="불편한 점이나 바라는 점을 개발팀에 바로 보냅니다"
          onPress={() => openReport()}
        />
        {deleteAfter ? (
          <View style={{ padding: 12, borderRadius: 10, backgroundColor: colors.warnBg }}>
            <Text style={s.text}>{text.deleteAccepted(dateLabel(deleteAfter))}</Text>
          </View>
        ) : confirming ? (
          <Confirm
            message={text.deleteConfirm}
            action={text.deleteAction}
            busy={remove.busy}
            error={remove.error}
            onCancel={() => setConfirming(false)}
            onConfirm={() =>
              remove.run(async () => {
                const result = await api.request<{ deleteAfter: string }>(
                  "/api/account/delete",
                  {},
                );
                setDeleteAfter(result.deleteAfter);
                setConfirming(false);
              })
            }
          />
        ) : (
          <LinkRow
            icon={Trash2}
            tint={colors.missBg}
            title={text.deleteData}
            detail={text.deleteHint}
            onPress={() => setConfirming(true)}
          />
        )}
        {/* 로그아웃은 부모(App)가 한 번만 한다 — 여기서 서버를 직접 부르지 않는다 */}
        <LinkRow icon={LogOut} title={text.logout} onPress={onLogout} />
      </Card>
    </View>
  );
}

// ---- 하위: 프로필 ----
function Profile({ me, onSaved }: { me: MeResponse; onSaved: (me: MeResponse) => void }) {
  const { api, notify } = useWorkspace();
  const [displayName, setDisplayName] = useState(me.profile.displayName);
  const [credentialText, setCredentialText] = useState(me.profile.credentialText ?? ""); // 선택 필드
  const act = useAction();
  return (
    <Card style={{ gap: 12 }}>
      <Text style={s.small}>
        {text.phone} · <Text style={mono}>{me.user.phone}</Text> · {USER_ROLE_LABELS[me.user.role]}
      </Text>
      <Field label={text.displayName} value={displayName} onChangeText={setDisplayName} />
      <Field
        label={text.credential}
        placeholder={text.credentialHint}
        value={credentialText}
        onChangeText={setCredentialText}
      />
      <ErrorNotice error={act.error} />
      <Button
        small
        primary
        busy={act.busy}
        onPress={() =>
          act.run(async () => {
            const profile = await api.request<MeResponse["profile"]>(
              "/api/me/profile",
              { displayName, credentialText },
              "PATCH",
            );
            onSaved({ ...me, profile });
            notify(text.saved);
          })
        }
      >
        {text.save}
      </Button>
    </Card>
  );
}

// ---- 하위: 사용량 상세 ----
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.between}>
      <Text style={s.small}>{label}</Text>
      <Text style={[s.text, mono]}>{value}</Text>
    </View>
  );
}

function UsageDetail() {
  const { api } = useWorkspace();
  const usage = useLoad(() => api.request<MonthUsage>("/api/usage"));
  return (
    <Card style={{ gap: 12 }}>
      <Loaded state={usage} rows={6} height={24}>
        {(u) => (
          <>
            <Text style={[s.small, mono]}>{text.month(u.month)}</Text>
            <Row label={text.calls} value={text.times(u.calls)} />
            <Row
              label={text.tokens}
              value={`${u.tokensIn.toLocaleString("ko-KR")} / ${u.tokensOut.toLocaleString("ko-KR")}`}
            />
            <Row label={text.cost} value={text.krw(u.costKrw)} />
            <Row label={text.scriptSaved} value={text.times(u.scriptSavedCalls)} />
            <Row label={text.byokCalls} value={text.times(u.byokCalls)} />
            <Block title={text.byTier}>
              {u.byTier.map((row) => (
                <Row
                  key={row.tier}
                  label={TIER_LABELS[row.tier as ModelTier]}
                  value={`${text.times(row.calls)} · ${row.tokens.toLocaleString("ko-KR")}`}
                />
              ))}
            </Block>
          </>
        )}
      </Loaded>
    </Card>
  );
}

// ---- 하위: 관리자 (가입 신청 검토 · 사용자 · 패키지 가격) ----
const waitlistTint: Record<WaitlistStatus, string> = {
  pending: colors.accentSoft,
  approved: colors.okBg,
  rejected: colors.missBg,
};
// 표시 이름을 안 정한 회원은 번호만 보인다
const userLabel = (user: AdminUser) =>
  user.name === null ? user.phone : `${user.name} · ${user.phone}`;

/** 가입 신청 한 건의 검토: 사용 목적 전문 → 상위 회원 고르기 → [승인] 또는 사유를 적고 [반려]. */
function WaitlistPending({ item, onDecided }: { item: WaitlistView; onDecided: () => void }) {
  const { api, notify } = useWorkspace();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AdminUser[]>();
  const [parent, setParent] = useState<AdminUser>();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const search = useAction();
  const decide = useAction();
  const find = () =>
    search.run(async () => {
      const query = q.trim();
      if (!query) throw new Error(text.searchRequired);
      setHits(await api.request<AdminUser[]>(`/api/admin/users?q=${encodeURIComponent(query)}`));
    });
  const approve = () =>
    decide.run(async () => {
      if (!parent) throw new Error(text.approveBlocked);
      await api.request(`/api/admin/waitlist/${encodeURIComponent(item.id)}/approve`, {
        parentId: parent.id,
      });
      notify(text.approved(item.phone));
      onDecided();
    });
  const reject = () =>
    decide.run(async () => {
      await api.request(`/api/admin/waitlist/${encodeURIComponent(item.id)}/reject`, {
        reason: reason.trim(),
      });
      notify(text.rejected(item.phone));
      onDecided();
    });
  return (
    <View style={{ gap: 10, paddingBottom: 14, borderBottomWidth: 1, borderColor: colors.line }}>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={[s.text, mono, { fontWeight: "600" }]}>{item.phone}</Text>
        <Chip tint={waitlistTint[item.status]}>{WAITLIST_STATUS_LABELS[item.status]}</Chip>
        <Text style={s.small}>{text.requested(dateLabel(item.requestedAt))}</Text>
      </View>
      <Block title={text.purpose}>
        {item.purpose ? (
          <Text selectable style={s.text}>
            {item.purpose}
          </Text>
        ) : (
          <Text style={[s.small, { color: colors.warn }]}>{text.noPurpose}</Text>
        )}
      </Block>
      <Block title={text.parent}>
        {parent ? (
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Chip tint={colors.okBg}>{userLabel(parent)}</Chip>
            <Button small disabled={decide.busy} onPress={() => setParent(undefined)}>
              {text.change}
            </Button>
          </View>
        ) : (
          <>
            <Text style={s.small}>{text.parentHint}</Text>
            <Field
              label={text.parentSearch}
              value={q}
              onChangeText={setQ}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => void find()}
            />
            <ErrorNotice error={search.error} />
            <Button small busy={search.busy} onPress={() => void find()}>
              {text.search}
            </Button>
            {hits &&
              (hits.length === 0 ? (
                <Text style={s.small}>{text.noHits}</Text>
              ) : (
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  {hits.map((user) => (
                    <Choice
                      key={user.id}
                      label={userLabel(user)}
                      selected={false}
                      onPress={() => setParent(user)}
                    />
                  ))}
                </View>
              ))}
          </>
        )}
      </Block>
      <ErrorNotice error={decide.error} />
      {rejecting ? (
        <>
          <Field
            label={text.rejectReason}
            value={reason}
            onChangeText={setReason}
            multiline
            style={{ minHeight: 72 }}
          />
          {!reason.trim() && (
            <Text style={[s.small, { color: colors.warn }]}>{text.rejectBlocked}</Text>
          )}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              small
              danger
              busy={decide.busy}
              disabled={!reason.trim()}
              onPress={() => void reject()}
            >
              {text.rejectConfirm}
            </Button>
            <Button small disabled={decide.busy} onPress={() => setRejecting(false)}>
              {text.cancel}
            </Button>
          </View>
        </>
      ) : (
        <>
          {!parent && <Text style={[s.small, { color: colors.warn }]}>{text.approveBlocked}</Text>}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              small
              primary
              busy={decide.busy}
              disabled={!parent}
              onPress={() => void approve()}
            >
              {text.approve}
            </Button>
            <Button small danger disabled={decide.busy} onPress={() => setRejecting(true)}>
              {text.reject}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}

function WaitlistReview({ onDecided }: { onDecided: () => void }) {
  const { api } = useWorkspace();
  const waitlist = useLoad(() => api.request<WaitlistView[]>("/api/admin/waitlist"));
  return (
    <Card style={{ gap: 12 }}>
      <Block title={text.waitlist}>
        <Loaded state={waitlist}>
          {(items) => {
            const pending = items.filter((item) => item.status === "pending");
            const decided = items.filter((item) => item.status !== "pending");
            if (items.length === 0) return <Text style={s.small}>{text.noWaitlist}</Text>;
            return (
              <View style={{ gap: 14 }}>
                {pending.length === 0 ? (
                  <Text style={s.small}>{text.noPendingWaitlist}</Text>
                ) : (
                  pending.map((item) => (
                    <WaitlistPending
                      key={item.id}
                      item={item}
                      onDecided={() => {
                        waitlist.retry();
                        onDecided(); // 승인하면 사용자 목록에 한 명이 는다
                      }}
                    />
                  ))
                )}
                {decided.length > 0 && (
                  <Block title={text.decided}>
                    {decided.map((item) => (
                      <View key={item.id} style={{ gap: 2 }}>
                        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                          <Text style={[s.text, mono]}>{item.phone}</Text>
                          <Chip tint={waitlistTint[item.status]}>
                            {WAITLIST_STATUS_LABELS[item.status]}
                          </Chip>
                          {item.decidedAt && (
                            <Text style={s.small}>{dateLabel(item.decidedAt)}</Text>
                          )}
                        </View>
                        {item.rejectReason && (
                          <Text style={s.small}>{text.rejectedWhy(item.rejectReason)}</Text>
                        )}
                      </View>
                    ))}
                  </Block>
                )}
              </View>
            );
          }}
        </Loaded>
      </Block>
    </Card>
  );
}

/** 회원 한 명: 역할(권한) 부여 + 스토어 사용 허용. 자기 역할은 못 바꾼다(서버도 409). */
function UserAdminRow({
  user,
  self,
  packages,
  onChanged,
}: {
  user: AdminUser;
  self: boolean;
  packages: ReturnType<typeof useLoad<StorePkg[]>>;
  onChanged: () => void;
}) {
  const { api, notify } = useWorkspace();
  const [open, setOpen] = useState(false);
  const roleAct = useAction();
  const grantAct = useAction();
  const grants = useLoad(() =>
    api.request<{ packageIds: string[] }>(`/api/admin/grants/${user.id}`),
  );
  const granted = grants.data?.packageIds ?? [];
  return (
    <View
      style={{ gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      <Text style={[s.text, { fontWeight: "600" }]}>{userLabel(user)}</Text>
      <Text style={s.small}>
        {text.role} · {user.tier}
      </Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {USER_ROLES.map((role) => (
          <Choice
            key={role}
            label={USER_ROLE_LABELS[role]}
            selected={user.role === role}
            disabled={self || roleAct.busy}
            onPress={() =>
              roleAct.run(async () => {
                await api.request(`/api/admin/users/${user.id}/role`, { role }, "PATCH");
                notify(text.roleChanged(userLabel(user), USER_ROLE_LABELS[role]));
                onChanged();
              })
            }
          />
        ))}
      </View>
      {self && <Text style={s.small}>{ROLE_SELF_MESSAGE}</Text>}
      <ErrorNotice error={roleAct.error} />
      {user.suspended && <Text style={s.small}>{text.suspendedNow(user.suspended.reason)}</Text>}
      {!self && <UserOversight user={user} onChanged={onChanged} />}
      <Button small onPress={() => setOpen(!open)}>
        {open ? text.grantsHide : text.grants(granted.length)}
      </Button>
      {open && (
        <View style={{ gap: 8 }}>
          <Text style={s.small}>{text.grantsHint}</Text>
          <Loaded state={grants}>
            {() => (
              <Loaded state={packages}>
                {(list) =>
                  list.length === 0 ? (
                    <Text style={s.small}>{text.noPackages}</Text>
                  ) : (
                    <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                      {list.map((pkg) => {
                        const allowed = granted.includes(pkg.id);
                        return (
                          <Choice
                            key={pkg.id}
                            label={pkg.name}
                            selected={allowed}
                            disabled={grantAct.busy}
                            onPress={() =>
                              grantAct.run(async () => {
                                await api.request(
                                  "/api/admin/grants",
                                  { userId: user.id, packageId: pkg.id, allowed: !allowed },
                                  "PUT",
                                );
                                grants.retry();
                              })
                            }
                          />
                        );
                      })}
                    </View>
                  )
                }
              </Loaded>
            )}
          </Loaded>
          <ErrorNotice error={grantAct.error} />
        </View>
      )}
    </View>
  );
}

/**
 * 관리자 감독 (wgolf RPT-02 D·E·F): 이용 정지·해제, 이 회원의 사용량·감사 기록·대화방 보기.
 * 펼칠 때만 불러온다 — 서버가 볼 때마다 관리자 감사(admin.view)를 남기므로, 목록만 훑어서는 남의 기록을 열지 않는다.
 */
function UserOversight({ user, onChanged }: { user: AdminUser; onChanged: () => void }) {
  const { api, notify } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const act = useAction();
  return (
    <View style={{ gap: 8 }}>
      <Button small onPress={() => setOpen(!open)}>
        {open ? text.oversightHide : text.oversight}
      </Button>
      {open && (
        <View style={{ gap: 8 }}>
          {user.suspended ? (
            <Button
              small
              busy={act.busy}
              onPress={() =>
                act.run(async () => {
                  await api.request(
                    `/api/admin/users/${user.id}/suspension`,
                    { suspended: false },
                    "PUT",
                  );
                  notify(text.unsuspended(userLabel(user)));
                  onChanged();
                })
              }
            >
              {text.unsuspend}
            </Button>
          ) : (
            <>
              <Field label={text.suspendReason} value={reason} onChangeText={setReason} />
              <Button
                small
                busy={act.busy}
                disabled={!reason.trim()}
                onPress={() =>
                  act.run(async () => {
                    await api.request(
                      `/api/admin/users/${user.id}/suspension`,
                      { suspended: true, reason: reason.trim() },
                      "PUT",
                    );
                    notify(text.suspended(userLabel(user)));
                    setReason("");
                    onChanged();
                  })
                }
              >
                {text.suspend}
              </Button>
            </>
          )}
          <ErrorNotice error={act.error} />
          <Text style={s.small}>{text.oversightAudited}</Text>
          <OversightView userId={user.id} />
        </View>
      )}
    </View>
  );
}
type UsageView = {
  month: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costKrw: number;
};
type AuditView = { id: string; ts: string; actor: string; action: string; result: string };
type RoomView = { id: string; title: string };
function OversightView({ userId }: { userId: string }) {
  const { api } = useWorkspace();
  const base = `/api/admin/users/${userId}`;
  const usage = useLoad(() => api.request<UsageView>(`${base}/usage`));
  const audit = useLoad(() => api.request<AuditView[]>(`${base}/audit`));
  const rooms = useLoad(() => api.request<RoomView[]>(`${base}/rooms`));
  return (
    <View style={{ gap: 6 }}>
      <Loaded state={usage}>
        {(u) => (
          <Text style={s.small}>
            {text.usageLine(u.month, u.calls, u.tokensIn + u.tokensOut, u.costKrw)}
          </Text>
        )}
      </Loaded>
      <Loaded state={rooms}>
        {(list) => <Text style={s.small}>{text.roomsLine(list.map((r) => r.title))}</Text>}
      </Loaded>
      <Loaded state={audit}>
        {(list) =>
          list.length === 0 ? (
            <Text style={s.small}>{text.noAudit}</Text>
          ) : (
            <View style={{ gap: 2 }}>
              {list.slice(0, 20).map((a) => (
                <Text key={a.id} style={[s.small, mono]}>
                  {a.ts.slice(0, 16).replace("T", " ")} {a.result} {a.action}
                </Text>
              ))}
            </View>
          )
        }
      </Loaded>
    </View>
  );
}

/** 스토어 등록: 팀 YAML 을 붙여 넣고, YAML 에 없는 것(소개·실행 이미지·공개 여부)만 적는다. */
function StoreRegister({ onRegistered }: { onRegistered: () => void }) {
  const { api, notify } = useWorkspace();
  const [yaml, setYaml] = useState("");
  const [summary, setSummary] = useState("");
  const [image, setImage] = useState("");
  const [reviewing, setReviewing] = useState(true);
  const act = useAction();
  return (
    <Card style={{ gap: 12 }}>
      <Block title={text.register}>
        <Text style={s.small}>{text.registerHint}</Text>
        <Field
          label={text.yaml}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          value={yaml}
          onChangeText={setYaml}
          style={[mono, { minHeight: 180 }]}
        />
        <Field label={text.summary} multiline value={summary} onChangeText={setSummary} />
        <Field label={text.image} autoCapitalize="none" value={image} onChangeText={setImage} />
        <Text style={s.small}>{text.listing}</Text>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Choice
            label={text.listReviewing}
            selected={reviewing}
            onPress={() => setReviewing(true)}
          />
          <Choice label={text.listOpen} selected={!reviewing} onPress={() => setReviewing(false)} />
        </View>
        <ErrorNotice error={act.error} />
        <Button
          small
          primary
          busy={act.busy}
          disabled={!yaml.trim() || !summary.trim() || !image.trim()}
          onPress={() =>
            act.run(async () => {
              const pkg = await api.request<StorePkg>("/api/admin/packages/yaml", {
                yaml,
                summary: summary.trim(),
                image: image.trim(),
                reviewing,
              });
              notify(text.registered(pkg.name));
              setYaml("");
              setSummary("");
              setImage("");
              onRegistered();
            })
          }
        >
          {text.registerSubmit}
        </Button>
      </Block>
    </Card>
  );
}

/** 영시리가 지금 쓰는 서버 모델 — `GET /api/admin/models`(서버 라우팅이 읽는 값 그대로). 웹·앱이 같은 서버라 같은 모델 */
function ServerModels() {
  const { api } = useWorkspace();
  const models = useLoad(() => api.request<ModelsView>("/api/admin/models"));
  return (
    <Card style={{ gap: 8 }}>
      <Block title="영시리 모델 (서버)">
        <Loaded state={models}>
          {(m) => (
            <>
              {FIXED_TIERS.map((t) => (
                <Text key={t} style={s.text}>
                  {TIER_LABELS[t]} · <Text style={mono}>{m.tiers[t] || "없음"}</Text>
                </Text>
              ))}
              {m.unset.length > 0 && (
                <Text style={s.small}>{m.unset.join("·")} 미설정 → 모두 기본 모델(MODEL)</Text>
              )}
              <Text style={s.small}>
                답마다 아래 작은 글씨에 어느 등급이 답했는지 나온다 · 기기 대화 모델은 아직 꺼져
                있다
              </Text>
            </>
          )}
        </Loaded>
      </Block>
    </Card>
  );
}

// 관리자 제한 (wgolf RPT-02 E) — 판매 중지 = reviewing, 실행 중지 = halted. 서버가 감사 store.restrict 를 남긴다
function PackageRestrict({ pkg, onChanged }: { pkg: StorePkg; onChanged: () => void }) {
  const { api, notify } = useWorkspace();
  const [reason, setReason] = useState("");
  const act = useAction();
  const patch = (body: { reviewing?: boolean; halted?: boolean }) =>
    act.run(async () => {
      await api.request(
        `/api/admin/packages/${pkg.id}`,
        { ...body, reason: reason.trim() },
        "PATCH",
      );
      notify(text.restricted(pkg.name));
      setReason("");
      onChanged();
    });
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{pkg.name}</Text>
      {pkg.reviewing && <Text style={s.small}>{text.saleStopped}</Text>}
      {pkg.halted && <Text style={s.small}>{text.haltedNow(pkg.halted.reason)}</Text>}
      <Field label={text.restrictReason} value={reason} onChangeText={setReason} />
      <ErrorNotice error={act.error} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button small busy={act.busy} onPress={() => patch({ reviewing: !pkg.reviewing })}>
          {pkg.reviewing ? text.resumeSale : text.stopSale}
        </Button>
        <Button
          small
          busy={act.busy}
          disabled={!pkg.halted && !reason.trim()}
          onPress={() => patch({ halted: !pkg.halted })}
        >
          {pkg.halted ? text.resume : text.halt}
        </Button>
      </View>
    </View>
  );
}

function BlockedTools({ value, onChanged }: { value: unknown; onChanged: () => void }) {
  const { api } = useWorkspace();
  return (
    <ToolListEditor
      title={text.blocked}
      hint={text.blockedHint}
      list={Array.isArray(value) ? (value as string[]) : []}
      onSave={async (next) => {
        await api.request("/api/admin/settings", { key: "blockedTools", value: next }, "PATCH");
        onChanged();
      }}
    />
  );
}

function Admin({ meId }: { meId: string }) {
  const { api, notify } = useWorkspace();
  const users = useLoad(() => api.request<AdminUser[]>("/api/admin/users"));
  const packages = useLoad(() => api.request<StorePkg[]>("/api/store/packages"));
  const settings = useLoad(() =>
    api.request<{ settings: { id: string; value: unknown }[] }>("/api/admin/settings"),
  );
  const [slug, setSlug] = useState("");
  const [price, setPrice] = useState("");
  const priceAct = useAction();
  return (
    <View style={columns}>
      <View style={column}>
        <ServerModels />
        <WaitlistReview onDecided={users.retry} />
        <StoreRegister onRegistered={packages.retry} />
      </View>
      <View style={column}>
        <Card style={{ gap: 12 }}>
          <Block title={text.users}>
            <Loaded state={users}>
              {(items) =>
                items.length === 0 ? (
                  <Text style={s.small}>{text.noUsers}</Text>
                ) : (
                  items.map((u) => (
                    <UserAdminRow
                      key={u.id}
                      user={u}
                      self={u.id === meId}
                      packages={packages}
                      onChanged={users.retry}
                    />
                  ))
                )
              }
            </Loaded>
          </Block>
        </Card>
        <Card style={{ gap: 12 }}>
          <Block title={text.prices}>
            <Loaded state={settings}>
              {(data) => {
                const prices = data.settings.filter((x) => x.id.startsWith("price:"));
                return prices.length === 0 ? (
                  <Text style={s.small}>{text.noPrices}</Text>
                ) : (
                  prices.map((p) => (
                    <Row
                      key={p.id}
                      label={p.id.slice("price:".length)}
                      value={won(Number(p.value))}
                    />
                  ))
                );
              }}
            </Loaded>
            <Field label={text.slug} autoCapitalize="none" value={slug} onChangeText={setSlug} />
            <Field
              label={text.price}
              keyboardType="numeric"
              value={price}
              onChangeText={setPrice}
            />
            <ErrorNotice error={priceAct.error} />
            <Button
              small
              primary
              busy={priceAct.busy}
              disabled={!slug.trim() || !price.trim()}
              onPress={() =>
                priceAct.run(async () => {
                  const n = Number(price);
                  if (!Number.isFinite(n) || n < 0) throw new Error(text.priceInvalid);
                  await api.request(
                    "/api/admin/settings",
                    { key: `price:${slug.trim()}`, value: n },
                    "PATCH",
                  );
                  setSlug("");
                  setPrice("");
                  settings.retry();
                  notify(text.saved);
                })
              }
            >
              {text.save}
            </Button>
          </Block>
        </Card>
        <Card style={{ gap: 12 }}>
          <Block title={text.restrict}>
            <Text style={s.small}>{text.restrictHint}</Text>
            <Loaded state={packages}>
              {(items) =>
                items.length === 0 ? (
                  <Text style={s.small}>{text.noPackages}</Text>
                ) : (
                  items.map((p) => (
                    <PackageRestrict key={p.id} pkg={p} onChanged={packages.retry} />
                  ))
                )
              }
            </Loaded>
          </Block>
          <Loaded state={settings}>
            {(data) => (
              <BlockedTools
                value={data.settings.find((x) => x.id === "blockedTools")?.value}
                onChanged={settings.retry}
              />
            )}
          </Loaded>
        </Card>
      </View>
    </View>
  );
}
