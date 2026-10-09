// 0Siri 화면 7 · 연결 (MCP 도구 + 모델 계정 BYOK). 계약: docs/0siri-api-contract.md «연결 (화면 7)».
// 캐릭터를 두지 않는다 — 도구·키 상태만 보인다. 키 원문은 제출 즉시 입력란에서 지우고 다시 그리지 않는다.
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import {
  COMING_SOON_LABEL,
  MCP_AUTH_LABELS,
  MCP_AUTH_TYPES,
  MCP_AUTH_UNSUPPORTED,
  MCP_RISKS,
  type McpAuthType,
  type McpRisk,
  MODEL_KEY_ERROR_KINDS,
  MODEL_KEY_ERROR_LABELS,
  MODEL_KEY_PROVIDER_LABELS,
  MODEL_KEY_PROVIDERS,
  type ModelKeyErrorKind,
} from "../../../../packages/domain/src/osiri";
import type { Mcp, McpTool } from "../../../server/src/osiri/mcp.ts";
import type { ModelKeyRow } from "../../../server/src/osiri/routing.ts";
import { ApiError } from "../api-response";
import {
  Button,
  Card,
  Chip,
  colors,
  ErrorNotice,
  Field,
  fonts,
  SectionHeading,
  Sheet,
  Skeleton,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { Choice, useAction, useLoad } from "./store";

/** `GET /connections/mcp` 항목 — 서버 `Mcp.overview()` 가 만든다. 도구 수를 못 세면 toolCount·risks 가 null 이고 toolsError 가 온다. */
type McpItem = Awaited<ReturnType<Mcp["overview"]>>[number];
/** `POST /connections/mcp/test` 의 응답 도구 — 서버 `Mcp.test()` */
type TestedTool = Awaited<ReturnType<Mcp["test"]>>[number];

// ---- 라벨은 도메인(packages/domain)이 정본 — 여기는 색만 정한다 ----
const riskTint: Record<McpRisk, string> = {
  read: colors.okBg,
  write: colors.warnBg,
  external: colors.missBg,
};
const text = {
  retry: "다시 시도",
  cancel: "취소",
  remove: "삭제",
  mcpTitle: "MCP 서버",
  mcpCount: (n: number) => `MCP 서버 ${n}개 연결됨`,
  noServers: "연결된 MCP 서버가 없습니다",
  noServersHint: "서버를 연결하면 팀이 그 도구를 씁니다.",
  addServer: "MCP 서버 추가",
  toolCount: (n: number) => `도구 ${n}개`,
  approvalRequired: "승인 필수",
  externalRule: "external 도구는 승인 연동이 강제이며 끌 수 없습니다.",
  ownerNote: "직접 붙인 MCP — 책임은 붙인 사용자에게 있습니다.",
  headerNote: "헤더 값은 저장 후 다시 보이지 않습니다. 이름만 표시합니다.",
  headers: "헤더",
  tools: "도구 보기",
  toolsOf: (name: string) => `${name} 도구`,
  undeclared: "(기본값)",
  noTools: "서버가 도구를 하나도 내놓지 않았습니다",
  removeServer: (name: string) => `${name} 연결을 끊으면 팀이 이 도구를 더 이상 쓰지 못합니다.`,
  name: "이름",
  url: "주소",
  urlHint: "https://…",
  auth: "인증 방식",
  headerName: "헤더 이름",
  headerValue: "헤더 값",
  test: "연결 테스트",
  testFirst: "연결 테스트를 통과해야 연결할 수 있습니다.",
  tested: (n: number) => `테스트 통과 · 도구 ${n}개 (아직 저장하지 않았습니다)`,
  connect: "연결",
  connected: "연결했습니다",
  keysTitle: "모델 계정 (내 API 키)",
  publicKey: "공용 열쇠로 동작 중 · 월 상한 적용",
  keyRule: "키 원문은 서버 금고에만 들어가고, 화면에는 끝 4자리만 보입니다.",
  masked: (last4: string) => `•••• ${last4}`,
  active: "활성",
  unregistered: "미등록",
  register: "등록",
  replace: "교체",
  replaceRule: "새 키가 검증을 통과한 뒤에만 이전 키를 폐기합니다.",
  apiKey: "API 키",
  baseUrl: "base URL",
  verify: "확인",
  verifying: "키 확인 중",
  keyFailed: "인증 실패 — 키를 확인하세요 (저장하지 않았습니다)",
  keySaved: "키를 등록했습니다",
  removeKey: "이 키를 지우면 즉시 폐기되고 공용 열쇠(월 상한 적용)로 돌아갑니다.",
  missingRow: (label: string) => `서버 응답에 ${label} 항목이 없습니다`,
  subscription: "ChatGPT·Claude 구독 계정 연결",
  subscriptionChip: "지원 예정/제한",
  subscriptionHint: "제공자가 공식 지원할 때만 엽니다. 기본 경로는 API 키입니다.",
};

// ---- 화면 7·8·11 이 같이 쓰는 조각 (설정·기억 화면이 여기서 가져간다 — 사본 금지) ----
export const mono = { fontFamily: fonts.mono };
/** 2단(웹) ↔ 1단(앱) — 폭이 좁으면 알아서 접힌다 */
export const columns = { flexDirection: "row", flexWrap: "wrap", gap: 20 } as const;
export const column = { flexGrow: 1, flexShrink: 1, flexBasis: 340, gap: 12 } as const;

/** 로딩 = 스켈레톤, 오류 = 사유 + 재시도. 데이터가 있을 때만 children 을 그린다. */
export function Loaded<T>({
  state,
  rows = 3,
  height = 44,
  children,
}: {
  state: { loading: boolean; error?: string; data?: T; retry: () => void };
  rows?: number;
  height?: number;
  children: (data: T) => ReactNode;
}) {
  if (state.loading) return <Skeleton rows={rows} height={height} />;
  if (state.error || state.data === undefined)
    return (
      <View style={{ gap: 10 }}>
        <ErrorNotice error={state.error} />
        <Button small onPress={state.retry}>
          {text.retry}
        </Button>
      </View>
    );
  return <>{children(state.data)}</>;
}

/** 인페이지 확인 — 되돌릴 수 없는 일은 그 자리에서 한 번 더 묻는다. 실패 사유도 여기 남는다. */
export function Confirm({
  message,
  action,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  message: string;
  action: string;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 10,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.warn,
        backgroundColor: colors.warnBg,
      }}
    >
      <Text style={s.text}>{message}</Text>
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8 }]}>
        <Button small danger busy={busy} onPress={onConfirm}>
          {action}
        </Button>
        <Button small disabled={busy} onPress={onCancel}>
          {text.cancel}
        </Button>
      </View>
    </View>
  );
}

function RiskBadge({ risk, suffix }: { risk: McpRisk; suffix?: string }) {
  // 기획: 위험도 배지는 read/write/external 그대로 적는다
  return (
    <Chip tint={riskTint[risk]}>
      {risk}
      {suffix}
    </Chip>
  );
}

export function ConnectionsScreen() {
  return (
    <View style={columns}>
      <View style={column}>
        <McpPanel />
      </View>
      <View style={column}>
        <ModelKeysPanel />
      </View>
    </View>
  );
}

// ---- MCP ----
function McpPanel() {
  const { api } = useWorkspace();
  const list = useLoad(() => api.request<McpItem[]>("/api/connections/mcp"));
  const [adding, setAdding] = useState(false);
  const [toolsFor, setToolsFor] = useState<McpItem>();
  return (
    <View>
      <SectionHeading title={text.mcpTitle} />
      <Card style={{ gap: 14 }}>
        <Loaded state={list}>
          {(servers) =>
            servers.length === 0 ? (
              <View style={{ gap: 4 }}>
                <Text style={s.text}>{text.noServers}</Text>
                <Text style={s.small}>{text.noServersHint}</Text>
              </View>
            ) : (
              <>
                <Text style={[s.small, mono]}>{text.mcpCount(servers.length)}</Text>
                {servers.map((server) => (
                  <McpRow
                    key={server.id}
                    server={server}
                    onTools={() => setToolsFor(server)}
                    onRemoved={list.retry}
                  />
                ))}
              </>
            )
          }
        </Loaded>
        {adding ? (
          <McpForm
            onCancel={() => setAdding(false)}
            onConnected={() => {
              setAdding(false);
              list.retry();
            }}
          />
        ) : (
          <Button small primary onPress={() => setAdding(true)}>
            {text.addServer}
          </Button>
        )}
        <Text style={s.small}>{text.ownerNote}</Text>
        <Text style={s.small}>{text.externalRule}</Text>
      </Card>
      {toolsFor && <ToolsSheet server={toolsFor} onClose={() => setToolsFor(undefined)} />}
    </View>
  );
}

function McpRow({
  server,
  onTools,
  onRemoved,
}: {
  server: McpItem;
  onTools: () => void;
  onRemoved: () => void;
}) {
  const { api } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const remove = useAction();
  const { risks } = server;
  return (
    <View style={{ gap: 6, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.line }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Text style={[s.text, { fontWeight: "600" }]}>
          {server.name}
          {server.toolCount === null ? null : (
            <>
              {" — "}
              <Text style={mono}>{text.toolCount(server.toolCount)}</Text>
            </>
          )}
        </Text>
        {risks
          ? MCP_RISKS.filter((risk) => risks[risk] > 0).map((risk) => (
              <RiskBadge key={risk} risk={risk} />
            ))
          : null}
        {/* 표시 전용 칩 — 끄는 스위치를 두지 않는다 */}
        {risks && risks.external > 0 ? (
          <Chip tint={colors.warnBg}>{text.approvalRequired}</Chip>
        ) : null}
      </View>
      {/* 서버가 도구 수를 세지 못했다 — 0개로 보이지 않고 서버가 준 사유를 그대로 보인다 */}
      {"toolsError" in server ? (
        <Text style={[s.small, { color: colors.miss }]}>{server.toolsError}</Text>
      ) : null}
      <Text style={s.small}>{server.url}</Text>
      {server.headerNames.length > 0 && (
        <Text style={s.small}>
          {text.headers}: {server.headerNames.join(", ")}
        </Text>
      )}
      {confirming ? (
        <Confirm
          message={text.removeServer(server.name)}
          action={text.remove}
          busy={remove.busy}
          error={remove.error}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            remove.run(async () => {
              await api.request(`/api/connections/mcp/${server.id}`, undefined, "DELETE");
              onRemoved();
            })
          }
        />
      ) : (
        <View style={[s.row, { gap: 8 }]}>
          <Button small onPress={onTools}>
            {text.tools}
          </Button>
          <Button small danger onPress={() => setConfirming(true)}>
            {text.remove}
          </Button>
        </View>
      )}
    </View>
  );
}

function ToolsSheet({ server, onClose }: { server: McpItem; onClose: () => void }) {
  const { api } = useWorkspace();
  const tools = useLoad(
    () => api.request<McpTool[]>(`/api/connections/mcp/${server.id}/tools`),
    server.id,
  );
  return (
    <Sheet title={text.toolsOf(server.name)} subtitle={server.url} onClose={onClose}>
      <Loaded state={tools}>
        {(items) =>
          items.length === 0 ? (
            <View style={{ gap: 10 }}>
              <Text style={s.text}>{text.noTools}</Text>
              <Button small onPress={tools.retry}>
                {text.retry}
              </Button>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              {items.map((tool) => (
                <View key={tool.name} style={{ gap: 4 }}>
                  <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
                    <Text style={[s.text, { fontWeight: "600" }]}>{tool.name}</Text>
                    <RiskBadge
                      risk={tool.risk}
                      suffix={tool.declared ? undefined : ` ${text.undeclared}`}
                    />
                    {tool.risk === "external" && (
                      <Chip tint={colors.warnBg}>{text.approvalRequired}</Chip>
                    )}
                  </View>
                  {!!tool.description && <Text style={s.small}>{tool.description}</Text>}
                </View>
              ))}
            </View>
          )
        }
      </Loaded>
    </Sheet>
  );
}

function McpForm({ onConnected, onCancel }: { onConnected: () => void; onCancel: () => void }) {
  const { api, notify } = useWorkspace();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<McpAuthType>("none");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  // 테스트한 주소·인증과 저장하는 주소·인증이 같아야 한다 → 그 값이 바뀌면 테스트 결과를 버린다
  const [tested, setTested] = useState<TestedTool[]>();
  const test = useAction();
  const connect = useAction();
  const edit = (set: (value: string) => void) => (value: string) => {
    setTested(undefined);
    set(value);
  };
  const header = authType === "header";
  const ready = !!url.trim() && (!header || (!!headerName.trim() && !!headerValue));
  return (
    <View style={{ gap: 4 }}>
      <Field label={text.name} value={name} onChangeText={setName} />
      <Field
        label={text.url}
        placeholder={text.urlHint}
        autoCapitalize="none"
        value={url}
        onChangeText={edit(setUrl)}
      />
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{text.auth}</Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap", marginBottom: 12 }]}>
        {MCP_AUTH_TYPES.map((type) =>
          MCP_AUTH_UNSUPPORTED.includes(type) ? (
            // 서버가 아직 받지 않는 방식 — 고를 수 없게 표시만 한다
            <Choice
              key={type}
              disabled
              label={`${MCP_AUTH_LABELS[type]} · ${COMING_SOON_LABEL}`}
              selected={false}
            />
          ) : (
            <Choice
              key={type}
              label={MCP_AUTH_LABELS[type]}
              selected={authType === type}
              onPress={() => {
                setTested(undefined);
                setAuthType(type);
              }}
            />
          ),
        )}
      </View>
      {header && (
        <>
          <Field
            label={text.headerName}
            autoCapitalize="none"
            value={headerName}
            onChangeText={edit(setHeaderName)}
          />
          <Field
            label={text.headerValue}
            secureTextEntry
            autoCapitalize="none"
            value={headerValue}
            onChangeText={edit(setHeaderValue)}
          />
          <Text style={s.small}>{text.headerNote}</Text>
        </>
      )}
      <ErrorNotice error={test.error} />
      {tested ? (
        <View style={{ gap: 8, marginVertical: 8 }}>
          <Text style={[s.small, mono]}>{text.tested(tested.length)}</Text>
          {tested.length === 0 && <Text style={s.small}>{text.noTools}</Text>}
          {tested.map((tool) => (
            <View key={tool.name} style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              <Text style={s.text}>{tool.name}</Text>
              <RiskBadge risk={tool.risk} />
              {tool.risk === "external" && (
                <Chip tint={colors.warnBg}>{text.approvalRequired}</Chip>
              )}
            </View>
          ))}
        </View>
      ) : (
        <Text style={s.small}>{text.testFirst}</Text>
      )}
      <ErrorNotice error={connect.error} />
      <View style={[s.row, { gap: 8, flexWrap: "wrap", marginTop: 8 }]}>
        <Button
          small
          busy={test.busy}
          disabled={!ready}
          onPress={() =>
            test.run(async () => {
              const result = await api.request<{ tools: TestedTool[] }>(
                "/api/connections/mcp/test",
                {
                  url: url.trim(),
                  auth: header
                    ? { type: authType, name: headerName.trim(), value: headerValue }
                    : { type: authType },
                },
              );
              setTested(result.tools);
            })
          }
        >
          {text.test}
        </Button>
        <Button
          small
          primary
          busy={connect.busy}
          disabled={!tested || !name.trim()}
          onPress={() =>
            connect.run(async () => {
              await api.request("/api/connections/mcp", {
                name: name.trim(),
                url: url.trim(),
                ...(header ? { headers: { [headerName.trim()]: headerValue } } : {}),
              });
              setHeaderValue(""); // 헤더 값은 제출 뒤 화면에 남기지 않는다
              notify(text.connected);
              onConnected();
            })
          }
        >
          {text.connect}
        </Button>
        <Button small onPress={onCancel}>
          {text.cancel}
        </Button>
      </View>
    </View>
  );
}

// ---- 모델 계정 (BYOK) ----
/** 키 검증 실패. kind 는 서버 오류 본문(`{ error, kind }`)의 것 — 없으면 지어내지 않는다. */
type KeyFailure = { message: string; kind?: ModelKeyErrorKind };
const isKeyErrorKind = (value: unknown): value is ModelKeyErrorKind =>
  (MODEL_KEY_ERROR_KINDS as readonly unknown[]).includes(value);
const keyFailure = (e: unknown): KeyFailure => {
  if (e instanceof ApiError) {
    const kind = (e.body as { kind?: unknown } | undefined)?.kind;
    return { message: e.message, kind: isKeyErrorKind(kind) ? kind : undefined };
  }
  // fetch 가 던진 TypeError = 요청이 서버에 닿지 못했다 = 네트워크
  if (e instanceof TypeError) return { message: e.message, kind: "network" };
  return { message: e instanceof Error ? e.message : String(e) };
};

function ModelKeysPanel() {
  const { api } = useWorkspace();
  const list = useLoad(() => api.request<ModelKeyRow[]>("/api/model-keys"));
  return (
    <View>
      <SectionHeading title={text.keysTitle} />
      <Card style={{ gap: 14 }}>
        <Loaded state={list} rows={4} height={56}>
          {(keys) => (
            <>
              {keys.every((key) => key.status === "none") && (
                <View style={{ padding: 12, borderRadius: 10, backgroundColor: colors.sunk }}>
                  <Text style={s.text}>{text.publicKey}</Text>
                </View>
              )}
              {MODEL_KEY_PROVIDERS.map((provider) => {
                const item = keys.find((key) => key.provider === provider);
                return item ? (
                  <KeyCard key={provider} item={item} onChanged={list.retry} />
                ) : (
                  <ErrorNotice
                    key={provider}
                    error={text.missingRow(MODEL_KEY_PROVIDER_LABELS[provider])}
                  />
                );
              })}
            </>
          )}
        </Loaded>
        {/* 누를 수 없는 안내 — 구독 OAuth 는 제공자 공식 지원 전에는 열지 않는다 */}
        <View style={{ gap: 4 }}>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            <Text style={s.text}>{text.subscription}</Text>
            <Chip>{text.subscriptionChip}</Chip>
          </View>
          <Text style={s.small}>{text.subscriptionHint}</Text>
        </View>
        <Text style={s.small}>{text.keyRule}</Text>
      </Card>
    </View>
  );
}

function KeyCard({ item, onChanged }: { item: ModelKeyRow; onChanged: () => void }) {
  const { api, notify } = useWorkspace();
  const [mode, setMode] = useState<"idle" | "edit" | "remove">("idle");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(item.baseUrl ?? ""); // 선택 필드 — 없으면 빈 입력란
  const [verifying, setVerifying] = useState(false);
  const [failure, setFailure] = useState<KeyFailure>();
  const remove = useAction();
  const active = item.status === "active";
  const compatible = item.provider === "compatible";
  const submit = async () => {
    const key = apiKey.trim();
    setApiKey(""); // 제출 즉시 입력란을 비운다 — 성공·실패 어느 쪽이든 키를 화면에 남기지 않는다
    setVerifying(true);
    setFailure(undefined);
    try {
      await api.request(
        `/api/model-keys/${item.provider}`,
        { apiKey: key, ...(compatible ? { baseUrl: baseUrl.trim() } : {}) },
        "PUT",
      );
    } catch (e) {
      setFailure(keyFailure(e));
      return;
    } finally {
      setVerifying(false);
    }
    setMode("idle");
    notify(text.keySaved);
    onChanged();
  };
  return (
    <View style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.line }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Text style={[s.text, { fontWeight: "600" }]}>
          {MODEL_KEY_PROVIDER_LABELS[item.provider]}
        </Text>
        {active && item.last4 !== null && (
          <Text style={[s.text, mono]}>{text.masked(item.last4)}</Text>
        )}
        <Chip tint={active ? colors.okBg : undefined}>
          {active ? text.active : text.unregistered}
        </Chip>
      </View>
      {compatible && !!item.baseUrl && <Text style={[s.small, mono]}>{item.baseUrl}</Text>}
      {mode === "idle" && (
        <View style={[s.row, { gap: 8 }]}>
          <Button small primary={!active} onPress={() => setMode("edit")}>
            {active ? text.replace : text.register}
          </Button>
          {active && (
            <Button small danger onPress={() => setMode("remove")}>
              {text.remove}
            </Button>
          )}
        </View>
      )}
      {mode === "edit" && (
        <View style={{ gap: 4 }}>
          {compatible && (
            <Field
              label={text.baseUrl}
              placeholder={text.urlHint}
              autoCapitalize="none"
              value={baseUrl}
              onChangeText={setBaseUrl}
            />
          )}
          <Field
            label={text.apiKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={apiKey}
            onChangeText={setApiKey}
          />
          {active && <Text style={s.small}>{text.replaceRule}</Text>}
          {verifying && <Text style={s.small}>{text.verifying}</Text>}
          {failure && (
            <ErrorNotice
              error={[
                text.keyFailed,
                failure.kind ? MODEL_KEY_ERROR_LABELS[failure.kind] : undefined,
                failure.message,
              ]
                .filter(Boolean)
                .join("\n")}
            />
          )}
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              primary
              busy={verifying}
              disabled={!apiKey.trim() || (compatible && !baseUrl.trim())}
              onPress={() => void submit()}
            >
              {verifying ? text.verifying : text.verify}
            </Button>
            <Button
              small
              disabled={verifying}
              onPress={() => {
                setApiKey("");
                setFailure(undefined);
                setMode("idle");
              }}
            >
              {text.cancel}
            </Button>
          </View>
        </View>
      )}
      {mode === "remove" && (
        <Confirm
          message={text.removeKey}
          action={text.remove}
          busy={remove.busy}
          error={remove.error}
          onCancel={() => setMode("idle")}
          onConfirm={() =>
            remove.run(async () => {
              await api.request(`/api/model-keys/${item.provider}`, undefined, "DELETE");
              setMode("idle");
              onChanged();
            })
          }
        />
      )}
    </View>
  );
}
