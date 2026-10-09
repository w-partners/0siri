// 0Siri 스토어 (0SIRI-SPEC §4.6, §6): 탐색 / 내 구독. 탭 URL 동기화는 코디네이터가 맡는다.
import { Store } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, colors, dateLabel, Empty, ErrorNotice, Field, Sheet, s } from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar } from "./eve";

const text = {
  explore: "탐색",
  mine: "내 구독",
  search: "검색",
  searchHint: "팀 이름·직군·역할",
  all: "전체",
  categories: { legal: "법률", medical: "의료", marketing: "마케팅", other: "기타" },
  sorts: { performance: "성과", price: "가격", newest: "최신" },
  members: (n: number) => `${n}명 구성`,
  verified: "검증",
  free: "무료",
  perMonth: (won: number) => `${won.toLocaleString("ko-KR")}원/월`,
  published: "발행",
  indexed: "색인",
  citations: "AI 인용",
  detail: "상세",
  roles: "역할 구성",
  approvals: "승인 지점",
  approvalsHint: "아래 행위는 사용자의 승인 없이는 실행되지 않습니다.",
  metrics: "성과 지표",
  notice: "운영자 공지",
  subscribe: "구독하기",
  subscribed: (name: string) => `${name} 구독을 시작했습니다`,
  openRoom: "방으로 이동",
  manage: "구독 관리",
  retry: "다시 시도",
  emptyExplore: "표시할 팀이 없습니다",
  emptyExploreHint: "검색어나 카테고리를 바꿔 보세요.",
  emptyMine: "구독 중인 팀이 없습니다",
  emptyMineHint: "탐색 탭에서 팀을 구독하면 여기에 모입니다.",
  nextBilling: "다음 결제",
  pending: (n: number) => `승인 대기 ${n}건`,
  progress: (n: number) => `진척 ${n}%`,
  active: "구독 중",
  cancelled: "해지됨",
  retainedUntil: "데이터 보존",
  plan: "요금제",
  planChange: "요금제 변경은 준비 중입니다.",
  cancel: "해지",
  // §6.2 해지 고지 — 방은 읽기 전용, 데이터 30일 보존
  cancelNotice:
    "해지하면 이 팀의 방은 읽기 전용으로 남고, 데이터는 30일 동안 보존된 뒤 삭제됩니다. 계속할까요?",
  cancelConfirm: "해지 확정",
  cancelDone: (name: string) => `${name} 구독을 해지했습니다`,
  back: "돌아가기",
};

type CategoryKey = keyof typeof text.categories; // 서버 store.ts Category 와 같은 값 — 라벨이 필요해 여기 둔다
type Sort = keyof typeof text.sorts;
interface Pkg {
  id: string;
  slug: string;
  name: string;
  character: string;
  category: CategoryKey;
  summary: string;
  roles: { name: string; title: string; summary: string }[];
  approvalPoints: string[];
  verified: boolean;
  metrics: { published: number; indexed: number; ai_citations: number };
  operatorNotice?: string;
  priceMonthly: number;
  roleCount: number;
}
interface Sub {
  id: string;
  packageId: string;
  roomId: string;
  status: "active" | "cancelled";
  priceMonthly: number;
  nextBillingAt: string;
  dataRetainedUntil?: string;
  packageName: string;
  character: string;
  pendingApprovals: number;
  progress: number | Record<string, never>; // 서버가 현황판 없으면 {} 로 준다
}

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

/** 버튼 한 번 = 요청 한 번: busy·오류를 한 곳에서. 오류는 서버의 한국어 메시지를 그대로 보인다. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** 로딩·오류+재시도·빈 상태 공통 래퍼. */
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
  empty?: { title: string; detail: string } | false;
  children: ReactNode;
}) {
  if (loading) return <ActivityIndicator color={colors.blueDark} style={{ padding: 24 }} />;
  if (error)
    return (
      <View style={{ gap: 10 }}>
        <ErrorNotice error={error} />
        <Button small onPress={retry}>
          {text.retry}
        </Button>
      </View>
    );
  if (empty) return <Empty icon={Store} title={empty.title} detail={empty.detail} />;
  return <>{children}</>;
}

/** 선택 가능한 칩 (ui.Chip 은 표시 전용이라 Pressable 로 감싼다). */
export function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}>
      <Chip tint={selected ? colors.blue : undefined}>{label}</Chip>
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
export function StoreScreen({
  tab,
  onTab,
  onOpenRoom,
}: {
  tab: "explore" | "mine";
  onTab: (t: "explore" | "mine") => void;
  onOpenRoom: (roomId: string) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.row, { gap: 8, paddingHorizontal: 16, paddingTop: 12 }]}>
        {(["explore", "mine"] as const).map((t) => (
          <Button key={t} small primary={tab === t} onPress={() => onTab(t)}>
            {text[t]}
          </Button>
        ))}
      </View>
      {tab === "explore" ? <Explore onOpenRoom={onOpenRoom} /> : <Mine onOpenRoom={onOpenRoom} />}
    </View>
  );
}

function Explore({ onOpenRoom }: { onOpenRoom: (roomId: string) => void }) {
  const { api, notify } = useWorkspace();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<CategoryKey | "">("");
  const [sort, setSort] = useState<Sort>("performance");
  const params = new URLSearchParams({ q, category, sort }).toString();
  const list = useLoad(() => api.request<Pkg[]>(`/api/store/packages?${params}`), params);
  const [detail, setDetail] = useState<Pkg>();
  const [roomId, setRoomId] = useState<string>();
  const act = useAction();

  const subscribe = (pkg: Pkg) =>
    act.run(async () => {
      const result = await api.request<{ roomId: string }>("/api/subscriptions", {
        packageId: pkg.id,
      });
      setRoomId(result.roomId);
      notify(text.subscribed(pkg.name));
    });
  const close = () => {
    setDetail(undefined);
    setRoomId(undefined);
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <Field label={text.search} placeholder={text.searchHint} value={q} onChangeText={setQ} />
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Choice label={text.all} selected={category === ""} onPress={() => setCategory("")} />
        {(Object.keys(text.categories) as CategoryKey[]).map((c) => (
          <Choice
            key={c}
            label={text.categories[c]}
            selected={category === c}
            onPress={() => setCategory(c)}
          />
        ))}
      </View>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {(Object.keys(text.sorts) as Sort[]).map((k) => (
          <Choice key={k} label={text.sorts[k]} selected={sort === k} onPress={() => setSort(k)} />
        ))}
      </View>
      <LoadState
        loading={list.loading}
        error={list.error}
        retry={list.retry}
        empty={
          list.data?.length === 0 && { title: text.emptyExplore, detail: text.emptyExploreHint }
        }
      >
        {list.data?.map((pkg) => (
          <Card key={pkg.id} style={{ gap: 10 }}>
            <View style={[s.row, { gap: 12 }]}>
              <CharacterAvatar character={pkg.character} size={42} />
              <View style={{ flex: 1, gap: 3 }}>
                <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                  <Text style={s.heading}>{pkg.name}</Text>
                  {pkg.verified && <Chip tint={colors.green}>{text.verified}</Chip>}
                </View>
                <Text style={s.small}>
                  {text.categories[pkg.category]} · {text.members(pkg.roleCount)} ·{" "}
                  {won(pkg.priceMonthly)}
                </Text>
              </View>
            </View>
            <Text style={s.text}>{pkg.summary}</Text>
            <Metrics metrics={pkg.metrics} />
            <Button small onPress={() => setDetail(pkg)}>
              {text.detail}
            </Button>
          </Card>
        ))}
      </LoadState>
      {detail && (
        <Sheet title={detail.name} subtitle={detail.summary} onClose={close}>
          <View style={{ gap: 16 }}>
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              <Chip>{text.categories[detail.category]}</Chip>
              {detail.verified && <Chip tint={colors.green}>{text.verified}</Chip>}
              <Chip tint={colors.orange}>{won(detail.priceMonthly)}</Chip>
            </View>
            <Block title={text.roles}>
              {detail.roles.map((r) => (
                <Text key={r.name} style={s.text}>
                  <Text style={{ fontWeight: "600" }}>{r.title}</Text> · {r.summary}
                </Text>
              ))}
            </Block>
            <Block title={text.approvals}>
              <Text style={s.small}>{text.approvalsHint}</Text>
              {detail.approvalPoints.map((p) => (
                <Text key={p} style={s.text}>
                  · {p}
                </Text>
              ))}
            </Block>
            <Block title={text.metrics}>
              <Metrics metrics={detail.metrics} />
            </Block>
            {!!detail.operatorNotice && (
              <Block title={text.notice}>
                <Text style={s.text}>{detail.operatorNotice}</Text>
              </Block>
            )}
            <ErrorNotice error={act.error} />
            {roomId ? (
              <Button primary onPress={() => onOpenRoom(roomId)}>
                {text.openRoom}
              </Button>
            ) : (
              <Button primary busy={act.busy} onPress={() => subscribe(detail)}>
                {text.subscribe}
              </Button>
            )}
          </View>
        </Sheet>
      )}
    </ScrollView>
  );
}

function Mine({ onOpenRoom }: { onOpenRoom: (roomId: string) => void }) {
  const { api, notify } = useWorkspace();
  const list = useLoad(() => api.request<Sub[]>("/api/subscriptions/mine"));
  const [managing, setManaging] = useState<Sub>();
  const [confirming, setConfirming] = useState(false);
  const act = useAction();

  const close = () => {
    setManaging(undefined);
    setConfirming(false);
  };
  const cancel = (sub: Sub) =>
    act.run(async () => {
      const updated = await api.request<Sub>(`/api/subscriptions/${sub.id}/cancel`, {});
      list.setData((list.data ?? []).map((x) => (x.id === sub.id ? { ...x, ...updated } : x)));
      notify(text.cancelDone(sub.packageName));
      close();
    });

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <LoadState
        loading={list.loading}
        error={list.error}
        retry={list.retry}
        empty={list.data?.length === 0 && { title: text.emptyMine, detail: text.emptyMineHint }}
      >
        {list.data?.map((sub) => (
          <Card key={sub.id} style={{ gap: 10 }}>
            <View style={[s.row, { gap: 12 }]}>
              <CharacterAvatar character={sub.character} size={42} />
              <View style={{ flex: 1, gap: 3 }}>
                <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                  <Text style={s.heading}>{sub.packageName}</Text>
                  <Chip tint={sub.status === "active" ? colors.green : colors.line}>
                    {sub.status === "active" ? text.active : text.cancelled}
                  </Chip>
                </View>
                <Text style={s.small}>
                  {won(sub.priceMonthly)}
                  {sub.status === "active" &&
                    ` · ${text.nextBilling} ${dateLabel(sub.nextBillingAt)}`}
                  {sub.status === "cancelled" &&
                    !!sub.dataRetainedUntil &&
                    ` · ${text.retainedUntil} ~${dateLabel(sub.dataRetainedUntil)}`}
                </Text>
                <Text style={s.small}>
                  {text.pending(sub.pendingApprovals)}
                  {typeof sub.progress === "number" && ` · ${text.progress(sub.progress)}`}
                </Text>
              </View>
            </View>
            <View style={[s.row, { gap: 8 }]}>
              <Button small primary onPress={() => onOpenRoom(sub.roomId)}>
                {text.openRoom}
              </Button>
              {sub.status === "active" && (
                <Button small onPress={() => setManaging(sub)}>
                  {text.manage}
                </Button>
              )}
            </View>
          </Card>
        ))}
      </LoadState>
      {managing && (
        <Sheet title={text.manage} subtitle={managing.packageName} onClose={close}>
          <View style={{ gap: 16 }}>
            <Block title={text.plan}>
              <Text style={s.text}>{won(managing.priceMonthly)}</Text>
              <Text style={s.small}>{text.planChange}</Text>
            </Block>
            <ErrorNotice error={act.error} />
            {confirming ? (
              <>
                <Text style={s.text}>{text.cancelNotice}</Text>
                <View style={[s.row, { gap: 8 }]}>
                  <Button danger busy={act.busy} onPress={() => cancel(managing)}>
                    {text.cancelConfirm}
                  </Button>
                  <Button onPress={() => setConfirming(false)}>{text.back}</Button>
                </View>
              </>
            ) : (
              <Button danger onPress={() => setConfirming(true)}>
                {text.cancel}
              </Button>
            )}
          </View>
        </Sheet>
      )}
    </ScrollView>
  );
}

function Metrics({ metrics }: { metrics: Pkg["metrics"] }) {
  return (
    <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
      <Chip>
        {text.published} {metrics.published}
      </Chip>
      <Chip>
        {text.indexed} {metrics.indexed}
      </Chip>
      <Chip>
        {text.citations} {metrics.ai_citations}
      </Chip>
    </View>
  );
}
