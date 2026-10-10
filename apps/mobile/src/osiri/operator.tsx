// 0Siri 운영자 콘솔(화면 10) — 패키지 운영자가 자기 팀의 버전을 제출·배포하고, 스킬 초안을 승인하고, 지표를 본다.
// 운영자도 같은 앱을 쓰고 롤로 메뉴가 갈린다. 자기 패키지만 보이며 지표는 집계만 온다.
import { Check, Lock, PackageOpen, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import {
  CANARY_ADVANCE_ORDER,
  CANARY_STAGE_LABELS,
  type CanaryAction,
  REVIEW_MANUAL_REASON,
  VERSION_STATUS_LABELS,
} from "../../../../packages/domain/src/osiri";
import type {
  Operator,
  OperatorMetrics,
  PackageVersion,
  VersionSource,
} from "../../../server/src/osiri/operator.ts";
import type { Skill } from "../../../server/src/osiri/skills.ts";
import { ApiError } from "../api-response";
import {
  Badge,
  Button,
  Card,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  fonts,
  relativeDate,
  Skeleton,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { CharacterAvatar } from "./eve";
import { SkillDraftCard } from "./skills";
import { Choice, useAction, useLoad } from "./store";
import { LoadError, Meter } from "./team-goals";

/** `GET /operator/packages` 항목 — 서버 `Operator.packages()` 가 돌려주는 모양 그대로. */
type OperatorPackage = Awaited<ReturnType<Operator["packages"]>>[number];

type Menu = "versions" | "skills" | "metrics" | "notices";
const MENUS: Menu[] = ["versions", "skills", "metrics", "notices"];
type SourceKind = keyof VersionSource;
const SOURCES: SourceKind[] = ["imageDigest", "mcpUrl"];

const text = {
  operatorOnly: "운영자 전용 메뉴입니다",
  operatorOnlyDetail: "패키지를 등록한 운영자 계정에서만 열려요. 이 계정은 운영자가 아니에요.",
  goStore: "스토어 보기",
  noPackages: "운영할 패키지가 없습니다",
  noPackagesDetail:
    "이 계정으로 등록한 패키지가 없어요. 패키지가 입점하면 여기서 버전을 올리고 배포해요.",
  myPackages: "내 패키지",
  menu: {
    versions: "버전 제출",
    skills: "스킬 승인",
    metrics: "지표",
    notices: "공지",
  } satisfies Record<Menu, string>,
  noVersion: "제출 이력 없음",
  submitNew: "새 버전 제출",
  source: { imageDigest: "이미지 digest", mcpUrl: "MCP 서버 주소" } satisfies Record<
    SourceKind,
    string
  >,
  sourceHint: { imageDigest: "sha256:…", mcpUrl: "https://…/mcp" } satisfies Record<
    SourceKind,
    string
  >,
  submit: "제출",
  submitNote:
    "제출하면 심사 체크리스트 9항을 확인해요. 서버가 자동으로 확인하지 못하는 항목은 수동 심사로 남고, 모두 통과해야 카나리가 시작돼요.",
  cancel: "취소",
  emptyVersionsDetail: "첫 버전을 제출하면 자동 심사를 거쳐 카나리 배포가 시작돼요.",
  submitFirst: "버전 제출하기",
  review: "자동 심사",
  reviewScore: (pass: number, total: number) => `${pass}/${total}항 통과`,
  manualCount: (n: number) => `수동 심사 대기 ${n}항`,
  pass: "통과",
  fail: "실패",
  manual: "수동 심사 대기",
  blocked: "심사에 실패해 배포가 막혔습니다. 실패한 항목을 고쳐 다시 제출해 주세요.",
  manualBlocked:
    "자동으로 확인하지 못한 항목이 수동 심사를 기다리고 있어 배포가 시작되지 않았습니다. 실패한 항목은 없습니다.",
  degraded: "카나리 지표가 나빠졌습니다 — 확대를 [중단]하고 이전 버전으로 [롤백]하세요.",
  degradedRates: (before: number | null, after: number | null) =>
    `승인율 ${before === null ? "—" : `${before}%`} → ${after === null ? "—" : `${after}%`}`,
  canary: "카나리 배포",
  stoppedHint: "확대를 멈췄어요. 지표가 나빠졌다면 이전 버전으로 롤백하세요.",
  advance: "확대",
  stop: "중단",
  rollback: "이전 버전으로 롤백",
  rollbackConfirm:
    "심사 없이 즉시 이전 버전으로 돌아갑니다. 지금 버전의 배포는 멈춰요. 계속할까요?",
  rollbackGo: "롤백 실행",
  metricLabels: {
    approvalRate: "승인율",
    topRejectReason: "반려 사유 1위",
    citations: "AI 인용",
  } satisfies Record<
    keyof Pick<OperatorMetrics, "approvalRate" | "topRejectReason" | "citations">,
    string
  >,
  measuring: "측정 중",
  metricsNote: "집계만 보여요. 사용자의 원본 데이터는 열람할 수 없어요.",
  queueEmpty: "승인할 스킬 초안이 없습니다",
  queueEmptyDetail:
    "여러 구독자에게서 같은 종류의 반려가 반복되면 하루 한 번 공통 스킬 초안이 올라와요. 반려 문장은 오지 않아요. 승인해야 팀에 장착돼요.",
  refresh: "새로 고침",
  discover: "지금 찾기",
  notice: "공지 내용",
  noticeHint: "구독자 방에 올라갈 공지를 적어 주세요",
  publish: "공지 발행",
  published: "공지를 발행했습니다",
};
const mono = { fontFamily: fonts.mono };

export function OperatorScreen() {
  const { api, navigate } = useWorkspace();
  const { width } = useWindowDimensions();
  // 운영자가 아니면 서버가 403 으로 막는다 — 그때만 «운영자 전용» 안내다(null). 역할을 화면에서 다시 따지지 않는다.
  const packages = useLoad(() =>
    api.request<OperatorPackage[]>("/api/operator/packages").catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 403) return null;
      throw e;
    }),
  );
  const [picked, setPicked] = useState("");
  const [menu, setMenu] = useState<Menu>("versions");

  const list = packages.data;
  if (list === undefined)
    return packages.error ? (
      <LoadError error={packages.error} onRetry={packages.retry} />
    ) : (
      <Skeleton rows={3} />
    );
  if (list === null)
    return (
      <Card>
        <Empty icon={Lock} title={text.operatorOnly} detail={text.operatorOnlyDetail}>
          <Button small onPress={() => navigate("store")}>
            {text.goStore}
          </Button>
        </Empty>
      </Card>
    );
  if (list.length === 0)
    return (
      <Card>
        <Empty icon={PackageOpen} title={text.noPackages} detail={text.noPackagesDetail}>
          <Button small onPress={() => navigate("store")}>
            {text.goStore}
          </Button>
        </Empty>
      </Card>
    );
  const pkg = list.find((p) => p.id === picked) ?? list[0];
  if (!pkg) return null; // list.length > 0 이라 도달하지 않는다(타입 좁히기)
  const wide = width >= 900;

  const packageList = (
    <View style={wide ? { gap: 8 } : [s.row, { gap: 8, flexWrap: "wrap" }]}>
      {wide ? <Text style={s.label}>{text.myPackages}</Text> : null}
      {list.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityState={{ selected: p.id === pkg.id }}
          onPress={() => setPicked(p.id)}
          style={[
            s.row,
            {
              gap: 8,
              padding: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: p.id === pkg.id ? colors.accent : colors.line,
              backgroundColor: p.id === pkg.id ? colors.accentSoft : colors.card,
            },
          ]}
        >
          <CharacterAvatar character={p.character} size={28} />
          <Text style={s.text}>{p.name}</Text>
          <Badge count={p.pendingSkills} />
        </Pressable>
      ))}
    </View>
  );
  const menuList = (
    <View
      style={wide ? { gap: 6, alignItems: "flex-start" } : [s.row, { gap: 8, flexWrap: "wrap" }]}
    >
      {MENUS.map((m) => (
        <View key={m} style={[s.row, { gap: 4 }]}>
          <Choice label={text.menu[m]} selected={menu === m} onPress={() => setMenu(m)} />
          {m === "skills" ? <Badge count={pkg.pendingSkills} /> : null}
        </View>
      ))}
    </View>
  );
  const panel = <PackagePanel key={pkg.id} pkg={pkg} menu={menu} onChanged={packages.retry} />;

  return (
    <View style={{ gap: 16 }}>
      {packages.error ? <LoadError error={packages.error} onRetry={packages.retry} /> : null}
      {wide ? (
        <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
          <View style={{ width: 240, gap: 18 }}>
            {packageList}
            {menuList}
          </View>
          <View style={{ flex: 1 }}>{panel}</View>
        </View>
      ) : (
        <>
          {packageList}
          {menuList}
          {panel}
        </>
      )}
    </View>
  );
}

function PackagePanel({
  pkg,
  menu,
  onChanged,
}: {
  pkg: OperatorPackage;
  menu: Menu;
  /** 버전·스킬 큐가 바뀌어 패키지 목록(현재 버전·대기 배지)을 다시 읽어야 할 때 */
  onChanged: () => void;
}) {
  const { api, notify } = useWorkspace();
  const q = `package_id=${encodeURIComponent(pkg.id)}`;
  const versions = useLoad(() => api.request<PackageVersion[]>(`/api/operator/versions?${q}`));
  const metrics = useLoad(() => api.request<OperatorMetrics>(`/api/operator/metrics?${q}`));
  const queue = useLoad(() => api.request<Skill[]>(`/api/operator/skills?${q}`));
  const act = useAction();
  const [formOpen, setFormOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind>("imageDigest");
  const [source, setSource] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");

  const reloadVersions = () => {
    versions.retry();
    metrics.retry();
    onChanged();
  };
  const submit = () =>
    act.run(async () => {
      await api.request("/api/operator/versions", {
        packageId: pkg.id,
        [sourceKind]: source.trim(),
      });
      setSource("");
      setFormOpen(false);
      reloadVersions(); // 심사 결과는 다시 읽은 버전 목록이 보여 준다
    });
  const canary = (version: PackageVersion, action: CanaryAction) =>
    act.run(async () => {
      await api.request(`/api/operator/versions/${version.id}/canary`, { action });
      reloadVersions();
    });
  const rollback = () =>
    act.run(async () => {
      await api.request("/api/operator/rollback", { packageId: pkg.id });
      setConfirming(false);
      reloadVersions();
    });
  const discover = () =>
    act.run(async () => {
      await api.request("/api/operator/skills/discover", { packageId: pkg.id });
      queue.setData(await api.request<Skill[]>(`/api/operator/skills?${q}`));
      onChanged();
    });
  const publish = () =>
    act.run(async () => {
      await api.request("/api/operator/notices", { packageId: pkg.id, text: notice.trim() });
      setNotice("");
      notify(text.published);
    });

  // 대표 캐릭터를 버전·지표 옆에 고정한다 — 사용자 화면과 같은 자산이 쓰이는지 운영자가 확인한다.
  const header = (
    <Card style={{ gap: 12 }}>
      <View style={[s.row, { gap: 14 }]}>
        <CharacterAvatar character={pkg.character} size={56} />
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={[s.heading, { fontFamily: fonts.display }]}>{pkg.name}</Text>
          {pkg.currentVersion === null ? (
            <Chip>{text.noVersion}</Chip>
          ) : (
            <Text style={[s.text, mono]}>v{pkg.currentVersion}</Text>
          )}
        </View>
      </View>
      {!metrics.data ? (
        metrics.error ? (
          <LoadError error={metrics.error} onRetry={metrics.retry} />
        ) : (
          <Skeleton rows={1} height={28} />
        )
      ) : (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Metric
            label={text.metricLabels.approvalRate}
            value={metrics.data.approvalRate === null ? null : `${metrics.data.approvalRate}%`}
          />
          <Metric label={text.metricLabels.topRejectReason} value={metrics.data.topRejectReason} />
          <Metric
            label={text.metricLabels.citations}
            value={metrics.data.citations === null ? null : String(metrics.data.citations)}
          />
        </View>
      )}
    </Card>
  );

  const versionSection = (
    <View style={{ gap: 12 }}>
      {formOpen ? (
        <Card style={{ gap: 10 }}>
          <View style={[s.row, { gap: 8 }]}>
            {SOURCES.map((k) => (
              <Choice
                key={k}
                label={text.source[k]}
                selected={sourceKind === k}
                onPress={() => setSourceKind(k)}
              />
            ))}
          </View>
          <Field
            label={text.source[sourceKind]}
            placeholder={text.sourceHint[sourceKind]}
            autoCapitalize="none"
            autoCorrect={false}
            value={source}
            onChangeText={setSource}
            style={mono}
          />
          <Text style={s.small}>{text.submitNote}</Text>
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              primary
              busy={act.busy}
              disabled={!source.trim()}
              onPress={() => void submit()}
            >
              {text.submit}
            </Button>
            <Button small disabled={act.busy} onPress={() => setFormOpen(false)}>
              {text.cancel}
            </Button>
          </View>
        </Card>
      ) : (
        <Button small onPress={() => setFormOpen(true)} style={{ alignSelf: "flex-start" }}>
          {text.submitNew}
        </Button>
      )}

      {!versions.data ? (
        versions.error ? (
          <LoadError error={versions.error} onRetry={versions.retry} />
        ) : (
          <Skeleton rows={2} height={120} />
        )
      ) : versions.data.length === 0 ? (
        formOpen ? null : (
          <Card>
            <Empty icon={PackageOpen} title={text.noVersion} detail={text.emptyVersionsDetail}>
              <Button small primary onPress={() => setFormOpen(true)}>
                {text.submitFirst}
              </Button>
            </Empty>
          </Card>
        )
      ) : (
        <>
          {versions.error ? <LoadError error={versions.error} onRetry={versions.retry} /> : null}
          {versions.data.map((v) => (
            <VersionCard
              key={v.id}
              version={v}
              degraded={metrics.data?.degraded === true}
              busy={act.busy}
              onCanary={(action) => void canary(v, action)}
            />
          ))}
          {confirming ? (
            <Card style={{ gap: 10, borderColor: colors.miss }}>
              <Text style={s.text}>{text.rollbackConfirm}</Text>
              <View style={[s.row, { gap: 8 }]}>
                <Button small danger busy={act.busy} onPress={() => void rollback()}>
                  {text.rollbackGo}
                </Button>
                <Button small disabled={act.busy} onPress={() => setConfirming(false)}>
                  {text.cancel}
                </Button>
              </View>
            </Card>
          ) : (
            <>
              {metrics.data?.degraded ? (
                // 자동으로 멈추지는 않는다 — 운영자가 [중단]·[롤백] 을 고르게 근거와 함께 알린다
                <View accessibilityRole="alert" style={s.error}>
                  <Text style={[s.text, { color: colors.miss }]}>{text.degraded}</Text>
                  <Text style={[s.small, mono, { color: colors.miss }]}>
                    {text.degradedRates(
                      metrics.data.previousApprovalRate,
                      metrics.data.canaryApprovalRate,
                    )}
                  </Text>
                </View>
              ) : null}
              <Button
                small
                danger
                onPress={() => setConfirming(true)}
                style={{ alignSelf: "flex-start" }}
              >
                {text.rollback}
              </Button>
            </>
          )}
        </>
      )}
    </View>
  );

  const skillSection = !queue.data ? (
    queue.error ? (
      <LoadError error={queue.error} onRetry={queue.retry} />
    ) : (
      <Skeleton rows={2} height={110} />
    )
  ) : queue.data.length === 0 ? (
    <Card>
      <Empty icon={Check} title={text.queueEmpty} detail={text.queueEmptyDetail}>
        <Button small onPress={discover}>
          {text.discover}
        </Button>
      </Empty>
    </Card>
  ) : (
    <View style={{ gap: 12 }}>
      {queue.error ? <LoadError error={queue.error} onRetry={queue.retry} /> : null}
      {queue.data.map((skill) => (
        <SkillDraftCard
          key={skill.id}
          skill={skill}
          character={pkg.character}
          canDecide
          onDecide={async (decision, reason) => {
            await api.request(`/api/operator/skills/${skill.id}/decide`, { decision, reason });
            // 결과는 다시 읽은 큐와 패키지 배지가 보여 준다
            queue.setData(await api.request<Skill[]>(`/api/operator/skills?${q}`));
            onChanged();
          }}
        />
      ))}
    </View>
  );

  const metricSection = (
    <Card style={{ gap: 10 }}>
      {/* 값은 위 머리 카드(캐릭터 옆)에 고정돼 있다 — 여기서는 무엇을 보는 숫자인지만 말한다 */}
      <Text style={s.heading}>{text.menu.metrics}</Text>
      <Text style={s.muted}>{text.metricsNote}</Text>
      <Button small onPress={metrics.retry} style={{ alignSelf: "flex-start" }}>
        {text.refresh}
      </Button>
    </Card>
  );

  const noticeSection = (
    <Card style={{ gap: 4 }}>
      <Field
        label={text.notice}
        placeholder={text.noticeHint}
        multiline
        value={notice}
        onChangeText={setNotice}
      />
      <Button
        small
        primary
        busy={act.busy}
        disabled={!notice.trim()}
        onPress={() => void publish()}
        style={{ alignSelf: "flex-start" }}
      >
        {text.publish}
      </Button>
    </Card>
  );

  return (
    <View style={{ gap: 16 }}>
      {header}
      <ErrorNotice error={act.error} />
      {menu === "versions"
        ? versionSection
        : menu === "skills"
          ? skillSection
          : menu === "metrics"
            ? metricSection
            : noticeSection}
    </View>
  );
}

/** 지표 한 칸. 값이 null 이면 «측정 중» 칩. */
function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={[s.row, { gap: 6 }]}>
      <Text style={s.small}>{label}</Text>
      {value === null ? <Chip>{text.measuring}</Chip> : <Text style={[s.text, mono]}>{value}</Text>}
    </View>
  );
}

/** 버전 한 건: 출처 · 자동 심사 체크리스트 · 카나리 단계. 심사 실패는 배포가 막혔다고 말한다. */
function VersionCard({
  version,
  degraded,
  busy,
  onCanary,
}: {
  version: PackageVersion;
  /** 카나리 지표 악화(서버 `/operator/metrics` 의 degraded) — [중단] 을 앞세운다 */
  degraded: boolean;
  busy: boolean;
  onCanary: (action: CanaryAction) => void;
}) {
  const failed = version.status === "review_failed";
  const passed = version.review.filter((r) => r.pass).length;
  // 서버가 자동으로 확인하지 못한 항목 — 실패가 아니라 수동 심사 대기다(통과로 치지도 않는다)
  const isManual = (r: PackageVersion["review"][number]) =>
    !r.pass && r.reason === REVIEW_MANUAL_REASON;
  const manual = version.review.filter(isManual).length;
  const realFails = version.review.length - passed - manual;
  const { stage, percent } = version.canary;
  const at = (CANARY_ADVANCE_ORDER as readonly string[]).indexOf(stage); // "stopped" 는 -1
  const tint =
    version.status === "live"
      ? colors.okBg
      : failed
        ? colors.missBg
        : version.status === "canary"
          ? colors.warnBg
          : colors.sunk;
  return (
    <Card style={{ gap: 12, borderColor: failed ? colors.miss : colors.line }}>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={[s.heading, mono]}>v{version.version}</Text>
        <Chip tint={tint}>{VERSION_STATUS_LABELS[version.status]}</Chip>
        <Text style={s.small}>{relativeDate(version.createdAt)}</Text>
      </View>
      {version.source.imageDigest ? (
        <Text style={[s.small, mono]} numberOfLines={1}>
          {text.source.imageDigest} {version.source.imageDigest}
        </Text>
      ) : null}
      {version.source.mcpUrl ? (
        <Text style={[s.small, mono]} numberOfLines={1}>
          {text.source.mcpUrl} {version.source.mcpUrl}
        </Text>
      ) : null}

      <View style={{ gap: 6 }}>
        <View style={[s.row, { gap: 8 }]}>
          <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{text.review}</Text>
          <Text style={[s.small, mono]}>{text.reviewScore(passed, version.review.length)}</Text>
          {manual > 0 ? <Text style={[s.small, mono]}>· {text.manualCount(manual)}</Text> : null}
        </View>
        {version.review.map((r) => (
          <View key={r.id} style={[s.row, { gap: 8, alignItems: "flex-start" }]}>
            {r.pass ? (
              <Check size={14} color={colors.ok} />
            ) : isManual(r) ? (
              <Lock size={14} color={colors.warn} />
            ) : (
              <X size={14} color={colors.miss} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={s.muted}>
                {r.item} · {r.pass ? text.pass : isManual(r) ? text.manual : text.fail}
              </Text>
              {r.reason ? (
                <Text
                  style={[
                    s.small,
                    r.pass ? null : { color: isManual(r) ? colors.warn : colors.miss },
                  ]}
                >
                  {r.reason}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
        {failed ? (
          <View accessibilityRole="alert" style={s.error}>
            <Text style={[s.text, { color: colors.miss }]}>
              {realFails === 0 && manual > 0 ? text.manualBlocked : text.blocked}
            </Text>
          </View>
        ) : null}
      </View>

      {failed ? null : (
        <View style={{ gap: 8 }}>
          <View style={[s.row, { gap: 8 }]}>
            <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{text.canary}</Text>
            <Text style={[s.small, mono]}>{percent}%</Text>
            {stage === "stopped" ? (
              <Chip tint={colors.missBg}>{CANARY_STAGE_LABELS.stopped}</Chip>
            ) : null}
          </View>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {CANARY_ADVANCE_ORDER.map((step, i) => (
              <View key={step} style={[s.row, { gap: 6 }]}>
                {i > 0 ? <Text style={s.small}>→</Text> : null}
                <Chip tint={i < at ? colors.okBg : i === at ? colors.accentSoft : undefined}>
                  {CANARY_STAGE_LABELS[step]}
                  {i < at ? " ✓" : ""}
                </Chip>
              </View>
            ))}
          </View>
          <Meter value={percent} tone={stage === "stopped" ? colors.miss : colors.accent} />
          {stage === "stopped" ? <Text style={s.small}>{text.stoppedHint}</Text> : null}
          {version.status === "canary" && degraded ? (
            <Text accessibilityRole="alert" style={[s.small, { color: colors.miss }]}>
              {text.degraded}
            </Text>
          ) : null}
          {version.status === "canary" ? (
            <View style={[s.row, { gap: 8 }]}>
              <Button
                small
                primary={!degraded}
                busy={busy}
                disabled={stage === "all" || stage === "stopped"}
                onPress={() => onCanary("advance")}
              >
                {text.advance}
              </Button>
              <Button
                small
                danger
                disabled={busy || stage === "stopped"}
                onPress={() => onCanary("stop")}
              >
                {text.stop}
              </Button>
            </View>
          ) : null}
        </View>
      )}
    </Card>
  );
}
