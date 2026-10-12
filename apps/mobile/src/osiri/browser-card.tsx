// 대화 안 브라우저 (마스터 2026-10-12 «Meta Muse 처럼 대화 내부에서 브라우저를 열고, 작동 권한을 넘기고 받고 · 프로필 저장»).
// 영시리가 browse_web 으로 열거나 browser_handoff 로 넘기면 이 카드가 붙는다. 화면·제어권(직접 조작 / 영시리에게 돌려주기)은 콘솔이 맡고,
// 카드는 펼치기와 프로필(사람마다 여러 개, 로그인이 프로필에 남는다)을 맡는다. 서버 browser.ts 가 정본.
import { Globe } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BROWSER_PROFILE_NAME_MAX } from "../../../../packages/domain/src/osiri";
import type { BrowserProfile } from "../../../server/src/browser.ts";
import { Button, colors, ErrorNotice, Field, Sheet, s, useAction } from "../ui";
import { useWorkspace } from "../workspace";
import { BrowserFrame } from "./browser-frame";
import { useLoad } from "./store";

const text = {
  title: "영시리 브라우저",
  handoff: (reason: string) => `영시리가 넘겼어요 — ${reason}`,
  opening: "페이지를 여는 중…",
  open: "화면 보기",
  close: "접기",
  profile: (name: string) => `프로필: ${name}`,
  profiles: "브라우저 프로필",
  profilesHint:
    "로그인·쿠키는 프로필에 저장돼 다른 대화에서도 이어집니다. 비밀번호는 대화에 쓰지 말고 이 화면에서 직접 입력하세요.",
  using: "쓰는 중",
  use: "이 프로필 쓰기",
  newName: "새 프로필 이름",
  add: "프로필 추가",
  failed: (why: string) => `브라우저를 열지 못했습니다: ${why}`,
  noSession: "아직 열린 페이지가 없습니다",
};

type Profiles = {
  profiles: BrowserProfile[];
  active: string;
  session: { consoleUrl: string; title: string; url: string; holder: "agent" | "user" } | null;
};

export function BrowserToolCard({
  result,
  running,
  reason,
}: {
  result: unknown;
  running: boolean;
  /** browser_handoff 의 사유 — 넘기는 동안 카드 위에 보인다 */
  reason?: string;
}) {
  const { api } = useWorkspace();
  // 실행 중(여는 중·넘긴 채 기다리는 중)엔 펼친다. 끝난 카드는 접어 두고 누르면 지금 화면을 연다
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const shown = open || running;
  const state = useLoad(
    () => api.request<Profiles>("/api/browser-profiles"),
    `${shown}-${picking}`,
  );
  const error =
    result && typeof result === "object" && "error" in result
      ? String((result as { error: unknown }).error)
      : "";
  const page =
    result && typeof result === "object" && "title" in result
      ? (result as { title?: string; url?: string })
      : null;
  const active = state.data?.profiles.find((p) => p.id === state.data?.active);
  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.card,
      }}
    >
      <View style={[s.row, { gap: 8 }]}>
        <Globe size={16} color={colors.muted} />
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>
            {page?.title || text.title}
          </Text>
          {!!page?.url && (
            <Text style={s.small} numberOfLines={1}>
              {page.url}
            </Text>
          )}
        </View>
        {!running && (
          <Button small onPress={() => setOpen(!open)}>
            {open ? text.close : text.open}
          </Button>
        )}
      </View>
      {running && !!reason && (
        <Text style={[s.small, { color: colors.accent, fontWeight: "600" }]}>
          {text.handoff(reason)}
        </Text>
      )}
      <ErrorNotice error={error ? text.failed(error) : ""} />
      {shown && (
        <>
          <ErrorNotice error={state.error ?? ""} />
          {state.data?.session ? (
            <View style={{ height: 520, borderRadius: 12, overflow: "hidden" }}>
              <BrowserFrame url={state.data.session.consoleUrl} />
            </View>
          ) : (
            <Text style={s.small}>{running ? text.opening : text.noSession}</Text>
          )}
          {!!active && (
            <Pressable accessibilityRole="button" onPress={() => setPicking(true)}>
              <Text style={[s.small, { color: colors.accent }]}>{text.profile(active.name)}</Text>
            </Pressable>
          )}
        </>
      )}
      {picking && state.data && (
        <ProfileSheet data={state.data} onClose={() => setPicking(false)} onChanged={state.retry} />
      )}
    </View>
  );
}

function ProfileSheet({
  data,
  onClose,
  onChanged,
}: {
  data: Profiles;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api } = useWorkspace();
  const [name, setName] = useState("");
  const action = useAction();
  return (
    <Sheet title={text.profiles} subtitle={text.profilesHint} onClose={onClose}>
      <View style={{ gap: 8 }}>
        {data.profiles.map((p) => (
          <View key={p.id} style={[s.row, { gap: 8 }]}>
            <Text style={[s.text, { flex: 1 }]}>{p.name}</Text>
            {p.id === data.active ? (
              <Text style={s.small}>{text.using}</Text>
            ) : (
              <Button
                small
                busy={action.busy}
                onPress={() =>
                  action.run(async () => {
                    await api.request(`/api/browser-profiles/${p.id}/use`, {});
                    onChanged();
                  })
                }
              >
                {text.use}
              </Button>
            )}
          </View>
        ))}
        <Field
          label={text.newName}
          value={name}
          maxLength={BROWSER_PROFILE_NAME_MAX}
          onChangeText={setName}
        />
        <Button
          small
          primary
          busy={action.busy}
          disabled={!name.trim()}
          onPress={() =>
            action.run(async () => {
              const made = await api.request<BrowserProfile>("/api/browser-profiles", {
                name: name.trim(),
              });
              await api.request(`/api/browser-profiles/${made.id}/use`, {});
              setName("");
              onChanged();
            })
          }
        >
          {text.add}
        </Button>
        <ErrorNotice error={action.error} />
      </View>
    </Sheet>
  );
}
