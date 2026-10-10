// 0Siri 화면 6 · 스토어 («0Siri 종합 기획» §03): 탐색 / 내 구독. 계약: docs/0siri-api-contract.md «스토어». 탭 URL 동기화는 App 이 맡는다.
import { Search, Store } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  STORE_CATEGORIES,
  STORE_CATEGORY_ALL_LABEL,
  STORE_CATEGORY_LABELS,
  type StoreCategory,
  SUBSCRIPTION_STATUS_LABELS,
  type SubscribeErrorKind,
  THIRD_PARTY_LABEL,
} from "../../../../packages/domain/src/osiri";
import type { MeResponse } from "../../../server/src/osiri/account-routes.ts";
import type { Catalog, publicPackage } from "../../../server/src/osiri/store.ts";
import { ApiError } from "../api-response";
import {
  Badge,
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  fonts,
  Sheet,
  Skeleton,
  s,
  useAction,
  useWide,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar } from "./eve";
import { GoalStep, ONBOARDING_TITLES, ProfileStep, profileComplete } from "./onboarding-steps";

/** `GET /store/packages` 항목 — 서버 `publicPackage()` 가 만든다. */
type Pkg = ReturnType<typeof publicPackage>;
/** `GET /subscriptions/mine` 항목 — 서버 `Catalog.cards()` 가 만든다. */
type Sub = Awaited<ReturnType<Catalog["cards"]>>[number];
type SubscribeResult = Awaited<ReturnType<Catalog["subscribe"]>>;
type StoreTab = "explore" | "mine";

const text = {
  tabs: { explore: "탐색", mine: "내 구독" } satisfies Record<StoreTab, string>,
  search: "검색",
  searchHint: "팀 이름 · 역할 · 분야 검색",
  verified: "검증된 팀",
  reviewing: "입점 심사 중",
  agents: "에이전트",
  people: "명",
  unit: "월 구독",
  free: "무료",
  perMonth: (won: number) => `${won.toLocaleString("ko-KR")}원/월`,
  conversion: "발행→인용 전환율",
  measuring: "측정 중",
  roles: "역할표",
  approvals: "승인 지점",
  approvalsHint: "아래 행위는 사용자의 승인 없이는 실행되지 않습니다.",
  cadence: "보고 주기",
  dataHandling: "데이터 처리 방식",
  metrics: "공개 성과 지표",
  notice: "운영자 공지",
  disclosure: "공개 범위",
  disclosed: "공개: 역할 구성 · 승인 지점 · 보고 주기 · 성과 지표",
  undisclosed: "비공개: 프롬프트 전문 · 검수 규칙",
  subscribe: "구독하기",
  tierNotice: "구독 안내",
  confirmTitle: "구독 확인",
  confirmBody: (name: string) =>
    `「${name}」 구독을 시작합니다. 팀 방이 만들어지고 팀장이 첫 인사를 보냅니다.`,
  confirm: "구독 확정",
  priorTitle: "이전에 구독했던 팀입니다",
  priorBody: "기존 방과 기억을 복원할지, 새로 시작할지 골라 주세요.",
  restore: "복원",
  fresh: "새로 시작",
  subscribed: (name: string) => `${name} 구독을 시작했습니다`,
  subscribedBody: "팀 방을 만들었습니다. 내 구독 탭에도 추가됐습니다.",
  noRoom: "구독 중인 팀인데 방 정보를 받지 못했습니다.",
  openRoom: "방으로 이동",
  manage: "구독 관리",
  retry: "다시 시도",
  close: "닫기",
  back: "돌아가기",
  pickTeam: "팀을 고르면 상세가 여기에 보입니다.",
  pickSub: "구독을 고르면 관리 패널이 여기에 보입니다.",
  emptyExplore: "검색 결과가 없습니다",
  emptyExploreHint: "다른 단어로 검색",
  emptyStore: "아직 입점한 팀이 없습니다",
  emptyStoreHint: "팀이 입점하면 여기에 보입니다.",
  onboardTitle: "팀과 시작하기",
  onboardBody: "팀이 일을 시작할 수 있게 프로필과 첫 목표를 알려 주세요.",
  onboardDone: "첫 목표를 팀 방에 제안으로 올렸습니다. 목표 탭에서 승인하면 시작합니다.",
  showAll: "전체 목록 보기",
  emptyMine: "아직 구독한 팀이 없습니다",
  emptyMineHint: "탐색 탭에서 팀을 구독하면 여기에 모입니다.",
  goExplore: "탐색에서 첫 팀 고르기",
  until: (date: string) => `${date}까지 유지`,
  pending: "승인 대기",
  progress: "진척",
  price: "요금",
  subStatus: "상태",
  none: "없음",
  cancel: "해지",
  cancelNotice: "기간 말까지 유지 · 방 읽기 전용 동결",
  cancelConfirm: "해지 확정",
  cancelDone: (name: string) => `${name} 구독을 해지했습니다`,
  resume: "재개",
  resumeDone: (name: string) => `${name} 구독을 재개했습니다`,
};
const statusTint: Record<Sub["status"], string> = {
  active: colors.okBg,
  cancelled: colors.warnBg,
  ended: colors.sunk,
};
const MINE = "/api/subscriptions/mine";

// useWide · useAction 의 정의는 ../ui 에 있다(auth.tsx ↔ 이 파일의 순환 import 를 끊으려고 옮겼다) — 기존 화면들이 여기서 가져다 쓰므로 그대로 내보낸다
export { useAction, useWide };

/** 로딩·오류·재시도를 한 곳에서. settings.tsx 도 이걸 가져다 쓴다 (사본 금지). */
export function useLoad<T>(load: () => Promise<T>, key = "") {
  const ref = useRef(load);
  ref.current = load;
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    ref.current().then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) =>
        live && setState((prev) => ({ ...prev, loading: false, error: error.message })),
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return {
    ...state,
    retry: () => setAttempt((n) => n + 1),
    setData: (data: T) => setState({ data, loading: false }),
  };
}

/** 로딩(스켈레톤)·오류+재시도·빈 상태(다음 행동 버튼) 공통 래퍼. */
export function LoadState({
  loading,
  error,
  retry,
  empty,
  children,
}: {
  loading: boolean;
  error?: string;
  retry: () => void;
  /** action = 빈 상태의 «다음 행동» 버튼 */
  empty?: { title: string; detail: string; action?: ReactNode } | false;
  children: ReactNode;
}) {
  if (loading) return <Skeleton rows={3} height={132} />;
  if (error)
    return (
      <View style={{ gap: 10 }}>
        <ErrorNotice error={error} />
        <Button small onPress={retry}>
          {text.retry}
        </Button>
      </View>
    );
  if (empty)
    return (
      <Empty icon={Store} title={empty.title} detail={empty.detail}>
        {empty.action}
      </Empty>
    );
  return <>{children}</>;
}

/** 선택 가능한 칩 (ui.Chip 은 표시 전용이라 Pressable 로 감싼다). */
export function Choice({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  /** disabled 면 없어도 된다 — 고를 수 없는 선택지는 흐리게 표시만 한다 */
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={disabled ? { opacity: 0.5 } : null}
    >
      <Chip tint={selected ? colors.accentSoft : undefined}>{label}</Chip>
    </Pressable>
  );
}

/** 상세·시트 안의 소제목 블록. */
export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );
}

export const won = (n: number) => (n === 0 ? text.free : text.perMonth(n));

/** 숫자·퍼센트·개수는 모노로 (자리 흔들림 방지). Text 안에 끼워 쓴다. */
function Num({ children }: { children: ReactNode }) {
  return <Text style={{ fontFamily: fonts.mono }}>{children}</Text>;
}
const percent = (value: number) => `${Math.round(value)}%`;

/** 좁으면 시트, 넓으면 목록 오른쪽 패널. */
function Panel({
  wide,
  title,
  subtitle,
  onClose,
  children,
}: {
  wide: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!wide)
    return (
      <Sheet title={title} subtitle={subtitle} onClose={onClose}>
        {children}
      </Sheet>
    );
  return (
    <ScrollView
      style={sidePanel}
      contentContainerStyle={{ padding: 20, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[s.between, { gap: 12, alignItems: "flex-start" }]}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.title}>{title}</Text>
          {!!subtitle && <Text style={s.muted}>{subtitle}</Text>}
        </View>
        <Button small onPress={onClose}>
          {text.close}
        </Button>
      </View>
      {children}
    </ScrollView>
  );
}
const sidePanel = {
  width: 420,
  flexGrow: 0,
  borderLeftWidth: 1,
  borderLeftColor: colors.line,
  backgroundColor: colors.card,
} as const;
function PanelHint({ children }: { children: string }) {
  return (
    <View style={[sidePanel, { padding: 24, justifyContent: "center" }]}>
      <Text style={[s.muted, { textAlign: "center" }]}>{children}</Text>
    </View>
  );
}

export function StoreScreen({
  tab,
  onTab,
  onOpenRoom,
}: {
  tab: StoreTab;
  onTab: (t: StoreTab) => void;
  onOpenRoom: (roomId: string) => void;
}) {
  const { api } = useWorkspace();
  // 내 구독은 두 탭이 같이 본다: 탭 제목의 개수 · 탐색의 «해지했던 팀» 판정 · 내 구독 목록
  const subs = useLoad(() => api.request<Sub[]>(MINE));
  const refreshSubs = async () => subs.setData(await api.request<Sub[]>(MINE));
  const count = subs.data?.filter((sub) => sub.status !== "ended").length;

  return (
    <View style={{ flex: 1 }}>
      <View
        accessibilityRole="tablist"
        style={[s.row, { gap: 8, paddingHorizontal: 16, paddingTop: 12 }]}
      >
        {(Object.keys(text.tabs) as StoreTab[]).map((t) => {
          const selected = tab === t;
          return (
            <Pressable
              key={t}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onTab(t)}
              style={[
                s.button,
                selected ? s.primary : s.secondary,
                { minHeight: 38, paddingVertical: 7, paddingHorizontal: 13 },
              ]}
            >
              <Text style={[s.buttonText, { color: selected ? colors.onAccent : colors.text }]}>
                {text.tabs[t]}
                {t === "mine" && count !== undefined && (
                  <>
                    {" · "}
                    <Num>{count}</Num>
                  </>
                )}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {tab === "explore" ? (
        <Explore subs={subs} refreshSubs={refreshSubs} onOpenRoom={onOpenRoom} />
      ) : (
        <Mine
          subs={subs}
          refreshSubs={refreshSubs}
          onOpenRoom={onOpenRoom}
          onExplore={() => onTab("explore")}
        />
      )}
    </View>
  );
}

type SubsLoad = ReturnType<typeof useLoad<Sub[]>>;

/** 공개 지표: 발행→인용 전환율. null = 아직 측정 전 → «측정 중» 칩. */
function Conversion({ rate }: { rate: number | null }) {
  return (
    <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
      <Text style={s.small}>{text.conversion}</Text>
      {rate === null ? (
        <Chip>{text.measuring}</Chip>
      ) : (
        <Text style={[s.text, { fontFamily: fonts.mono, fontWeight: "600" }]}>{percent(rate)}</Text>
      )}
    </View>
  );
}

/** 팀 이름 줄: 대표 캐릭터 + 이름 + 검증 배지(미검증이면 아무것도 없음) + «에이전트 N명 · 월 구독». */
function TeamHead({ pkg, size }: { pkg: Pkg; size: number }) {
  return (
    <View style={[s.row, { gap: 12 }]}>
      <CharacterAvatar character={pkg.character} size={size} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
          <Text style={s.heading}>{pkg.name}</Text>
          {pkg.thirdParty && <Text style={s.small}>({THIRD_PARTY_LABEL})</Text>}
          {pkg.verified && <Chip tint={colors.okBg}>{text.verified}</Chip>}
          {pkg.reviewing && <Chip tint={colors.warnBg}>{text.reviewing}</Chip>}
        </View>
        <Text style={s.small}>
          {STORE_CATEGORY_LABELS[pkg.category]} · {text.agents} <Num>{pkg.roleCount}</Num>
          {text.people} · {text.unit}
        </Text>
      </View>
    </View>
  );
}

function matches(pkg: Pkg, q: string, category: StoreCategory | "") {
  if (category && pkg.category !== category) return false;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [
    pkg.name,
    pkg.summary,
    STORE_CATEGORY_LABELS[pkg.category],
    ...pkg.roles.flatMap((role) => [role.title, role.summary]),
  ].some((field) => field.toLowerCase().includes(needle));
}

function Explore({
  subs,
  refreshSubs,
  onOpenRoom,
}: {
  subs: SubsLoad;
  refreshSubs: () => Promise<void>;
  onOpenRoom: (roomId: string) => void;
}) {
  const { api } = useWorkspace();
  const wide = useWide();
  const [q, setQ] = useState("");
  const [serverQ, setServerQ] = useState("");
  const [category, setCategory] = useState<StoreCategory | "">("");
  // 입력은 화면에서 즉시 거르고(matches), 서버 검색은 잠깐 멈췄을 때 병행한다
  useEffect(() => {
    const timer = setTimeout(() => setServerQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const path = `/api/store/packages?${new URLSearchParams({ q: serverQ, category })}`;
  const list = useLoad(() => api.request<Pkg[]>(path), path);
  const [open, setOpen] = useState<{ id: string; confirm: boolean }>();

  const shown = list.data?.filter((pkg) => matches(pkg, q, category));
  const detail = open && list.data?.find((pkg) => pkg.id === open.id);
  const showAll = () => {
    setQ("");
    setCategory("");
  };
  const afterSubscribe = async () => {
    list.setData(await api.request<Pkg[]>(path));
    await refreshSubs();
  };

  return (
    <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        <Field label={text.search} placeholder={text.searchHint} value={q} onChangeText={setQ} />
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Choice
            label={STORE_CATEGORY_ALL_LABEL}
            selected={category === ""}
            onPress={() => setCategory("")}
          />
          {STORE_CATEGORIES.map((c) => (
            <Choice
              key={c}
              label={STORE_CATEGORY_LABELS[c]}
              selected={category === c}
              onPress={() => setCategory(c)}
            />
          ))}
        </View>
        {/* 이미 받은 목록이 있으면 다시 읽는 동안에도 보여 준다 — 스켈레톤은 처음 읽을 때만 */}
        <LoadState
          loading={list.loading && !list.data}
          error={list.error}
          retry={list.retry}
          empty={false}
        >
          {shown?.length === 0 ? (
            q.trim() || category ? (
              <Empty icon={Search} title={text.emptyExplore} detail={text.emptyExploreHint}>
                <Button onPress={showAll}>{text.showAll}</Button>
              </Empty>
            ) : (
              // 검색어·카테고리 없이 비었으면 스토어가 통째로 빈 것이다 — 돌아갈 «전체 목록» 이 없으니 버튼을 그리지 않는다
              <Empty icon={Store} title={text.emptyStore} detail={text.emptyStoreHint} />
            )
          ) : (
            shown?.map((pkg) => (
              <Pressable
                key={pkg.id}
                accessibilityRole="button"
                accessibilityLabel={pkg.name}
                accessibilityState={{ disabled: pkg.reviewing, selected: open?.id === pkg.id }}
                disabled={pkg.reviewing}
                onPress={() => setOpen({ id: pkg.id, confirm: false })}
              >
                <Card
                  style={{
                    gap: 10,
                    opacity: pkg.reviewing ? 0.55 : 1,
                    ...(open?.id === pkg.id ? { borderColor: colors.accent } : null),
                  }}
                >
                  <TeamHead pkg={pkg} size={42} />
                  <Text style={s.text}>{pkg.summary}</Text>
                  <Conversion rate={pkg.conversionRate} />
                  {pkg.reviewing ? (
                    <Chip tint={colors.warnBg}>{text.reviewing}</Chip>
                  ) : pkg.subscribed && pkg.roomId ? (
                    <Button small onPress={() => onOpenRoom(pkg.roomId as string)}>
                      {`${SUBSCRIPTION_STATUS_LABELS.active} · ${text.openRoom}`}
                    </Button>
                  ) : (
                    <Button
                      small
                      primary
                      onPress={() => setOpen({ id: pkg.id, confirm: !pkg.subscribed })}
                    >
                      {text.subscribe}
                    </Button>
                  )}
                </Card>
              </Pressable>
            ))
          )}
        </LoadState>
      </ScrollView>
      {detail ? (
        <Panel
          wide={wide}
          title={detail.name}
          subtitle={detail.summary}
          onClose={() => setOpen(undefined)}
        >
          <PackageDetail
            key={`${detail.id}:${open.confirm}`}
            pkg={detail}
            startConfirm={open.confirm}
            subs={subs}
            onSubscribed={afterSubscribe}
            onOpenRoom={onOpenRoom}
          />
        </Panel>
      ) : wide ? (
        <PanelHint>{text.pickTeam}</PanelHint>
      ) : null}
    </View>
  );
}

function PackageDetail({
  pkg,
  startConfirm,
  subs,
  onSubscribed,
  onOpenRoom,
}: {
  pkg: Pkg;
  startConfirm: boolean;
  subs: SubsLoad;
  onSubscribed: () => Promise<void>;
  onOpenRoom: (roomId: string) => void;
}) {
  const { api, notify } = useWorkspace();
  const [confirming, setConfirming] = useState(startConfirm);
  const [restore, setRestore] = useState<boolean>();
  const [createdRoom, setCreatedRoom] = useState<string>();
  const [onboarding, setOnboarding] = useState(false);
  const [onboarded, setOnboarded] = useState(false);
  const act = useAction();
  const refresh = useAction();
  // 등급이 모자라 거절된 구독(403 · kind "tier") — 오류가 아니라 안내로 따로 보인다
  const [tierNotice, setTierNotice] = useState("");
  // 해지했던 팀을 다시 구독하는가 — 그러면 기존 방·기억을 복원할지 새로 시작할지 묻는다
  const prior = subs.data?.some((sub) => sub.packageId === pkg.id && sub.status !== "active");

  const subscribe = () =>
    act.run(async () => {
      let result: SubscribeResult;
      setTierNotice("");
      try {
        result = await api.request<SubscribeResult>("/api/subscriptions", {
          packageId: pkg.id,
          ...(prior ? { restore } : null),
        });
      } catch (e) {
        setConfirming(false); // 실패하면 확인 전 단계로 되돌리고, 서버가 준 사유를 보인다
        const kind: SubscribeErrorKind = "tier";
        if (
          e instanceof ApiError &&
          e.status === 403 &&
          (e.body as { kind?: unknown } | undefined)?.kind === kind
        ) {
          setTierNotice(e.message);
          return;
        }
        throw e;
      }
      setCreatedRoom(result.roomId);
      // 복원한 방에는 이전 목표가 그대로 있다 — 새로 만든 방일 때만 팀별 온보딩(프로필·첫 목표)을 거친다
      setOnboarding(!(prior && restore));
      notify(text.subscribed(pkg.name));
      void refresh.run(onSubscribed);
    });
  const roomId = createdRoom ?? (pkg.subscribed ? pkg.roomId : null);

  return (
    <View style={{ gap: 16 }}>
      <TeamHead pkg={pkg} size={56} />
      <Block title={text.roles}>
        {pkg.roles.map((role) => (
          <View
            key={role.name}
            style={{
              flexDirection: "row",
              gap: 12,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: colors.line,
            }}
          >
            <Text style={[s.text, { width: 96, fontWeight: "600" }]}>{role.title}</Text>
            <Text style={[s.muted, { flex: 1 }]}>{role.summary}</Text>
          </View>
        ))}
      </Block>
      <Block title={text.approvals}>
        <Text style={s.small}>{text.approvalsHint}</Text>
        {pkg.approvalPoints.map((point) => (
          <Text key={point} style={s.text}>
            · {point}
          </Text>
        ))}
      </Block>
      <Block title={text.cadence}>
        <Text style={s.text}>{pkg.reportCadence}</Text>
      </Block>
      <Block title={text.dataHandling}>
        <Text style={s.text}>{pkg.dataHandling}</Text>
      </Block>
      <Block title={text.metrics}>
        <Conversion rate={pkg.conversionRate} />
      </Block>
      {!!pkg.operatorNotice && (
        <Block title={text.notice}>
          <Text style={s.text}>{pkg.operatorNotice}</Text>
        </Block>
      )}
      <Block title={text.disclosure}>
        <Text style={s.small}>{text.disclosed}</Text>
        <Text style={s.small}>{text.undisclosed}</Text>
      </Block>
      <ErrorNotice error={act.error || refresh.error} />
      {tierNotice ? (
        <Card
          style={{
            gap: 8,
            padding: 14,
            borderColor: colors.warn,
            backgroundColor: colors.warnBg,
            alignItems: "flex-start",
          }}
        >
          <Chip tint={colors.card}>{text.tierNotice}</Chip>
          <Text style={s.text}>{tierNotice}</Text>
        </Card>
      ) : null}
      {roomId ? (
        <View style={{ gap: 8 }}>
          {createdRoom ? (
            <Text style={s.text}>
              {text.subscribed(pkg.name)}. {text.subscribedBody}
            </Text>
          ) : null}
          {createdRoom && onboarding ? (
            <TeamOnboarding
              roomId={createdRoom}
              onDone={() => {
                setOnboarding(false);
                setOnboarded(true);
              }}
            />
          ) : (
            <>
              {onboarded ? <Text style={s.small}>{text.onboardDone}</Text> : null}
              <Button primary onPress={() => onOpenRoom(roomId)}>
                {text.openRoom}
              </Button>
            </>
          )}
        </View>
      ) : pkg.subscribed ? (
        <View style={{ gap: 8 }}>
          <ErrorNotice error={text.noRoom} />
          <Button busy={refresh.busy} onPress={() => void refresh.run(onSubscribed)}>
            {text.retry}
          </Button>
        </View>
      ) : pkg.reviewing ? (
        <Chip tint={colors.warnBg}>{text.reviewing}</Chip>
      ) : !confirming ? (
        <Button primary onPress={() => setConfirming(true)}>
          {text.subscribe}
        </Button>
      ) : subs.data === undefined ? (
        // 내 구독을 못 읽으면 «해지했던 팀인지»를 모른다 — 모르는 채로 구독을 보내지 않는다
        <LoadState loading={subs.loading} error={subs.error} retry={subs.retry}>
          {null}
        </LoadState>
      ) : (
        <Card style={{ gap: 12, borderColor: colors.accent }}>
          <Text style={s.heading}>{text.confirmTitle}</Text>
          <Text style={s.text}>{text.confirmBody(pkg.name)}</Text>
          {prior ? (
            <Block title={text.priorTitle}>
              <Text style={s.small}>{text.priorBody}</Text>
              <View style={[s.row, { gap: 8 }]}>
                <Choice
                  label={text.restore}
                  selected={restore === true}
                  onPress={() => setRestore(true)}
                />
                <Choice
                  label={text.fresh}
                  selected={restore === false}
                  onPress={() => setRestore(false)}
                />
              </View>
            </Block>
          ) : null}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              busy={act.busy}
              disabled={prior && restore === undefined}
              onPress={() => void subscribe()}
            >
              {text.confirm}
            </Button>
            <Button disabled={act.busy} onPress={() => setConfirming(false)}>
              {text.back}
            </Button>
          </View>
        </Card>
      )}
    </View>
  );
}

/** 구독 확정 뒤의 팀별 온보딩: 프로필 확인(비어 있을 때만) → 그 팀 방의 첫 목표 한 줄. 단계 조각은 화면 1(auth.tsx)의 것을 그대로 쓴다. */
function TeamOnboarding({ roomId, onDone }: { roomId: string; onDone: () => void }) {
  const { api } = useWorkspace();
  const me = useLoad(() => api.request<MeResponse>("/api/me"));
  const [profileSaved, setProfileSaved] = useState(false);
  return (
    <Card style={{ gap: 12, borderColor: colors.accent }}>
      <Text style={s.heading}>{text.onboardTitle}</Text>
      <Text style={s.small}>{text.onboardBody}</Text>
      <LoadState loading={me.loading} error={me.error} retry={me.retry}>
        {me.data &&
          (profileSaved || profileComplete(me.data.profile) ? (
            <Block title={ONBOARDING_TITLES.goal}>
              <GoalStep api={api} roomId={() => roomId} onSaved={onDone} />
            </Block>
          ) : (
            <Block title={ONBOARDING_TITLES.profile}>
              <ProfileStep
                api={api}
                profile={me.data.profile}
                onSaved={() => setProfileSaved(true)}
              />
            </Block>
          ))}
      </LoadState>
    </Card>
  );
}

function Mine({
  subs,
  refreshSubs,
  onOpenRoom,
  onExplore,
}: {
  subs: SubsLoad;
  refreshSubs: () => Promise<void>;
  onOpenRoom: (roomId: string) => void;
  onExplore: () => void;
}) {
  const wide = useWide();
  const [managingId, setManagingId] = useState<string>();
  const managing = subs.data?.find((sub) => sub.id === managingId);

  return (
    <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
        <LoadState
          loading={subs.loading && !subs.data}
          error={subs.error}
          retry={subs.retry}
          empty={
            subs.data?.length === 0 && {
              title: text.emptyMine,
              detail: text.emptyMineHint,
              action: (
                <Button primary onPress={onExplore}>
                  {text.goExplore}
                </Button>
              ),
            }
          }
        >
          {subs.data?.map((sub) => (
            <Card
              key={sub.id}
              style={{
                gap: 10,
                ...(managingId === sub.id ? { borderColor: colors.accent } : null),
              }}
            >
              <View style={[s.row, { gap: 12 }]}>
                <CharacterAvatar character={sub.character} size={42} />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                    <Text style={s.heading}>{sub.packageName}</Text>
                    <Chip tint={statusTint[sub.status]}>
                      {SUBSCRIPTION_STATUS_LABELS[sub.status]}
                    </Chip>
                  </View>
                  <SubTerm sub={sub} />
                  <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                    <Text style={s.small}>{text.pending}</Text>
                    {sub.pendingApprovals > 0 ? (
                      <Badge count={sub.pendingApprovals} />
                    ) : (
                      <Text style={s.small}>{text.none}</Text>
                    )}
                    <Text style={s.small}>· {text.progress}</Text>
                    {typeof sub.progress === "number" ? (
                      <Text style={[s.small, { fontFamily: fonts.mono, color: colors.text }]}>
                        {percent(sub.progress)}
                      </Text>
                    ) : (
                      <Chip>{text.measuring}</Chip>
                    )}
                  </View>
                </View>
              </View>
              <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                <Button small primary onPress={() => onOpenRoom(sub.roomId)}>
                  {text.openRoom}
                </Button>
                <Button small onPress={() => setManagingId(sub.id)}>
                  {text.manage}
                </Button>
              </View>
            </Card>
          ))}
        </LoadState>
      </ScrollView>
      {managing ? (
        <Panel
          wide={wide}
          title={text.manage}
          subtitle={managing.packageName}
          onClose={() => setManagingId(undefined)}
        >
          <Manage key={managing.id} sub={managing} refreshSubs={refreshSubs} />
        </Panel>
      ) : wide ? (
        <PanelHint>{text.pickSub}</PanelHint>
      ) : null}
    </View>
  );
}

/** 구독 기간 한 줄: 해지 예정일 때만 기간 말을 보인다. 결제는 앱에 없다(마스터 2026-10-10) — 구독 중·종료는 상태 칩이 말한다. */
function SubTerm({ sub }: { sub: Sub }) {
  if (sub.status !== "cancelled" || !sub.endsAt) return null;
  return (
    <Text style={[s.small, { fontFamily: fonts.mono }]}>{text.until(dateLabel(sub.endsAt))}</Text>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={[s.between, { gap: 12 }]}>
      <Text style={s.muted}>{label}</Text>
      {children}
    </View>
  );
}

function Manage({ sub, refreshSubs }: { sub: Sub; refreshSubs: () => Promise<void> }) {
  const { api, notify } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const act = useAction();
  const change = (action: "cancel" | "resume", done: string) =>
    act.run(async () => {
      await api.request(`/api/subscriptions/${sub.id}/${action}`, {});
      notify(done);
      setConfirming(false);
      await refreshSubs();
    });

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 10 }}>
        <Row label={text.price}>
          <Text style={[s.text, { fontFamily: fonts.mono }]}>{won(sub.priceMonthly)}</Text>
        </Row>
        <Row label={text.subStatus}>
          <Chip tint={statusTint[sub.status]}>{SUBSCRIPTION_STATUS_LABELS[sub.status]}</Chip>
        </Row>
      </View>
      <SubTerm sub={sub} />
      <ErrorNotice error={act.error} />
      {sub.status === "cancelled" ? (
        <Button
          primary
          busy={act.busy}
          onPress={() => void change("resume", text.resumeDone(sub.packageName))}
        >
          {text.resume}
        </Button>
      ) : sub.status === "ended" ? null : confirming ? (
        <>
          <Text style={s.text}>{text.cancelNotice}</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              danger
              busy={act.busy}
              onPress={() => void change("cancel", text.cancelDone(sub.packageName))}
            >
              {text.cancelConfirm}
            </Button>
            <Button disabled={act.busy} onPress={() => setConfirming(false)}>
              {text.back}
            </Button>
          </View>
        </>
      ) : (
        <Button danger onPress={() => setConfirming(true)}>
          {text.cancel}
        </Button>
      )}
    </View>
  );
}
