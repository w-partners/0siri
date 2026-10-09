// 0Siri 설정 (0SIRI-SPEC §4.7, §4.8, §4.11 · S7/S8/S11): 한 화면 스크롤, 섹션마다 독립 로드·오류·재시도.
import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  dateLabel,
  ErrorNotice,
  Field,
  SectionHeading,
  Sheet,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { Block, Choice, LoadState, useAction, useLoad, won } from "./store";

const text = {
  save: "저장",
  saved: "저장했습니다",
  add: "추가",
  remove: "삭제",
  profile: "프로필",
  phone: "전화번호",
  displayName: "표시 이름",
  credential: "소개 한 줄",
  credentialHint: "예: ○○법률사무소 변호사",
  routing: "가성비 라우팅",
  autoEconomy: "가성비 자동 (난이도에 맞는 등급으로 자동 배정)",
  deviceLlm: "기기 내 경량 모델 사용 (티어 1)",
  fixedTier: "난이도 고정",
  auto: "자동",
  tier: (n: number) => ({ 0: "스크립트", 1: "기기", 3: "주력" })[n] ?? `티어 ${n}`,
  monthlyCap: "월 상한 (원, 비우면 없음)",
  capInvalid: "월 상한은 0 이상의 숫자여야 합니다",
  usage: "사용량·절감액",
  month: (m: string) => `${m} 기준`,
  calls: "호출",
  tokens: "토큰 (입력/출력)",
  cost: "지출",
  saving: "절감액",
  measuring: "측정 중",
  scriptSaved: "스크립트 대체",
  byokCalls: "내 계정(BYOK) 호출",
  times: (n: number) => `${n}회`,
  krw: (n: number) => `${n.toLocaleString("ko-KR")}원`,
  byTier: "등급별",
  byok: "모델 계정 (BYOK)",
  byokHint:
    "키는 암호화해 저장하고 끝 4자리만 표시합니다. 이 계정으로 나가는 호출은 내 요금에 들어가지 않습니다.",
  providers: { openai: "OpenAI", anthropic: "Anthropic", google: "Google" },
  apiKey: "API 키",
  connect: "연결",
  connected: "연결했습니다",
  disconnect: "해제",
  oauth: "구독 계정으로 연결 (OAuth)",
  noAccounts: "연결된 모델 계정이 없습니다",
  noAccountsHint: "제공자를 고르고 API 키를 넣으면 검증 후 연결됩니다.",
  mcp: "연결 (MCP)",
  mcpHint: "헤더 값은 저장 후 다시 보이지 않습니다. 이름만 표시합니다.",
  name: "이름",
  url: "URL",
  riskDefault: "기본 위험도",
  risks: { read: "읽기", write: "쓰기", external: "외부 발행" },
  headerName: "헤더 이름",
  headerValue: "헤더 값",
  addHeader: "헤더 추가",
  headers: "헤더",
  tools: "도구 보기",
  toolsOf: (name: string) => `${name} 도구`,
  undeclared: "(기본값)",
  noTools: "도구가 없습니다",
  noToolsHint: "서버가 도구를 하나도 내놓지 않았습니다.",
  noServers: "연결된 MCP 서버가 없습니다",
  noServersHint: "아래에서 서버를 추가하세요.",
  memories: "기억",
  memoryScope: "이 기억은 이 사용자에게만 적용됩니다.",
  memorySearch: "기억 검색",
  searching: "임베딩 검색 중…",
  searchEmpty: "검색 결과가 없습니다",
  searchCount: (n: number) => `검색 결과 ${n}건`,
  score: (n: number) => `유사도 ${Math.round(n * 100)}%`,
  newMemory: "새 기억",
  noMemories: "저장된 기억이 없습니다",
  noMemoriesHint: "대화 중 쌓이거나 아래에서 직접 추가할 수 있습니다.",
  admin: "관리자",
  invite: "초대 만들기",
  inviteUrl: "초대 링크",
  inviteToken: "초대 토큰 (한 번만 표시됩니다)",
  expires: "만료",
  role: "역할",
  roles: { user: "사용자", operator: "운영자", admin: "관리자" },
  phoneOptional: "전화번호 (선택)",
  invites: "초대 목록",
  used: "사용됨",
  unused: "미사용",
  noInvites: "초대가 없습니다",
  noInvitesHint: "위에서 초대를 만들면 여기에 보입니다.",
  users: "사용자 목록",
  noUsers: "사용자가 없습니다",
  noUsersHint: "초대를 수락한 사용자가 여기에 보입니다.",
  prices: "패키지 가격",
  slug: "패키지 슬러그",
  price: "월 가격 (원, 0 = 무료)",
  priceInvalid: "가격은 0 이상의 숫자여야 합니다",
  noPrices: "설정된 가격이 없습니다 (전부 파일럿 무료)",
  logout: "로그아웃",
  logoutFailed: (m: string) => `서버 로그아웃 실패: ${m}`,
};

type RoleKey = keyof typeof text.roles; // 서버 accounts.ts Role 과 같은 값
type ProviderKey = keyof typeof text.providers; // 서버 routing.ts Provider 와 같은 값 — 목록 API 가 없어 여기 적는다
type RiskKind = keyof typeof text.risks;
interface MeInfo {
  user: { id: string; phone: string; role: RoleKey; tier: string; createdAt: string };
  profile: { displayName: string; credentialText?: string };
}
interface RoutingPrefs {
  autoEconomy: boolean;
  fixedTier?: 2 | 3 | 4;
  monthlyCapKrw?: number;
  deviceLlmEnabled: boolean;
}
interface MonthUsage {
  month: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costKrw: number;
  savedKrw: number | null;
  savingsStatus: "measured" | "measuring";
  scriptSavedCalls: number;
  byokCalls: number;
  byTier: { tier: number; calls: number; tokens: number }[];
}
interface ByokAccount {
  id: ProviderKey;
  last4: string;
  validatedAt: string;
}
interface McpItem {
  id: string;
  name: string;
  url: string;
  riskDefault: RiskKind;
  headerNames: string[];
}
interface ToolItem {
  name: string;
  description: string;
  risk: RiskKind;
  declared: boolean;
}
interface MemoryItem {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  score?: number;
}
interface InviteItem {
  id: string;
  phone?: string;
  role: RoleKey;
  expiresAt: number;
  usedBy?: string;
}
interface UserItem {
  id: string;
  phone: string;
  role: RoleKey;
  tier: string;
}

const riskTint: Record<RiskKind, string> = {
  read: colors.green,
  write: colors.orange,
  external: colors.lavender,
};

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const { api, notify } = useWorkspace();
  const me = useLoad(() => api.request<MeInfo>("/api/me"));
  const logout = useAction();
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 28 }}
      keyboardShouldPersistTaps="handled"
    >
      <Section title={text.profile}>
        <LoadState loading={me.loading} error={me.error} retry={me.retry}>
          {me.data && <Profile me={me.data} onSaved={me.setData} />}
        </LoadState>
      </Section>
      <Section title={text.routing}>
        <Routing />
      </Section>
      <Section title={text.usage}>
        <Usage />
      </Section>
      <Section title={text.byok}>
        <Byok />
      </Section>
      <Section title={text.mcp}>
        <Mcp />
      </Section>
      <Section title={text.memories}>
        <Memories />
      </Section>
      {me.data?.user.role === "admin" && (
        <Section title={text.admin}>
          <Admin />
        </Section>
      )}
      <Section title={text.logout}>
        <Button
          danger
          busy={logout.busy}
          onPress={() =>
            logout.run(async () => {
              // 서버 로그아웃이 실패해도 화면은 나간다 — 토큰이 이미 죽은 경우 갇히지 않게. 실패는 알린다.
              try {
                await api.request("/api/auth/logout", {});
              } catch (e) {
                notify(text.logoutFailed((e as Error).message));
              }
              onLogout();
            })
          }
        >
          {text.logout}
        </Button>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View>
      <SectionHeading title={title} />
      <Card style={{ gap: 12 }}>{children}</Card>
    </View>
  );
}

function Profile({ me, onSaved }: { me: MeInfo; onSaved: (me: MeInfo) => void }) {
  const { api, notify } = useWorkspace();
  const [displayName, setDisplayName] = useState(me.profile.displayName);
  const [credentialText, setCredentialText] = useState(me.profile.credentialText ?? "");
  const act = useAction();
  return (
    <>
      <Text style={s.small}>
        {text.phone} · {me.user.phone} · {text.roles[me.user.role]}
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
            const profile = await api.request<MeInfo["profile"]>(
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
    </>
  );
}

function Routing() {
  const { api, notify } = useWorkspace();
  const prefs = useLoad(() => api.request<RoutingPrefs>("/api/settings/routing"));
  const [cap, setCap] = useState<string>();
  const act = useAction();
  const patch = (body: Partial<Record<keyof RoutingPrefs, boolean | number | null>>) =>
    act.run(async () => {
      prefs.setData(await api.request<RoutingPrefs>("/api/settings/routing", body, "PATCH"));
      notify(text.saved);
    });
  const saveCap = () => {
    if (cap === undefined) return;
    if (cap.trim() === "") return patch({ monthlyCapKrw: null });
    const n = Number(cap);
    if (!Number.isFinite(n) || n < 0)
      return act.run(async () => Promise.reject(new Error(text.capInvalid)));
    return patch({ monthlyCapKrw: n });
  };
  return (
    <LoadState loading={prefs.loading} error={prefs.error} retry={prefs.retry}>
      {prefs.data && (
        <>
          <CheckRow
            label={text.autoEconomy}
            checked={prefs.data.autoEconomy}
            onPress={() => patch({ autoEconomy: !prefs.data?.autoEconomy })}
          />
          <CheckRow
            label={text.deviceLlm}
            checked={prefs.data.deviceLlmEnabled}
            onPress={() => patch({ deviceLlmEnabled: !prefs.data?.deviceLlmEnabled })}
          />
          <Block title={text.fixedTier}>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Choice
                label={text.auto}
                selected={!prefs.data.fixedTier}
                onPress={() => patch({ fixedTier: null })}
              />
              {([2, 3, 4] as const).map((tier) => (
                <Choice
                  key={tier}
                  label={text.tier(tier)}
                  selected={prefs.data?.fixedTier === tier}
                  onPress={() => patch({ fixedTier: tier })}
                />
              ))}
            </View>
          </Block>
          <Field
            label={text.monthlyCap}
            keyboardType="numeric"
            defaultValue={
              prefs.data.monthlyCapKrw === undefined ? "" : String(prefs.data.monthlyCapKrw)
            }
            onChangeText={setCap}
          />
          <ErrorNotice error={act.error} />
          <Button small busy={act.busy} disabled={cap === undefined} onPress={saveCap}>
            {text.save}
          </Button>
        </>
      )}
    </LoadState>
  );
}

function Usage() {
  const { api } = useWorkspace();
  const usage = useLoad(() => api.request<MonthUsage>("/api/usage"));
  const u = usage.data;
  return (
    <LoadState loading={usage.loading} error={usage.error} retry={usage.retry}>
      {u && (
        <>
          <Text style={s.small}>{text.month(u.month)}</Text>
          <Row label={text.calls} value={text.times(u.calls)} />
          <Row
            label={text.tokens}
            value={`${u.tokensIn.toLocaleString("ko-KR")} / ${u.tokensOut.toLocaleString("ko-KR")}`}
          />
          <Row label={text.cost} value={text.krw(u.costKrw)} />
          <Row
            label={text.saving}
            value={
              u.savingsStatus === "measured" && u.savedKrw !== null
                ? text.krw(u.savedKrw)
                : text.measuring
            }
          />
          <Row label={text.scriptSaved} value={text.times(u.scriptSavedCalls)} />
          <Row label={text.byokCalls} value={text.times(u.byokCalls)} />
          <Block title={text.byTier}>
            {u.byTier.map((row) => (
              <Row
                key={row.tier}
                label={text.tier(row.tier)}
                value={`${text.times(row.calls)} · ${row.tokens.toLocaleString("ko-KR")}`}
              />
            ))}
          </Block>
        </>
      )}
    </LoadState>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.between}>
      <Text style={s.small}>{label}</Text>
      <Text style={s.text}>{value}</Text>
    </View>
  );
}

function Byok() {
  const { api, notify } = useWorkspace();
  const list = useLoad(() => api.request<ByokAccount[]>("/api/connections/model-account"));
  const [provider, setProvider] = useState<ProviderKey>("openai");
  const [apiKey, setApiKey] = useState("");
  const act = useAction();
  const oauth = useAction();
  return (
    <>
      <Text style={s.small}>{text.byokHint}</Text>
      <LoadState
        loading={list.loading}
        error={list.error}
        retry={list.retry}
        empty={list.data?.length === 0 && { title: text.noAccounts, detail: text.noAccountsHint }}
      >
        {list.data?.map((a) => (
          <View key={a.id} style={s.between}>
            <Text style={s.text}>
              {text.providers[a.id] ?? a.id} · ····{a.last4} · {dateLabel(a.validatedAt)}
            </Text>
            <Button
              small
              danger
              onPress={() =>
                act.run(async () => {
                  await api.request(`/api/connections/model-account/${a.id}`, undefined, "DELETE");
                  list.retry();
                })
              }
            >
              {text.disconnect}
            </Button>
          </View>
        ))}
      </LoadState>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        {(Object.keys(text.providers) as ProviderKey[]).map((p) => (
          <Choice
            key={p}
            label={text.providers[p]}
            selected={provider === p}
            onPress={() => setProvider(p)}
          />
        ))}
      </View>
      <Field
        label={text.apiKey}
        secureTextEntry
        autoCapitalize="none"
        value={apiKey}
        onChangeText={setApiKey}
      />
      <ErrorNotice error={act.error} />
      <Button
        small
        primary
        busy={act.busy}
        disabled={apiKey.length < 8}
        onPress={() =>
          act.run(async () => {
            await api.request("/api/connections/model-account", { provider, apiKey });
            setApiKey(""); // 검증 뒤 키는 화면에 남기지 않는다
            list.retry();
            notify(text.connected);
          })
        }
      >
        {text.connect}
      </Button>
      <ErrorNotice error={oauth.error} />
      <Button
        small
        busy={oauth.busy}
        onPress={() => oauth.run(() => api.request("/api/connections/model-account/oauth", {}))}
      >
        {text.oauth}
      </Button>
    </>
  );
}

function Mcp() {
  const { api, notify } = useWorkspace();
  const list = useLoad(() => api.request<McpItem[]>("/api/connections/mcp"));
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [risk, setRisk] = useState<RiskKind>("external");
  const [headers, setHeaders] = useState<{ id: number; name: string; value: string }[]>([]);
  const nextId = useRef(0);
  const [toolsFor, setToolsFor] = useState<McpItem>();
  const tools = useLoad(
    () =>
      toolsFor
        ? api.request<ToolItem[]>(`/api/connections/mcp/${toolsFor.id}/tools`)
        : Promise.resolve([]),
    toolsFor?.id ?? "",
  );
  const act = useAction();
  const setHeader = (id: number, patch: Partial<{ name: string; value: string }>) =>
    setHeaders((rows) => rows.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  return (
    <>
      <LoadState
        loading={list.loading}
        error={list.error}
        retry={list.retry}
        empty={list.data?.length === 0 && { title: text.noServers, detail: text.noServersHint }}
      >
        {list.data?.map((server) => (
          <View key={server.id} style={{ gap: 6, paddingVertical: 6 }}>
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              <Text style={[s.text, { fontWeight: "600" }]}>{server.name}</Text>
              <Chip tint={riskTint[server.riskDefault]}>{text.risks[server.riskDefault]}</Chip>
            </View>
            <Text style={s.small}>{server.url}</Text>
            {server.headerNames.length > 0 && (
              <Text style={s.small}>
                {text.headers}: {server.headerNames.join(", ")}
              </Text>
            )}
            <View style={[s.row, { gap: 8 }]}>
              <Button small onPress={() => setToolsFor(server)}>
                {text.tools}
              </Button>
              <Button
                small
                danger
                onPress={() =>
                  act.run(async () => {
                    await api.request(`/api/connections/mcp/${server.id}`, undefined, "DELETE");
                    list.retry();
                  })
                }
              >
                {text.remove}
              </Button>
            </View>
          </View>
        ))}
      </LoadState>
      <Text style={s.small}>{text.mcpHint}</Text>
      <Field label={text.name} value={name} onChangeText={setName} />
      <Field label={text.url} autoCapitalize="none" value={url} onChangeText={setUrl} />
      {headers.map((h) => (
        <View key={h.id} style={[s.row, { gap: 8 }]}>
          <View style={{ flex: 1 }}>
            <Field
              label={text.headerName}
              autoCapitalize="none"
              value={h.name}
              onChangeText={(v) => setHeader(h.id, { name: v })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label={text.headerValue}
              secureTextEntry
              autoCapitalize="none"
              value={h.value}
              onChangeText={(v) => setHeader(h.id, { value: v })}
            />
          </View>
        </View>
      ))}
      <Block title={text.riskDefault}>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {(Object.keys(text.risks) as RiskKind[]).map((r) => (
            <Choice
              key={r}
              label={text.risks[r]}
              selected={risk === r}
              onPress={() => setRisk(r)}
            />
          ))}
        </View>
      </Block>
      <ErrorNotice error={act.error} />
      <View style={[s.row, { gap: 8 }]}>
        <Button
          small
          onPress={() =>
            setHeaders((rows) => [...rows, { id: nextId.current++, name: "", value: "" }])
          }
        >
          {text.addHeader}
        </Button>
        <Button
          small
          primary
          busy={act.busy}
          disabled={!name.trim() || !url.trim()}
          onPress={() =>
            act.run(async () => {
              const pairs = headers.filter((h) => h.name.trim());
              await api.request("/api/connections/mcp", {
                name: name.trim(),
                url: url.trim(),
                riskDefault: risk,
                ...(pairs.length
                  ? { headers: Object.fromEntries(pairs.map((h) => [h.name.trim(), h.value])) }
                  : {}),
              });
              setName("");
              setUrl("");
              setHeaders([]); // 헤더 값은 제출 뒤 화면에 남기지 않는다
              list.retry();
              notify(text.saved);
            })
          }
        >
          {text.add}
        </Button>
      </View>
      {toolsFor && (
        <Sheet
          title={text.toolsOf(toolsFor.name)}
          subtitle={toolsFor.url}
          onClose={() => setToolsFor(undefined)}
        >
          <LoadState
            loading={tools.loading}
            error={tools.error}
            retry={tools.retry}
            empty={tools.data?.length === 0 && { title: text.noTools, detail: text.noToolsHint }}
          >
            <View style={{ gap: 12 }}>
              {tools.data?.map((tool) => (
                <View key={tool.name} style={{ gap: 4 }}>
                  <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                    <Text style={[s.text, { fontWeight: "600" }]}>{tool.name}</Text>
                    <Chip tint={riskTint[tool.risk]}>
                      {text.risks[tool.risk]}
                      {!tool.declared && ` ${text.undeclared}`}
                    </Chip>
                  </View>
                  {!!tool.description && <Text style={s.small}>{tool.description}</Text>}
                </View>
              ))}
            </View>
          </LoadState>
        </Sheet>
      )}
    </>
  );
}

function Memories() {
  const { api, notify } = useWorkspace();
  const [q, setQ] = useState("");
  const list = useLoad(
    () => api.request<MemoryItem[]>(`/api/memories?${new URLSearchParams({ q, limit: "20" })}`),
    q,
  );
  const [draft, setDraft] = useState("");
  const act = useAction();
  const status = !q.trim()
    ? ""
    : list.loading
      ? text.searching
      : list.error
        ? ""
        : list.data?.length
          ? text.searchCount(list.data.length)
          : text.searchEmpty;
  return (
    <>
      <Text style={s.small}>{text.memoryScope}</Text>
      <Field label={text.memorySearch} value={q} onChangeText={setQ} />
      {!!status && <Text style={s.small}>{status}</Text>}
      <LoadState
        loading={list.loading}
        error={list.error}
        retry={list.retry}
        empty={
          !q.trim() &&
          list.data?.length === 0 && { title: text.noMemories, detail: text.noMemoriesHint }
        }
      >
        {list.data?.map((m) => (
          <View key={m.id} style={[s.row, { gap: 8, paddingVertical: 6 }]}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={s.text}>{m.text}</Text>
              <Text style={s.small}>
                {m.source} · {dateLabel(m.createdAt)}
                {m.score !== undefined && ` · ${text.score(m.score)}`}
              </Text>
            </View>
            <Button
              small
              danger
              onPress={() =>
                act.run(async () => {
                  await api.request(`/api/memories/${m.id}`, undefined, "DELETE");
                  list.retry();
                })
              }
            >
              {text.remove}
            </Button>
          </View>
        ))}
      </LoadState>
      <Field label={text.newMemory} multiline value={draft} onChangeText={setDraft} />
      <ErrorNotice error={act.error} />
      <Button
        small
        primary
        busy={act.busy}
        disabled={!draft.trim()}
        onPress={() =>
          act.run(async () => {
            await api.request("/api/memories", { text: draft.trim(), source: "user" });
            setDraft("");
            list.retry();
            notify(text.saved);
          })
        }
      >
        {text.add}
      </Button>
    </>
  );
}

function Admin() {
  const { api, notify } = useWorkspace();
  const invites = useLoad(() => api.request<InviteItem[]>("/api/admin/invites"));
  const users = useLoad(() => api.request<UserItem[]>("/api/admin/users"));
  const settings = useLoad(() =>
    api.request<{ settings: { id: string; value: unknown }[] }>("/api/admin/settings"),
  );
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<RoleKey>("user");
  const [issued, setIssued] = useState<{ token: string; url: string; expiresAt: number }>();
  const inviteAct = useAction();
  const [slug, setSlug] = useState("");
  const [price, setPrice] = useState("");
  const priceAct = useAction();
  const prices = (settings.data?.settings ?? []).filter((x) => x.id.startsWith("price:"));
  return (
    <>
      <Block title={text.invite}>
        <Field
          label={text.phoneOptional}
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
        />
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {(Object.keys(text.roles) as RoleKey[]).map((r) => (
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
            <Text selectable style={s.text}>
              {issued.token}
            </Text>
            <Text style={s.small}>{text.inviteUrl}</Text>
            <Text selectable style={s.text}>
              {issued.url}
            </Text>
            <Text style={s.small}>
              {text.expires} {dateLabel(new Date(issued.expiresAt).toISOString())}
            </Text>
          </View>
        )}
      </Block>
      <Block title={text.invites}>
        <LoadState
          loading={invites.loading}
          error={invites.error}
          retry={invites.retry}
          empty={
            invites.data?.length === 0 && { title: text.noInvites, detail: text.noInvitesHint }
          }
        >
          {invites.data?.map((i) => (
            <Row
              key={i.id}
              label={`${i.phone ?? "—"} · ${text.roles[i.role]}`}
              value={`${i.usedBy ? text.used : text.unused} · ${text.expires} ${dateLabel(new Date(i.expiresAt).toISOString())}`}
            />
          ))}
        </LoadState>
      </Block>
      <Block title={text.users}>
        <LoadState
          loading={users.loading}
          error={users.error}
          retry={users.retry}
          empty={users.data?.length === 0 && { title: text.noUsers, detail: text.noUsersHint }}
        >
          {users.data?.map((u) => (
            <Row key={u.id} label={u.phone} value={`${text.roles[u.role]} · ${u.tier}`} />
          ))}
        </LoadState>
      </Block>
      <Block title={text.prices}>
        <LoadState loading={settings.loading} error={settings.error} retry={settings.retry}>
          {prices.length === 0 ? (
            <Text style={s.small}>{text.noPrices}</Text>
          ) : (
            prices.map((p) => (
              <Row key={p.id} label={p.id.slice("price:".length)} value={won(Number(p.value))} />
            ))
          )}
        </LoadState>
        <Field label={text.slug} autoCapitalize="none" value={slug} onChangeText={setSlug} />
        <Field label={text.price} keyboardType="numeric" value={price} onChangeText={setPrice} />
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
    </>
  );
}
