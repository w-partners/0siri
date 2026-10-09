// 0Siri 화면 11 · 설정 (모델 · 사용량 · 과금). 계약: docs/0siri-api-contract.md «설정 (화면 11)».
// 짧은 한 장 + 하위 화면(연결 7 · 기억 8 · 스킬 9 · 운영자 콘솔 10 …). 웹은 /settings/<sub> 로 주소에 남긴다.
import {
  Activity,
  ArrowLeft,
  Brain,
  LogOut,
  type LucideIcon,
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
  EMBED_DOWNLOAD_MB,
  EMBED_MODEL_ID,
  FIXED_TIERS,
  type ModelTier,
  RETENTION_DAYS,
  TIER_LABELS,
  USER_ROLES,
  type UserRole,
} from "../../../../packages/domain/src/osiri";
import type { Invite, PublicUser } from "../../../server/src/osiri/accounts.ts";
import type { Routing } from "../../../server/src/osiri/routing.ts";
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
import type { Me } from "./auth";
import {
  Confirm,
  ConnectionsScreen,
  column,
  columns,
  KEY_PROVIDERS,
  Loaded,
  type ModelKey,
  mono,
  PROVIDER_LABELS,
} from "./connections";
import { deviceAvailable, embedOnDevice, measureDevice } from "./device-embed";
import { MemoryScreen } from "./memory";
import { OperatorScreen } from "./operator";
import { SkillsScreen } from "./skills";
import { Block, Choice, useAction, useLoad, won } from "./store";

// ---- 계약 타입 (서버 타입에 아직 없는 것만 한 번 선언 — 서버가 내보내면 그쪽을 type-import 한다) ----
const ANSWER_MODE_LABELS = { auto: "자동", device: "항상 기기", server: "항상 서버" } as const;
type AnswerMode = keyof typeof ANSWER_MODE_LABELS;
const INTENSITY_LABELS = { motion: "동작", face: "표정만", text: "문구만" } as const;
type Intensity = keyof typeof INTENSITY_LABELS;
/** 계약 «설정»: GET /settings */
interface AppSettings {
  tier: { label: string; subscription: string | null; nextBillingAt: string | null };
  answerMode: AnswerMode;
  autoEconomy: boolean;
  fixedModel: string | null;
  monthlyCapKrw: number | null;
  notifications: { approvals: boolean; weeklyReport: boolean };
  character: { enabled: boolean; intensity: Intensity };
}
/** 계약 «설정»: GET /billing/usage. percent 는 상한 대비 0~100, null = 측정 중 */
interface BillingUsage {
  costKrw: number;
  capKrw: number | null;
  percent: number | null;
  byok: boolean;
  savedKrw: number | null;
}
type MonthUsage = Awaited<ReturnType<Routing["month"]>>;

// ---- 하위 화면 ----
const SUBS = ["connections", "memory", "skills", "operator", "admin", "profile", "usage"] as const;
type Sub = (typeof SUBS)[number];
const isSub = (value: string | undefined): value is Sub => SUBS.some((sub) => sub === value);
const SUB_TITLES: Record<Sub, string> = {
  connections: "연결",
  memory: "기억",
  skills: "스킬",
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
/** 큰 층 표기 — 기획 화면 11 의 값. 이 빌드에는 내려받을 실물이 없어 다른 정의처가 없다 */
const BIG_LAYER = { name: "Gemma 4 E2B", size: "2.0GB" };
/** transformers.js 가 브라우저에 모델을 두는 캐시 이름 (device-embed.web.ts 가 그 라이브러리로 받는다) */
const MODEL_CACHE = "transformers-cache";
const LAYER_STATE_LABELS = {
  unknown: "확인 전",
  none: "미다운로드",
  downloading: "다운로드 중",
  ready: "준비됨",
  unsupported: "미지원 기기",
  oom: "메모리 부족",
} as const;
type LayerState = keyof typeof LAYER_STATE_LABELS;
const layerTint: Partial<Record<LayerState, string>> = {
  ready: colors.okBg,
  downloading: colors.accentSoft,
  unsupported: colors.warnBg,
  oom: colors.missBg,
};
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
// ponytail: 메모리 부족은 런타임이 던진 오류 문장으로만 가린다 — 런타임이 종류를 알려 주면 그걸로 바꾼다
const isOutOfMemory = (e: unknown) =>
  e instanceof RangeError || /out of memory|allocation failed|bad_alloc/i.test(reasonOf(e));
const modelCached = async (cache: Cache) =>
  (await cache.keys()).filter((request) => request.url.includes(EMBED_MODEL_ID));

const text = {
  back: "설정",
  save: "저장",
  saved: "저장했습니다",
  add: "추가",
  cancel: "취소",
  roles: { user: "사용자", operator: "운영자", admin: "관리자" } satisfies Record<UserRole, string>,
  tierTitle: "등급 · 구독",
  subscribed: (name: string) => `${name} 구독 중`,
  noSubscription: "구독 중인 팀이 없습니다",
  goStore: "스토어 보기",
  nextBilling: "다음 결제일",
  noBilling: "예정된 결제가 없습니다",
  modelTitle: "답변 방식 · 모델",
  answerMode: "답변 방식",
  answerModeHints: {
    auto: "자동: 티어 0 임베딩 신호 → 티어 1 기기 답변 → 서버 경량·주력·최고로 상향",
    device:
      "항상 기기: 가능한 작업은 기기에서 끝내고, 도구·웹·긴 작업은 실행 전에 서버 상향 확인을 띄웁니다",
    server: "항상 서버: 기기 답변을 쓰지 않습니다",
  } satisfies Record<AnswerMode, string>,
  autoEconomy: "가성비 자동 라우팅",
  fixedModel: "모델 직접 고르기",
  fixedNone: "고르지 않음",
  fixedCurrent: (model: string) => `지금 고정된 모델: ${model}`,
  deviceTitle: "기기 모델",
  smallLayer: "작은 층 · 임베딩젬마 2",
  smallLayerHint: `기본 다운로드 ${EMBED_DOWNLOAD_MB}MB · 기억 검색·분류 신호`,
  status: "상태",
  download: "받기",
  remove: "삭제",
  removeSmall:
    "작은 층을 지우면 기억 검색은 서버 임베딩으로 대체됩니다. 이미 올라온 모델은 이 화면을 새로 고칠 때까지 메모리에 남습니다.",
  cacheUnreadable: "이 환경은 모델 저장소를 조회할 수 없어 내려받았는지 확인하지 못합니다",
  smallStates: {
    unknown: "아직 확인하지 않았습니다",
    none: "내려받지 않았습니다 — 기억 검색은 서버 임베딩으로 합니다",
    downloading: "내려받는 중입니다",
    ready: "이 기기에 있습니다 — 기억 검색을 기기에서 합니다",
    unsupported: "이 기기에서는 쓸 수 없습니다 — 기억 검색은 서버 임베딩으로 합니다",
    oom: "메모리가 모자라 올리지 못했습니다 — 기억 검색은 서버 임베딩으로 합니다",
  } satisfies Record<LayerState, string>,
  bigLayer: `큰 층 · ${BIG_LAYER.name}`,
  bigLayerHint: `${BIG_LAYER.size} · 사용자가 켜면 Wi-Fi로 다운로드 · 기기 대화 답변`,
  turnOn: "켜기",
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
  warn80: "월 상한의 80%를 넘었습니다",
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
  characterTitle: "캐릭터",
  characterOn: "캐릭터 표시",
  intensity: "반응 강도",
  menuTitle: "더 보기",
  menu: {
    connections: "MCP 도구 · 모델 계정(내 API 키)",
    memory: "에이전트가 나에 대해 아는 사실 · 개인 스킬",
    skills: "스킬 초안 승인 · 버전",
    operator: "패키지 버전 · 지표 · 공지",
    admin: "초대 · 사용자 · 패키지 가격",
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
  invite: "초대 만들기",
  inviteUrl: "초대 링크",
  inviteToken: "초대 토큰 (한 번만 표시됩니다)",
  expires: "만료",
  phoneOptional: "전화번호 (선택)",
  invites: "초대 목록",
  used: "사용됨",
  unused: "미사용",
  noInvites: "초대가 없습니다 — 위에서 초대를 만들면 여기에 보입니다",
  users: "사용자 목록",
  noUsers: "사용자가 없습니다 — 초대를 수락한 사용자가 여기에 보입니다",
  prices: "패키지 가격",
  slug: "패키지 슬러그",
  price: "월 가격 (원, 0 = 무료)",
  priceInvalid: "가격은 0 이상의 숫자여야 합니다",
  noPrices: "설정된 가격이 없습니다 (전부 파일럿 무료)",
};

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const { api } = useWorkspace();
  const me = useLoad(() => api.request<Me>("/api/me"));
  const [sub, setSub] = useState(readSub);
  useEffect(() => writeSub(sub), [sub]);
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
      <Loaded state={me} rows={4} height={88}>
        {(account) =>
          sub ? (
            <SubScreen sub={sub} me={account} onProfile={me.setData} />
          ) : (
            <Main me={account} open={setSub} onLogout={onLogout} />
          )
        }
      </Loaded>
    </ScrollView>
  );
}

const allowed = (sub: Sub, role: UserRole) => SUB_ROLES[sub]?.includes(role) ?? true; // 표에 없으면 누구나

function SubScreen({ sub, me, onProfile }: { sub: Sub; me: Me; onProfile: (me: Me) => void }) {
  if (!allowed(sub, me.user.role)) return <ErrorNotice error={text.forbidden} />;
  switch (sub) {
    case "connections":
      return <ConnectionsScreen />;
    case "memory":
      return <MemoryScreen />;
    case "skills":
      return <SkillsScreen />;
    case "operator":
      return <OperatorScreen />;
    case "admin":
      return <Admin />;
    case "profile":
      return <Profile me={me} onSaved={onProfile} />;
    case "usage":
      return <UsageDetail />;
  }
}

function Main({ me, open, onLogout }: { me: Me; open: (sub: Sub) => void; onLogout: () => void }) {
  const { api } = useWorkspace();
  const settings = useLoad(() => api.request<AppSettings>("/api/settings"));
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

function TierCard({ tier }: { tier: AppSettings["tier"] }) {
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
        <View style={s.between}>
          <Text style={s.small}>{text.nextBilling}</Text>
          <Text style={[s.text, mono]}>
            {tier.nextBillingAt === null ? text.noBilling : dateLabel(tier.nextBillingAt)}
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
  settings: AppSettings;
  onSaved: (next: AppSettings) => void;
  usage: UsageState;
  openConnections: () => void;
}) {
  const { api, notify } = useWorkspace();
  const act = useAction();
  const [cap, setCap] = useState<string>();
  // 서버가 받아들인 뒤에 서버 값을 다시 읽어 보인다 (낙관적 표시 없음)
  const patch = (body: Partial<Pick<AppSettings, "answerMode" | "autoEconomy" | "fixedModel">>) =>
    act.run(async () => {
      await api.request("/api/settings/model", body, "PATCH");
      onSaved(await api.request<AppSettings>("/api/settings"));
    });
  const saveCap = () =>
    act.run(async () => {
      const raw = (cap ?? "").trim();
      const value = raw === "" ? null : Number(raw);
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new Error(text.capInvalid);
      await api.request("/api/settings/model", { monthlyCapKrw: value }, "PATCH");
      onSaved(await api.request<AppSettings>("/api/settings"));
      setCap(undefined);
      notify(text.saved);
    });
  const fixedTier = FIXED_TIERS.find((tier) => String(tier) === settings.fixedModel);
  return (
    <>
      <View>
        <SectionHeading title={text.modelTitle} />
        <Card style={{ gap: 12 }}>
          <Block title={text.answerMode}>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              {(Object.keys(ANSWER_MODE_LABELS) as AnswerMode[]).map((mode) => (
                <Choice
                  key={mode}
                  label={ANSWER_MODE_LABELS[mode]}
                  selected={settings.answerMode === mode}
                  onPress={() => patch({ answerMode: mode })}
                />
              ))}
            </View>
            <Text style={s.small}>{text.answerModeHints[settings.answerMode]}</Text>
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
                    selected={fixedTier === tier}
                    onPress={() => patch({ fixedModel: String(tier) })}
                  />
                ))}
              </View>
              {settings.fixedModel !== null && fixedTier === undefined && (
                <Text style={[s.small, mono]}>{text.fixedCurrent(settings.fixedModel)}</Text>
              )}
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
  const level =
    percent === null ? undefined : percent >= 100 ? "miss" : percent >= 80 ? "warn" : undefined;
  return (
    <>
      {usage.byok ? (
        // 자기 키 활성: 사용량 바 대신 이 한 줄
        <Chip tint={colors.okBg}>{text.byokUsage}</Chip>
      ) : usage.capKrw === null ? (
        <Text style={s.small}>{text.noCap}</Text>
      ) : percent === null ? (
        <Chip>{text.measuring}</Chip>
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
                {level === "miss" ? text.capReached : text.warn80}
              </Text>
              {level === "miss" && (
                <Button small onPress={openConnections}>
                  {text.manageKeys}
                </Button>
              )}
            </View>
          )}
          <View style={s.between}>
            <Text style={[s.text, mono, { fontWeight: "600" }]}>{text.percentOfCap(percent)}</Text>
            <Text style={[s.small, mono]}>
              {text.spent(text.krw(usage.costKrw), text.krw(usage.capKrw))}
            </Text>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
            style={{ height: 8, borderRadius: 4, backgroundColor: colors.sunk, overflow: "hidden" }}
          >
            <View
              style={{
                width: `${Math.min(Math.max(percent, 0), 100)}%`,
                height: 8,
                backgroundColor:
                  level === "miss" ? colors.miss : level === "warn" ? colors.warn : colors.accent,
              }}
            />
          </View>
        </>
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
  const keys = useLoad(() => api.request<ModelKey[]>("/api/model-keys"));
  return (
    <View>
      <SectionHeading title={text.keysTitle} />
      <Card style={{ gap: 8 }}>
        <Loaded state={keys} rows={1}>
          {(items) => {
            const active = KEY_PROVIDERS.flatMap((provider) =>
              items.filter((item) => item.provider === provider && item.status === "active"),
            );
            return active.length === 0 ? (
              <Text style={s.small}>{text.noKeys}</Text>
            ) : (
              active.map((item) => (
                <Text key={item.provider} style={[s.text, mono]}>
                  {text.keyActive(PROVIDER_LABELS[item.provider], item.last4)}
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
  const inspect = () =>
    act.run(async () => {
      setDetail("");
      if (!deviceAvailable()) {
        const report = await measureDevice(); // 쓸 수 없는 이유를 기기 쪽에서 받아 그대로 보인다
        setState("unsupported");
        setDetail(report.reason ?? "");
        return;
      }
      if (typeof caches === "undefined") {
        setState("unknown");
        setDetail(text.cacheUnreadable);
        return;
      }
      const files = await modelCached(await caches.open(MODEL_CACHE));
      setState(files.length > 0 ? "ready" : "none");
    });
  useEffect(() => {
    void inspect();
  }, []);
  const download = () =>
    act.run(async () => {
      setDetail("");
      setState("downloading");
      try {
        await embedOnDevice(["상태 확인"], "query"); // 첫 호출이 모델을 내려받아 올린다
        setState("ready");
      } catch (e) {
        setState(isOutOfMemory(e) ? "oom" : "none");
        throw e; // 사유는 아래 ErrorNotice 에 보인다
      }
    });
  const remove = () =>
    act.run(async () => {
      const cache = await caches.open(MODEL_CACHE);
      for (const request of await modelCached(cache)) await cache.delete(request);
      setConfirming(false);
      setState("none");
    });
  const canRemove = state === "ready" && typeof caches !== "undefined";
  return (
    <View>
      <SectionHeading title={text.deviceTitle} />
      <Card style={{ gap: 14 }}>
        <View style={{ gap: 6 }}>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            <Text style={[s.text, { fontWeight: "600" }]}>{text.smallLayer}</Text>
            <Chip tint={layerTint[state]}>{LAYER_STATE_LABELS[state]}</Chip>
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
            <Chip>{LAYER_STATE_LABELS.none}</Chip>
          </View>
          <Text style={[s.small, mono]}>{text.bigLayerHint}</Text>
          <Text style={[s.small, { color: colors.warn }]}>{text.bigUnavailable}</Text>
          {bigOpen && (
            <>
              <Text style={s.small}>{text.bigReason}</Text>
              <Text style={s.small}>{text.bigRule}</Text>
            </>
          )}
          <View style={[s.row, { gap: 8 }]}>
            {/* 받을 실물이 없다 — 눌리는 척하지 않는다 */}
            <Button small disabled onPress={() => undefined}>
              {text.turnOn}
            </Button>
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
  settings: AppSettings;
  onSaved: (next: AppSettings) => void;
}) {
  const { api } = useWorkspace();
  const act = useAction();
  const patch = (body: Partial<Pick<AppSettings, "notifications" | "character">>) =>
    act.run(async () => {
      await api.request("/api/settings", body, "PATCH");
      onSaved(await api.request<AppSettings>("/api/settings"));
    });
  const { notifications, character } = settings;
  return (
    <View>
      <SectionHeading title={`${text.notifyTitle} · ${text.characterTitle}`} />
      <Card style={{ gap: 10 }}>
        <Block title={text.notifyTitle}>
          <CheckRow
            label={text.notifyApprovals}
            checked={notifications.approvals}
            onPress={() =>
              patch({ notifications: { ...notifications, approvals: !notifications.approvals } })
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
              {(Object.keys(INTENSITY_LABELS) as Intensity[]).map((intensity) => (
                <Choice
                  key={intensity}
                  label={INTENSITY_LABELS[intensity]}
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
function Profile({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const { api, notify } = useWorkspace();
  const [displayName, setDisplayName] = useState(me.profile.displayName);
  const [credentialText, setCredentialText] = useState(me.profile.credentialText ?? ""); // 선택 필드
  const act = useAction();
  return (
    <Card style={{ gap: 12 }}>
      <Text style={s.small}>
        {text.phone} · <Text style={mono}>{me.user.phone}</Text> · {text.roles[me.user.role]}
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
            const profile = await api.request<Me["profile"]>(
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

// ---- 하위: 관리자 (초대 · 사용자 · 패키지 가격) ----
function Admin() {
  const { api, notify } = useWorkspace();
  const invites = useLoad(() => api.request<Invite[]>("/api/admin/invites"));
  const users = useLoad(() => api.request<PublicUser[]>("/api/admin/users"));
  const settings = useLoad(() =>
    api.request<{ settings: { id: string; value: unknown }[] }>("/api/admin/settings"),
  );
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [issued, setIssued] = useState<{ token: string; url: string; expiresAt: number }>();
  const inviteAct = useAction();
  const [slug, setSlug] = useState("");
  const [price, setPrice] = useState("");
  const priceAct = useAction();
  return (
    <View style={columns}>
      <View style={column}>
        <Card style={{ gap: 12 }}>
          <Block title={text.invite}>
            <Field
              label={text.phoneOptional}
              keyboardType="phone-pad"
              value={phone}
              onChangeText={setPhone}
            />
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              {USER_ROLES.map((r) => (
                <Choice
                  key={r}
                  label={text.roles[r]}
                  selected={role === r}
                  onPress={() => setRole(r)}
                />
              ))}
            </View>
            <ErrorNotice error={inviteAct.error} />
            <Button
              small
              primary
              busy={inviteAct.busy}
              onPress={() =>
                inviteAct.run(async () => {
                  setIssued(
                    await api.request("/api/admin/invites", {
                      ...(phone.trim() ? { phone: phone.trim() } : {}),
                      role,
                    }),
                  );
                  setPhone("");
                  invites.retry();
                })
              }
            >
              {text.invite}
            </Button>
            {issued && (
              <View style={{ gap: 4 }}>
                {/* expo-clipboard 미설치 → 선택 가능한 텍스트로 둔다 (의도된 1회 노출) */}
                <Text style={s.small}>{text.inviteToken}</Text>
                <Text selectable style={[s.text, mono]}>
                  {issued.token}
                </Text>
                <Text style={s.small}>{text.inviteUrl}</Text>
                <Text selectable style={[s.text, mono]}>
                  {issued.url}
                </Text>
                <Text style={s.small}>
                  {text.expires} {dateLabel(new Date(issued.expiresAt).toISOString())}
                </Text>
              </View>
            )}
          </Block>
        </Card>
        <Card style={{ gap: 12 }}>
          <Block title={text.invites}>
            <Loaded state={invites}>
              {(items) =>
                items.length === 0 ? (
                  <Text style={s.small}>{text.noInvites}</Text>
                ) : (
                  items.map((i) => (
                    <Row
                      key={i.id}
                      label={`${i.phone ?? "—"} · ${text.roles[i.role]}`}
                      value={`${i.usedBy ? text.used : text.unused} · ${text.expires} ${dateLabel(new Date(i.expiresAt).toISOString())}`}
                    />
                  ))
                )
              }
            </Loaded>
          </Block>
        </Card>
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
                    <Row key={u.id} label={u.phone} value={`${text.roles[u.role]} · ${u.tier}`} />
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
