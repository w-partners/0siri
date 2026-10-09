// 0Siri 화면 1 · 로그인·온보딩 («0Siri 종합 기획» §03). 서버: apps/server/src/osiri/account-routes.ts · 계약: docs/0siri-api-contract.md
// 결정(마스터): 로그인은 전화번호 + 비밀번호다 — 카카오·이메일 버튼은 두지 않는다. 캐릭터도 이 화면에는 두지 않는다(첫 팀 고용 뒤부터 등장).
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  LOGIN_FAILS_BEFORE_RESET_HINT,
  PASSWORD_MIN,
  PASSWORD_RESET_HINT,
  PERSONAL_TIER_LABEL,
} from "../../../../packages/domain/src/osiri";
import type { Accounts, Profile, PublicUser } from "../../../server/src/osiri/accounts.ts";
import type { Room } from "../../../server/src/osiri/rooms.ts";
import { API_URL, apiBase, type MuseApi, setApiBase } from "../api";
import { ApiError, readApiPayload } from "../api-response";
import { Button, Card, colors, ErrorNotice, Field, fonts, Skeleton, s } from "../ui";
import { useAction, useWide } from "./store";

const text = {
  welcome: "0Siri",
  tagline: "에이전트 팀을 고용하는 플랫폼",
  tiersTitle: "등급 안내",
  // 팀 패키지 줄은 두지 않는다 — 스토어에 입점한 팀이 생기면 그 목록(스토어)이 말한다. 없는 패키지를 여기서 단정하지 않는다
  tiers: [{ name: PERSONAL_TIER_LABEL, unit: "개인 에이전트", count: 1 }],
  people: "명",
  inviteLinkFailed: (reason: string) =>
    `앱을 연 초대 링크를 읽지 못했습니다. 초대 코드를 직접 입력해 주세요: ${reason}`,
  continue: "계속하기",
  inviteToken: "초대 코드",
  inviteTokenPlaceholder: "초대 링크의 마지막 부분",
  inviteHint: "초대 링크로 열면 자동으로 입력됩니다.",
  inviteFilled: "초대 링크에서 자동으로 입력했습니다.",
  noInvite: "초대 코드가 없으면 초대 대기 신청만 할 수 있습니다. 이미 계정이 있으면 로그인하세요.",
  phone: "전화번호",
  phonePlaceholder: "01012345678",
  password: "비밀번호",
  passwordPlaceholder: `${PASSWORD_MIN}자 이상`,
  login: "로그인",
  signup: "초대 코드로 가입하기",
  waitlist: "초대 대기 신청",
  waitlistDone: "초대 대기 신청을 받았습니다. 초대 코드를 받으면 이 화면에 입력해 주세요.",
  reapply:
    "이 초대 코드로는 가입할 수 없습니다. 전화번호를 적고 초대 대기 신청을 누르면 새 초대를 요청할 수 있습니다.",
  required: "전화번호와 비밀번호를 입력해 주세요",
  phoneRequired: "전화번호를 입력해 주세요",
  retry: "다시 시도",
  advanced: "서버 주소 바꾸기",
  server: "서버 주소 (비우면 기본값)",
  serverSaveFailed: (reason: string) => `서버 주소를 저장하지 못했습니다: ${reason}`,
  serverLoadFailed: (reason: string) =>
    `저장된 서버 주소를 읽지 못해 기본 주소로 연결합니다: ${reason}`,
  tokenLoadFailed: (reason: string) => `저장된 로그인 정보를 읽지 못했습니다: ${reason}`,
  tokenSaveFailed: (reason: string) =>
    `로그인 정보를 기기에 저장하지 못했습니다. 앱을 다시 열면 로그인이 필요합니다: ${reason}`,
  tokenClearFailed: (reason: string) => `기기에 남은 로그인 정보를 지우지 못했습니다: ${reason}`,
  serverLogoutFailed: (reason: string) =>
    `이 기기에서는 로그아웃했지만 서버 세션을 끝내지 못했습니다(만료될 때까지 남습니다): ${reason}`,
  stepsTitle: "가입하면 이렇게 진행됩니다",
  steps: [
    { title: "계정 만들기", body: "초대 코드 · 전화번호 · 비밀번호" },
    { title: "사무소 프로필", body: "이름 · 전문 분야 · 지역" },
    { title: "첫 목표 한 줄", body: "예: 상속 분야 GEO 선점" },
  ],
  stepOf: (n: number, total: number) => `${n}/${total}`,
  done: "✓",
  displayName: "이름",
  displayNamePlaceholder: "홍길동 법률사무소",
  specialty: "전문 분야",
  specialtyPlaceholder: "예: 상속 · 가사",
  region: "지역",
  regionPlaceholder: "예: 서울 서초",
  profileRequired: "이름 · 전문 분야 · 지역을 모두 입력해 주세요",
  goal: "첫 목표",
  goalPlaceholder: "상속 분야 GEO 선점",
  goalHint: "한 줄이면 됩니다. 제안 상태로 저장되고, 목표 화면에서 승인하면 시작합니다.",
  goalRequired: "첫 목표를 한 줄 적어 주세요",
  noPersonalRoom: "개인 방을 찾지 못해 목표를 저장할 수 없습니다. 다시 시도해 주세요.",
  next: "저장하고 다음",
  saveGoal: "목표 저장",
  finishedTitle: "준비가 끝났습니다",
  finishedBody: "프로필과 첫 목표를 저장했습니다.",
  start: "시작하기",
  goStore: "스토어에서 팀 고르기",
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 숫자만 남기고 +82 를 0 으로. 검증은 서버(normalizePhone)가 한다. */
export function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("82") ? `0${digits.slice(2)}` : digits;
}

// --- 토큰 보관 --- 웹 localStorage, 네이티브 expo-secure-store(키체인/키스토어).
const TOKEN_KEY = "osiri.token";
const webStorage = Platform.OS === "web" && typeof localStorage !== "undefined";
let memoryToken = "";
// 앱을 켤 때(App 이 loadApiBase → loadToken) 저장소를 못 읽으면 여기 쌓고, 곧바로 뜨는 로그인 화면이 보여 준다.
// 던지지 않는 이유: 시작 경로에서 던지면 화면이 뜨지 않는다 — 대신 기본값으로 가되 그 사실을 사용자에게 알린다.
const startupIssues: string[] = [];
const report = (issue: string) => {
  startupIssues.push(issue);
  console.warn(`[osiri/auth] ${issue}`);
};
/**
 * 쌓인 경고를 꺼내 화면에 보인다(꺼내면 비워진다). 로그인 화면이 뜨면 거기서, 로그인한 채로 켜졌으면 설정 화면이 보인다 —
 * 어느 쪽이든 사용자가 보게 되고 콘솔에만 남지 않는다.
 */
export const takeAuthIssues = () => startupIssues.splice(0).join("\n");
export async function loadToken(): Promise<string> {
  try {
    if (webStorage) return localStorage.getItem(TOKEN_KEY) ?? "";
    return (await SecureStore.getItemAsync(TOKEN_KEY)) ?? memoryToken;
  } catch (e) {
    report(text.tokenLoadFailed(message(e)));
    return memoryToken;
  }
}
/** 저장 실패는 던진다 — 토큰은 메모리에 남아 이번 실행은 쓸 수 있으므로, 부르는 쪽이 알리고 계속할지 정한다. */
export async function saveToken(token: string): Promise<void> {
  memoryToken = token;
  if (webStorage) localStorage.setItem(TOKEN_KEY, token);
  else await SecureStore.setItemAsync(TOKEN_KEY, token);
}
export async function clearToken(): Promise<void> {
  memoryToken = "";
  try {
    if (webStorage) localStorage.removeItem(TOKEN_KEY);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch (e) {
    throw new Error(text.tokenClearFailed(message(e)));
  }
}
// 서버 주소 (빌드 기본값 대신 쓸 때만 저장)
const API_KEY = "osiri.apiUrl";
export async function loadApiBase(): Promise<void> {
  try {
    const saved = webStorage
      ? (localStorage.getItem(API_KEY) ?? "")
      : ((await SecureStore.getItemAsync(API_KEY)) ?? "");
    setApiBase(saved);
  } catch (e) {
    report(text.serverLoadFailed(message(e)));
  }
}
export async function saveApiBase(url: string): Promise<void> {
  setApiBase(url);
  try {
    if (webStorage) {
      if (url) localStorage.setItem(API_KEY, url);
      else localStorage.removeItem(API_KEY);
    } else if (url) await SecureStore.setItemAsync(API_KEY, url);
    else await SecureStore.deleteItemAsync(API_KEY);
  } catch (e) {
    throw new Error(text.serverSaveFailed(message(e)));
  }
}
/**
 * 기기의 토큰은 항상 지운다(못 지우면 던진다 — 로그아웃이 안 된 것이다).
 * 서버 세션을 못 끝낸 경우는 로그아웃 자체는 됐으므로 던지지 않고 경고 문장을 돌려준다("" = 깨끗이 끝남) — 부르는 쪽이 보여 준다.
 */
export async function logout(api: MuseApi): Promise<string> {
  let warning = "";
  try {
    await api.request("/api/auth/logout", {});
  } catch (e) {
    warning = text.serverLogoutFailed(message(e));
    report(warning); // 로그아웃 뒤에 뜨는 로그인 화면이 이 경고를 보인다
  }
  await clearToken();
  return warning;
}

// --- /api/me ---
/** `GET /me` — 서버 account-routes.ts 의 `app.get("/me")` 핸들러가 만든다(내보낸 타입이 없어 여기 한 번 적는다). */
export type Me = { user: PublicUser; profile: Profile };
export function useMe(api: MuseApi) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setMe(await api.request<Me>("/api/me"));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { me, loading, error, reload };
}

// --- 공용 조각 ---
const page = { flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24 } as const;

/** 온보딩 3단계 표시. current = 지금 하는 단계(0부터), 그 앞은 ✓. */
function Steps({ current, title }: { current: number; title?: string }) {
  return (
    <View style={{ gap: 10 }}>
      {title ? <Text style={s.label}>{title}</Text> : null}
      {text.steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <View
            key={step.title}
            accessibilityState={{ selected: active, checked: done }}
            style={[
              s.card,
              { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
              active && { borderColor: colors.accent, backgroundColor: colors.accentSoft },
            ]}
          >
            <Text
              style={{
                fontFamily: fonts.mono,
                fontSize: 13,
                fontWeight: "600",
                color: done ? colors.ok : active ? colors.accent : colors.muted,
              }}
            >
              {text.stepOf(i + 1, text.steps.length)}
            </Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.heading}>{step.title}</Text>
              <Text style={s.small}>{step.body}</Text>
            </View>
            {done ? (
              <Text style={{ color: colors.ok, fontSize: 16, fontWeight: "700" }}>{text.done}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function TierCard() {
  return (
    <Card style={{ width: "100%", gap: 8 }}>
      <Text style={s.label}>{text.tiersTitle}</Text>
      {text.tiers.map((tier) => (
        <View key={tier.name} style={s.between}>
          <Text style={[s.text, { fontWeight: "600" }]}>{tier.name}</Text>
          <Text style={s.muted}>
            {tier.unit} <Text style={{ fontFamily: fonts.mono }}>{tier.count}</Text>
            {text.people}
          </Text>
        </View>
      ))}
    </Card>
  );
}

// --- 로그인 ---
/** `POST /auth/login` · `/auth/invite/accept` 의 응답 — 서버 `Accounts.login()` */
type AuthResult = Awaited<ReturnType<Accounts["login"]>>;
/** 인증 전 요청. 실패는 ApiError(서버가 준 사유 문장 + 상태 코드)로 온다. */
async function publicPost<T>(path: string, body: unknown) {
  const response = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiPayload<T>(response);
}
/** 초대 링크 `…/?invite=<code>` (계약). 서버가 지금 내는 `/invite/<code>` 꼴도 같이 읽는다 (앱 링크 `osiri://invite/<code>` 포함). */
function inviteFromUrl(url: string) {
  const code = /[?&]invite=([^&#]+)/.exec(url)?.[1] ?? /\/invite\/([^/?#]+)/.exec(url)?.[1] ?? "";
  try {
    return decodeURIComponent(code).trim();
  } catch {
    // ponytail: %-인코딩이 깨진 링크 — 받은 글자 그대로 입력란에 넣는다. 틀린 코드면 가입 때 서버가 사유를 말한다
    return code.trim();
  }
}
/** 웹은 주소창에서 바로 읽는다. 네이티브는 앱을 연 링크를 비동기로 받아야 해서 LoginScreen 의 effect 가 읽는다. */
const inviteFromLocation = () =>
  Platform.OS === "web" && typeof location !== "undefined" ? inviteFromUrl(location.href) : "";

type Intent = "login" | "signup" | "waitlist";

export function LoginScreen({ onToken }: { onToken: (token: string) => void }) {
  const wide = useWide();
  const [linkInvite, setLinkInvite] = useState(inviteFromLocation);
  const [inviteToken, setInviteToken] = useState(linkInvite);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<Intent | "">("");
  const [error, setError] = useState(takeAuthIssues);
  const [notice, setNotice] = useState("");
  const [inviteRejected, setInviteRejected] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [server, setServer] = useState(apiBase() === API_URL ? "" : apiBase());
  const [loginFails, setLoginFails] = useState(0);
  // 로그인은 됐는데 토큰을 기기에 저장하지 못한 경우 — 사유를 읽고 [계속하기] 를 눌러야 넘어간다
  const [unsavedToken, setUnsavedToken] = useState("");

  // 네이티브 앱: 초대 링크로 앱이 열렸으면 그 코드를 채운다 (웹은 위에서 주소창을 읽었다)
  useEffect(() => {
    if (Platform.OS === "web") return;
    Linking.getInitialURL().then(
      (url) => {
        const code = url ? inviteFromUrl(url) : "";
        if (!code) return;
        setLinkInvite(code);
        setInviteToken((typed) => typed || code); // 이미 입력한 것이 있으면 덮지 않는다
      },
      (e) => setError(text.inviteLinkFailed(message(e))),
    );
  }, []);

  const token = inviteToken.trim();
  const submit = async (intent: Intent) => {
    const normalized = normalizePhone(phone);
    if (!normalized) return setError(text.phoneRequired);
    if (intent !== "waitlist" && !password) return setError(text.required);
    setBusy(intent);
    setError("");
    setNotice("");
    try {
      await saveApiBase(server.trim());
      if (intent === "waitlist") {
        await publicPost<unknown>("/api/auth/waitlist", { phone: normalized });
        setNotice(text.waitlistDone);
        return;
      }
      const result =
        intent === "signup"
          ? await publicPost<AuthResult>("/api/auth/invite/accept", {
              token,
              phone: normalized,
              password,
            })
          : await publicPost<AuthResult>("/api/auth/login", { phone: normalized, password });
      setInviteRejected(false);
      try {
        await saveToken(result.token);
      } catch (e) {
        // 로그인은 됐다 — 이번 실행은 메모리의 토큰으로 계속할 수 있다. 다음 실행에 다시 로그인해야 함을
        // 이 화면에 보이고, 사용자가 [계속하기] 를 누르면 넘어간다(바로 넘기면 이 화면이 사라져 아무도 못 본다).
        setError(text.tokenSaveFailed(message(e)));
        setUnsavedToken(result.token);
        return;
      }
      onToken(result.token);
    } catch (e) {
      if (intent === "signup") setInviteRejected(e instanceof ApiError && e.status === 400);
      // 비밀번호가 틀린 것(401)만 센다 — 네트워크·서버 오류는 비밀번호 문제가 아니다
      if (intent === "login" && e instanceof ApiError && e.status === 401)
        setLoginFails((n) => n + 1);
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const action = (intent: Intent, label: string, primary: boolean) => (
    <Button
      key={intent}
      primary={primary}
      busy={busy === intent}
      disabled={!!busy}
      onPress={() => void submit(intent)}
    >
      {label}
    </Button>
  );

  const loginCard = (
    <View style={{ width: "100%", maxWidth: 420, gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text style={[s.title, { fontSize: 32 }]}>{text.welcome}</Text>
        <Text style={s.muted}>{text.tagline}</Text>
      </View>
      <TierCard />
      <Card style={{ width: "100%" }}>
        <ErrorNotice error={error} />
        {unsavedToken ? (
          <View style={{ marginBottom: 12 }}>
            <Button primary onPress={() => onToken(unsavedToken)}>
              {text.continue}
            </Button>
          </View>
        ) : null}
        {loginFails >= LOGIN_FAILS_BEFORE_RESET_HINT ? (
          <Text accessibilityRole="alert" style={[s.text, { marginBottom: 12 }]}>
            {PASSWORD_RESET_HINT}
          </Text>
        ) : null}
        {inviteRejected ? (
          <Text style={[s.muted, { marginBottom: 12 }]}>{text.reapply}</Text>
        ) : null}
        {notice ? (
          <View accessibilityRole="alert" style={[s.error, { backgroundColor: colors.okBg }]}>
            <Text style={[s.text, { color: colors.ok }]}>{notice}</Text>
          </View>
        ) : null}
        <Field
          label={text.inviteToken}
          value={inviteToken}
          onChangeText={(v) => {
            setInviteToken(v);
            setInviteRejected(false);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={text.inviteTokenPlaceholder}
        />
        <Text style={[s.small, { marginTop: -8, marginBottom: 16 }]}>
          {linkInvite && token === linkInvite
            ? text.inviteFilled
            : token
              ? text.inviteHint
              : text.noInvite}
        </Text>
        <Field
          label={text.phone}
          value={phone}
          onChangeText={(v) => setPhone(v.replace(/[^\d+]/g, ""))}
          keyboardType="phone-pad"
          autoComplete="tel"
          placeholder={text.phonePlaceholder}
        />
        <Field
          label={text.password}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder={text.passwordPlaceholder}
          onSubmitEditing={() => void submit(token ? "signup" : "login")}
        />
        <View style={{ gap: 8 }}>
          {token ? action("signup", text.signup, true) : null}
          {action("login", text.login, !token)}
          {!token || inviteRejected ? action("waitlist", text.waitlist, false) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setAdvanced(!advanced)}
          style={{ alignSelf: "center", paddingVertical: 12 }}
        >
          <Text style={[s.small, { textDecorationLine: "underline" }]}>{text.advanced}</Text>
        </Pressable>
        {advanced ? (
          <Field
            label={text.server}
            value={server}
            onChangeText={setServer}
            autoCapitalize="none"
            keyboardType="url"
            placeholder={API_URL}
          />
        ) : null}
      </Card>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={page}>
        {wide ? (
          // 웹 — 좌: 로그인 카드 / 우: 온보딩 단계
          <View style={{ flexDirection: "row", gap: 40, alignItems: "flex-start" }}>
            {loginCard}
            <View style={{ width: 360, paddingTop: 8 }}>
              <Steps current={0} title={text.stepsTitle} />
            </View>
          </View>
        ) : (
          loginCard
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// --- 온보딩 3단계: 1/3 계정 만들기 ✓ → 2/3 사무소 프로필 → 3/3 첫 목표 한 줄 ---
const PROFILE_STEP = 1;
const GOAL_STEP = 2;
const FINISHED = text.steps.length;
/** 단계 제목 — 스토어의 구독 뒤 온보딩(화면 6)이 같은 문구를 쓴다 */
export const ONBOARDING_TITLES = {
  profile: text.steps[PROFILE_STEP].title,
  goal: text.steps[GOAL_STEP].title,
};
export const profileComplete = (profile: Profile) =>
  !!(profile.displayName && profile.specialty && profile.region);

/** 2/3 사무소 프로필 — 저장해 둔 값을 채워 보이고 `PATCH /me/profile` 로 저장한다. 화면 1 과 화면 6(구독 뒤)이 같이 쓴다. */
export function ProfileStep({
  api,
  profile,
  onSaved,
}: {
  api: MuseApi;
  profile: Profile;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [specialty, setSpecialty] = useState(profile.specialty ?? "");
  const [region, setRegion] = useState(profile.region ?? "");
  const [invalid, setInvalid] = useState("");
  const act = useAction();
  const save = () => {
    const body = {
      displayName: displayName.trim(),
      specialty: specialty.trim(),
      region: region.trim(),
    };
    if (!body.displayName || !body.specialty || !body.region)
      return setInvalid(text.profileRequired);
    setInvalid("");
    void act.run(async () => {
      await api.request("/api/me/profile", body, "PATCH");
      onSaved();
    });
  };
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={invalid || act.error} />
      <View>
        <Field
          label={text.displayName}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder={text.displayNamePlaceholder}
        />
        <Field
          label={text.specialty}
          value={specialty}
          onChangeText={setSpecialty}
          placeholder={text.specialtyPlaceholder}
        />
        <Field
          label={text.region}
          value={region}
          onChangeText={setRegion}
          placeholder={text.regionPlaceholder}
          onSubmitEditing={save}
        />
      </View>
      <Button primary busy={act.busy} onPress={save}>
        {act.error ? text.retry : text.next}
      </Button>
    </View>
  );
}

/** 3/3 첫 목표 한 줄 → `POST /goals`(제안 상태). 어느 방의 목표인지는 부르는 쪽이 정한다(개인 방 / 방금 구독한 팀 방). */
export function GoalStep({
  api,
  roomId,
  after,
  onSaved,
}: {
  api: MuseApi;
  roomId: () => Promise<string> | string;
  /** 목표 저장 뒤에 이어서 할 일. 여기서 실패하면 [다시 시도] 가 목표를 또 만들지 않고 이 일부터 잇는다 */
  after?: () => Promise<void>;
  onSaved: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [invalid, setInvalid] = useState("");
  const act = useAction();
  const goalSaved = useRef(false);
  const save = () => {
    const title = goal.trim();
    if (!title) return setInvalid(text.goalRequired);
    setInvalid("");
    void act.run(async () => {
      if (!goalSaved.current) {
        await api.request("/api/goals", { roomId: await roomId(), title });
        goalSaved.current = true;
      }
      await after?.();
      onSaved();
    });
  };
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={invalid || act.error} />
      <View>
        <Field
          label={text.goal}
          value={goal}
          onChangeText={setGoal}
          placeholder={text.goalPlaceholder}
          onSubmitEditing={save}
        />
        <Text style={[s.small, { marginTop: -8 }]}>{text.goalHint}</Text>
      </View>
      <Button primary busy={act.busy} onPress={save}>
        {act.error ? text.retry : text.saveGoal}
      </Button>
    </View>
  );
}

export function Onboarding({
  api,
  onDone,
  onGoStore,
}: {
  api: MuseApi;
  onDone: () => void;
  onGoStore: () => void;
}) {
  const wide = useWide();
  const { me, loading, error: meError, reload } = useMe(api);
  const [step, setStep] = useState(PROFILE_STEP);
  const [hasTeam, setHasTeam] = useState(false);
  const seeded = useRef(false);

  // 중간에 나갔다 돌아왔는데 프로필이 다 채워져 있으면 3/3 부터 잇는다.
  useEffect(() => {
    if (!me || seeded.current) return;
    seeded.current = true;
    if (profileComplete(me.profile)) setStep(GOAL_STEP);
  }, [me]);

  const personalRoom = async () => {
    const rooms = await api.request<Room[]>("/api/rooms");
    const personal = rooms.find((room) => room.packageId === null);
    if (!personal) throw new Error(text.noPersonalRoom);
    return personal.id;
  };
  // onboardedAt 은 마지막 단계에서만 찍는다 — 중간에 나가면 다음 실행 때 온보딩이 다시 뜬다.
  const finish = async () => {
    await api.request("/api/me/profile", { onboardedAt: new Date().toISOString() }, "PATCH");
    // 끝 화면의 갈림: 이미 고용한 팀 방이 있으면 [시작하기] 만, 없으면 스토어가 주 버튼이다
    const rooms = await api.request<Room[]>("/api/rooms");
    setHasTeam(rooms.some((room) => room.packageId !== null && !room.archived));
  };

  const form = loading ? (
    <Skeleton rows={3} height={56} />
  ) : !me ? (
    <View style={{ gap: 10 }}>
      <ErrorNotice error={meError} />
      <Button onPress={() => void reload()}>{text.retry}</Button>
    </View>
  ) : step === FINISHED ? (
    <View style={{ gap: 12 }}>
      <Text style={s.title}>{text.finishedTitle}</Text>
      <Text style={s.muted}>{text.finishedBody}</Text>
      {hasTeam ? (
        <Button primary onPress={onDone}>
          {text.start}
        </Button>
      ) : (
        <>
          <Button
            primary
            onPress={() => {
              onGoStore();
              onDone();
            }}
          >
            {text.goStore}
          </Button>
          <Button onPress={onDone}>{text.start}</Button>
        </>
      )}
    </View>
  ) : (
    <View style={{ gap: 12 }}>
      <Text style={[s.label, { fontFamily: fonts.mono }]}>
        {text.stepOf(step + 1, text.steps.length)}
      </Text>
      <Text style={s.title}>{text.steps[step].title}</Text>
      {step === PROFILE_STEP ? (
        <ProfileStep api={api} profile={me.profile} onSaved={() => setStep(GOAL_STEP)} />
      ) : (
        <GoalStep
          api={api}
          roomId={personalRoom}
          after={finish}
          onSaved={() => setStep(FINISHED)}
        />
      )}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={page}>
        <View
          style={{
            width: "100%",
            maxWidth: wide ? 840 : 420,
            flexDirection: wide ? "row" : "column",
            alignItems: wide ? "flex-start" : "stretch",
            gap: wide ? 40 : 18,
          }}
        >
          <View style={wide ? { width: 360 } : null}>
            <Steps current={step} />
          </View>
          <Card style={{ flex: wide ? 1 : undefined }}>{form}</Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
