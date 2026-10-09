// 0Siri 화면 8 · 기억. 계약: docs/0siri-api-contract.md «기억 (화면 8)» · «스킬 (화면 9)»(개인 스킬).
// 사용자 피드백은 그 사람의 기억에만 쌓인다 — 팀 공통 스킬은 여기 보이지 않는다.
import { Brain, ChevronDown, ChevronUp } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  EMBED_DOWNLOAD_MB,
  EMBED_DTYPE,
  EMBED_TOKENIZER_MB,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  type MemoryCategory,
  SKILL_STATUS_LABELS,
} from "../../../../packages/domain/src/osiri";
import type { Skill } from "../../../server/src/osiri/skills.ts";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  Field,
  SectionHeading,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { Confirm, column, columns, Loaded, mono } from "./connections";
import { measureDevice } from "./device-embed";
import type { DeviceReport } from "./device-embed.types";
import { CharacterAvatar } from "./eve";
import { Choice, useAction, useLoad } from "./store";
import {
  DEVICE_OFF_REASON,
  deviceSearchOff,
  type Memory,
  type SearchResult,
  searchMemories,
} from "./tier0";

/** 목록 한 번에 읽는 최대 건수. 응답이 이만큼 차면 더 있을 수 있다 — «더 있음» 을 보인다 */
const FACT_LIMIT = 200;

const text = {
  title: "기억",
  purpose:
    "에이전트가 나에 대해 아는 사실입니다. 틀린 것은 고치고 지울 것은 지우세요. 기억은 모델 밖에 저장되어 큰 모델을 바꿔도 따라옵니다.",
  search: "기억 검색",
  category: "카테고리",
  all: "전체",
  searching: "임베딩 검색 중…",
  searchCount: (n: number) => `검색 결과 ${n}건`,
  score: (n: number) => `유사도 ${Math.round(n * 100)}%`,
  servedDevice: "기기에서 검색함",
  servedServer: "서버에서 검색함",
  fallbackReason: (r: string) => `기기 임베딩을 쓰지 못해 서버로 넘겼습니다: ${r}`,
  source: (label: string) => `출처: ${label}`,
  sourceMissing: "출처 정보 없음",
  edit: "수정",
  remove: "삭제",
  save: "저장",
  saved: "저장했습니다 — 다음 작업부터 반영됩니다",
  cancel: "취소",
  removeConfirm: "이 사실을 지우면 팀이 더 이상 참고하지 않습니다",
  empty: "아직 기억된 사실이 없습니다 — 대화하면 쌓입니다",
  emptyHint: "대화에서 알게 된 사실과 직접 적어 둔 사실이 여기에 모입니다.",
  goChat: "대화하러 가기",
  noMatch: "검색 결과가 없습니다",
  clearSearch: "검색 지우기",
  noneInCategory: "이 카테고리에 기억된 사실이 없습니다",
  showAll: "전체 보기",
  newFact: "사실 직접 적기",
  add: "추가",
  added: "기억에 추가했습니다",
  skills: "개인 스킬",
  skillScope: "이 사용자에게만 적용",
  skillVersion: (v: string) => `v${v}`,
  noSkills: "개인 스킬이 아직 없습니다",
  noSkillsHint: "대화에서 피드백을 주면 그 사람에게만 적용되는 스킬 초안이 제안됩니다.",
  turnOff: "끄기",
  turnOn: "켜기",
  rollback: "이전 버전으로",
  measuring: "측정 중",
  how: "적어 둔 사실 + 대화 Q&A를 임베딩해 저장하고, 말할 때 관련 조각만 출처와 함께 모델에 붙입니다.",
  door: "다른 LLM 앱이 읽는 기억 MCP 문",
  doorHint: "사용자가 허용할 때만 열립니다. 끄면 외부 앱의 접근이 즉시 중단됩니다.",
  deleteRule: "삭제한 사실은 원본과 벡터 인덱스에서 함께 지워집니다.",
  diagnostics: "진단",
  deviceTitle: "기기 임베딩 실측",
  deviceHint: `이 기기에서 EmbeddingGemma 2(${EMBED_DTYPE})를 돌려 속도·품질을 잽니다. 모델(${EMBED_DOWNLOAD_MB}MB)과 토크나이저(${EMBED_TOKENIZER_MB}MB)는 처음 한 번 내려받습니다.`,
  deviceOff: `${DEVICE_OFF_REASON} — 설정 › 기기 모델에서 다시 켜면 실측할 수 있습니다`,
  more: (n: number) => `더 있음 — 검색으로 좁히세요 (처음 ${n}건만 보입니다)`,
  deviceMeasure: "실측 시작",
  deviceUnavailable: "이 기기에서는 기기 임베딩을 쓸 수 없습니다 — 검색은 서버에서 합니다",
  deviceResult: (r: DeviceReport) =>
    `${r.backend} · 로드 ${r.loadMs}ms · 문장당 ${r.embedMsPer}ms · ${r.dim}차원` +
    (r.memoryMb ? ` · 메모리 ${r.memoryMb}MB` : "") +
    (r.top1 ? ` · 한국어 top-1 ${r.top1.hits}/${r.top1.total}` : ""),
};

export function MemoryScreen() {
  return (
    <View style={{ gap: 16 }}>
      <View style={[s.row, { gap: 12 }]}>
        <CharacterAvatar size={40} mood="idle" />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.title}>{text.title}</Text>
          <Text style={s.small}>{text.purpose}</Text>
        </View>
      </View>
      <View style={columns}>
        <View style={column}>
          <Facts />
        </View>
        <View style={column}>
          <PersonalSkills />
          <Card style={{ gap: 12 }}>
            <Text style={s.small}>{text.how}</Text>
            <McpDoor />
            <Text style={s.small}>{text.deleteRule}</Text>
          </Card>
          <Diagnostics />
        </View>
      </View>
    </View>
  );
}

function Facts() {
  const { api, navigate, notify } = useWorkspace();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<MemoryCategory>();
  const query = q.trim();
  // 티어 0: 기기 임베딩으로 검색하고, 안 되면 서버로 — 어느 쪽인지와 넘어간 이유를 숨기지 않는다 (§11.1)
  const list = useLoad<SearchResult & { more: boolean }>(
    async () => {
      const all = await api.request<Memory[]>(
        `/api/memories?limit=${FACT_LIMIT}${category ? `&category=${category}` : ""}`,
      );
      const more = all.length >= FACT_LIMIT;
      if (!query) return { items: all, servedBy: "server", more };
      const found = await searchMemories(api, query, all, 20);
      // 서버 폴백 경로(`/memories?q=`)는 카테고리를 모르니 한 번 더 거른다
      const items = found.items.filter((m) => !category || m.category === category);
      return { ...found, items, more };
    },
    `${query}|${category ?? ""}`,
  );
  const [draft, setDraft] = useState("");
  const add = useAction();
  return (
    <View>
      <SectionHeading title={text.title} />
      <Card style={{ gap: 12 }}>
        <Field label={text.search} value={q} onChangeText={setQ} />
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Text style={s.small}>{text.category}</Text>
          <Choice label={text.all} selected={!category} onPress={() => setCategory(undefined)} />
          {MEMORY_CATEGORIES.map((id) => (
            <Choice
              key={id}
              label={MEMORY_CATEGORY_LABELS[id]}
              selected={category === id}
              onPress={() => setCategory(id)}
            />
          ))}
        </View>
        {!!query && list.loading && <Text style={s.small}>{text.searching}</Text>}
        {!!query && !list.loading && list.data && (
          <View style={{ gap: 4 }}>
            <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
              <Text style={[s.small, mono]}>{text.searchCount(list.data.items.length)}</Text>
              <Chip tint={list.data.servedBy === "device" ? colors.okBg : undefined}>
                {list.data.servedBy === "device" ? text.servedDevice : text.servedServer}
              </Chip>
            </View>
            {list.data.servedBy === "server" && !!list.data.reason && (
              <Text style={s.small}>
                {list.data.reason === DEVICE_OFF_REASON
                  ? DEVICE_OFF_REASON
                  : text.fallbackReason(list.data.reason)}
              </Text>
            )}
          </View>
        )}
        <Loaded state={list} rows={4} height={56}>
          {({ items }) =>
            items.length > 0 ? (
              items.map((m) => <FactRow key={m.id} fact={m} onChanged={list.retry} />)
            ) : query ? (
              <Empty icon={Brain} title={text.noMatch} detail={query}>
                <Button small onPress={() => setQ("")}>
                  {text.clearSearch}
                </Button>
              </Empty>
            ) : category ? (
              <Empty
                icon={Brain}
                title={text.noneInCategory}
                detail={MEMORY_CATEGORY_LABELS[category]}
              >
                <Button small onPress={() => setCategory(undefined)}>
                  {text.showAll}
                </Button>
              </Empty>
            ) : (
              <Empty icon={Brain} title={text.empty} detail={text.emptyHint}>
                <Button small primary onPress={() => navigate("chat")}>
                  {text.goChat}
                </Button>
              </Empty>
            )
          }
        </Loaded>
        {/* 기기 검색은 받은 목록 안에서만 찾는다 — 목록이 잘렸으면 검색 중에도 그 사실을 보인다 */}
        {!list.loading && list.data?.more && (
          <Chip tint={colors.warnBg}>{text.more(FACT_LIMIT)}</Chip>
        )}
        <Field label={text.newFact} multiline value={draft} onChangeText={setDraft} />
        <ErrorNotice error={add.error} />
        <Button
          small
          busy={add.busy}
          disabled={!draft.trim()}
          onPress={() =>
            add.run(async () => {
              await api.request("/api/memories", { text: draft.trim(), source: "user" });
              setDraft("");
              notify(text.added);
              list.retry();
            })
          }
        >
          {text.add}
        </Button>
      </Card>
    </View>
  );
}

function FactRow({ fact, onChanged }: { fact: Memory; onChanged: () => void }) {
  const { api, notify } = useWorkspace();
  const [mode, setMode] = useState<"idle" | "edit" | "remove">("idle");
  const [draft, setDraft] = useState(fact.text);
  const save = useAction();
  const remove = useAction();
  return (
    <View style={{ gap: 6, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.line }}>
      {mode === "edit" ? (
        <>
          <Field label={text.edit} multiline value={draft} onChangeText={setDraft} />
          <ErrorNotice error={save.error} />
          <View style={[s.row, { gap: 8 }]}>
            <Button
              small
              primary
              busy={save.busy}
              disabled={!draft.trim() || draft.trim() === fact.text}
              onPress={() =>
                save.run(async () => {
                  await api.request(`/api/memories/${fact.id}`, { text: draft.trim() }, "PATCH");
                  notify(text.saved);
                  onChanged(); // 서버가 받아들인 뒤에 목록을 다시 읽는다 (낙관적 표시 없음)
                })
              }
            >
              {text.save}
            </Button>
            <Button
              small
              disabled={save.busy}
              onPress={() => {
                setDraft(fact.text);
                setMode("idle");
              }}
            >
              {text.cancel}
            </Button>
          </View>
        </>
      ) : (
        <>
          <Text style={s.text}>{fact.text}</Text>
          <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
            {fact.sourceLabel ? (
              <Text style={s.small}>{text.source(fact.sourceLabel)}</Text>
            ) : (
              // 계약 필드가 안 왔다 — 빈칸으로 넘기지 않고 보이게 둔다
              <Chip tint={colors.warnBg}>{text.sourceMissing}</Chip>
            )}
            <Text style={[s.small, mono]}>{dateLabel(fact.createdAt)}</Text>
            {fact.score !== undefined && (
              <Text style={[s.small, mono]}>{text.score(fact.score)}</Text>
            )}
          </View>
        </>
      )}
      {mode === "idle" && (
        <View style={[s.row, { gap: 8 }]}>
          <Button small onPress={() => setMode("edit")}>
            {text.edit}
          </Button>
          <Button small danger onPress={() => setMode("remove")}>
            {text.remove}
          </Button>
        </View>
      )}
      {mode === "remove" && (
        // 실패하면 행은 그대로 남고 사유가 이 자리에 보인다
        <Confirm
          message={text.removeConfirm}
          action={text.remove}
          busy={remove.busy}
          error={remove.error}
          onCancel={() => setMode("idle")}
          onConfirm={() =>
            remove.run(async () => {
              await api.request(`/api/memories/${fact.id}`, undefined, "DELETE");
              onChanged();
            })
          }
        />
      )}
    </View>
  );
}

function PersonalSkills() {
  const { api, navigate } = useWorkspace();
  const list = useLoad(() => api.request<Skill[]>("/api/skills?scope=personal"));
  return (
    <View>
      <SectionHeading title={text.skills} />
      <Card style={{ gap: 12 }}>
        <Loaded state={list} rows={2} height={56}>
          {(skills) =>
            skills.length === 0 ? (
              <View style={{ gap: 8 }}>
                <Text style={s.text}>{text.noSkills}</Text>
                <Text style={s.small}>{text.noSkillsHint}</Text>
                <Button small onPress={() => navigate("chat")}>
                  {text.goChat}
                </Button>
              </View>
            ) : (
              skills.map((skill) => (
                <SkillRow key={skill.id} skill={skill} onChanged={list.retry} />
              ))
            )
          }
        </Loaded>
      </Card>
    </View>
  );
}

function SkillRow({ skill, onChanged }: { skill: Skill; onChanged: () => void }) {
  const { api } = useWorkspace();
  const act = useAction();
  const on = skill.status === "active";
  // 켜고 끌 수 있는 것은 이미 승인된 스킬뿐 — 초안·반려·폐기 제안의 결정은 스킬 화면(9)에서 한다
  const switchable = on || skill.status === "retired";
  return (
    <View style={{ gap: 6, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.line }}>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        <Text style={[s.text, { fontWeight: "600" }]}>{skill.name}</Text>
        <Text style={[s.text, mono]}>{text.skillVersion(skill.version)}</Text>
        <Chip tint={on ? colors.okBg : undefined}>{SKILL_STATUS_LABELS[skill.status]}</Chip>
        {skill.measuring && <Chip>{text.measuring}</Chip>}
      </View>
      <Text style={s.small}>
        {text.skillScope}
        {skill.appliesTo ? ` · ${skill.appliesTo}` : ""}
      </Text>
      <ErrorNotice error={act.error} />
      {switchable && (
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            busy={act.busy}
            onPress={() =>
              act.run(async () => {
                await api.request(`/api/skills/${skill.id}`, { enabled: !on }, "PATCH");
                onChanged();
              })
            }
          >
            {on ? text.turnOff : text.turnOn}
          </Button>
          <Button
            small
            disabled={act.busy}
            onPress={() =>
              act.run(async () => {
                await api.request(`/api/skills/${skill.id}/rollback`, {});
                onChanged();
              })
            }
          >
            {text.rollback}
          </Button>
        </View>
      )}
    </View>
  );
}

function McpDoor() {
  const { api } = useWorkspace();
  const path = "/api/memories/mcp-access";
  const door = useLoad(() => api.request<{ enabled: boolean }>(path));
  const act = useAction();
  return (
    <Loaded state={door} rows={1}>
      {({ enabled }) => (
        <View style={{ gap: 6 }}>
          <CheckRow
            label={text.door}
            checked={enabled}
            onPress={() =>
              act.run(async () => {
                await api.request(path, { enabled: !enabled }, "PATCH");
                door.setData(await api.request<{ enabled: boolean }>(path)); // 서버가 말한 상태만 보인다
              })
            }
          />
          <Text style={s.small}>{text.doorHint}</Text>
          <ErrorNotice error={act.error} />
        </View>
      )}
    </Loaded>
  );
}

/** 접어 둔 진단 — 9단계 기기 실측 (§22-9): 로드·지연·메모리·한국어 top-1 */
function Diagnostics() {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<DeviceReport>();
  const act = useAction();
  const Arrow = open ? ChevronUp : ChevronDown;
  return (
    <Card style={{ gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={s.between}
      >
        <Text style={[s.text, { fontWeight: "600" }]}>{text.diagnostics}</Text>
        <Arrow size={16} color={colors.muted} />
      </Pressable>
      {open && (
        <>
          <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>
            {text.deviceTitle}
          </Text>
          <Text style={s.small}>{text.deviceHint}</Text>
          <Button
            small
            busy={act.busy}
            onPress={() =>
              act.run(async () => {
                // 꺼 둔 채로 실측하면 지운 모델을 다시 받는다 — 받지 않고 사유를 보인다
                if (deviceSearchOff()) throw new Error(text.deviceOff);
                setReport(await measureDevice());
              })
            }
          >
            {text.deviceMeasure}
          </Button>
          <ErrorNotice error={act.error} />
          {report && (
            <Text style={[s.small, mono]}>
              {report.available
                ? text.deviceResult(report)
                : [text.deviceUnavailable, report.reason].filter(Boolean).join(" · ")}
            </Text>
          )}
        </>
      )}
    </Card>
  );
}
