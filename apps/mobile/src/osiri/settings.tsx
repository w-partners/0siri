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
import { MemoryScreen } from "./memory";
import { NetworkScreen } from "./network";
import { OperatorScreen } from "./operator";
import { SkillsScreen } from "./skills";
import { Block, Choice, useAction, useLoad, won } from "./store";
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
    device:
      "항상 기기: 가능한 작업은 기기에서 끝내고, 도구·웹·긴 작업은 실행 전에 서버 상향 확인을 띄웁니다",
    server: "항상 서버: 기기 답변을 쓰지 않습니다",
  } satisfies Record<AnswerMode, string>,
  deviceModeNotReady: `${ANSWER_MODE_LABELS.device}는 ${NOT_READY_LABEL}입니다 — 기기 대화 모델(큰 층 · ${BIG_LAYER.name})이 아직 없어 고를 수 없습니다`,
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
  bigLayerHint: `${BIG_LAYER.size} · 사용자가 켜면 Wi-Fi로 다운로드 · 기기 대화 답변`,
  bigUnavailable: "이 빌드에서는 아직 받을 수 없습니다",
  bigReason:
    "기기 LLM 런타임(LiteRT-LM)이 아직 앱에 들어 있지 않습니다. 그때까지 대화 답변은 서버가 합니다.",
  bigRule:
    "받을 수 있게 되면 [켜기]를 눌러야만 내려받고, Wi-Fi 가 아니면 시작 전에 확인을 요구합니다.",
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
  characterOn: "캐릭터 표시",
  intensity: "반응 강도",
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
  deleteHint: `계정과 모든 데이터를 ${RETENTION_DAYS}일 안에 삭제합니다`,
  deleteConfirm: `데이터 삭제를 요청하면 ${RETENTION_DAYS}일 안에 계정·기억·대화가 모두 지워지고 되돌릴 수 없습니다.`,
  deleteAction: "삭제 요청",
  deleteAccepted: (date: string) =>
    `삭제 요청을 접수했습니다. ${RETENTION_DAYS}일 안에(${date}까지) 모두 삭제되고 증적이 남습니다.`,
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
      return <ConnectionsScreen />;
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
              />
            </>
          )}
        </Loaded>
        <DeviceCard />
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
}: {
  settings: SettingsView;
  onSaved: (next: SettingsView) => void;
  usage: UsageState;
  openConnections: () => void;
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
                  // 기기 대화 모델(티어 1)이 아직 없다 — 고를 수 없게 두고 아래에 사유를 적는다
                  disabled={mode === "device"}
                  onPress={() => patch({ answerMode: mode })}
                />
              ))}
            </View>
            {settings.answerMode !== "device" && (
              <Text style={s.small}>{text.answerModeHints[settings.answerMode]}</Text>
            )}
            <Text style={s.small}>{text.deviceModeNotReady}</Text>
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

function DeviceCard() {
  const [state, setState] = useState<LayerState>("unknown");
  const [detail, setDetail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [bigOpen, setBigOpen] = useState(false);
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
        <View style={{ gap: 6, paddingTop: 14, borderTopWidth: 1, borderColor: colors.line }}>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            <Text style={[s.text, { fontWeight: "600" }]}>{text.bigLayer}</Text>
            <Chip tint={colors.warnBg}>{NOT_READY_LABEL}</Chip>
          </View>
          <Text style={[s.small, mono]}>{text.bigLayerHint}</Text>
          <Text style={[s.small, { color: colors.warn }]}>{text.bigUnavailable}</Text>
          {bigOpen && (
            <>
              <Text style={s.small}>{text.bigReason}</Text>
              <Text style={s.small}>{text.bigRule}</Text>
            </>
          )}
          {/* 받을 실물이 없다 — [켜기] 버튼을 두지 않고 «준비 중» 칩과 사유만 보인다 */}
          <View style={[s.row, { gap: 8 }]}>
            <Button small onPress={() => setBigOpen(!bigOpen)}>
              {text.status}
            </Button>
          </View>
        </View>
      </Card>
    </View>
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
      </View>
    </View>
  );
}
