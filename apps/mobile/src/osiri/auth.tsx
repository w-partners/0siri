// 0Siri 화면 1 · 로그인·온보딩 («0Siri 종합 기획» §03). 서버: apps/server/src/osiri/account-routes.ts · 계약: docs/0siri-api-contract.md
// 결정(마스터): 로그인은 전화번호 + 비밀번호다 — 카카오·이메일 버튼은 두지 않는다. 캐릭터도 이 화면에는 두지 않는다(첫 팀 고용 뒤부터 등장).
// 결정(마스터 2026-10-10): 초대는 전화번호로만 한다 — 초대 코드 입력란은 없다. 초대 링크는 «전화번호 확인 · 비밀번호 등록» 화면을 열고,
// 초대해 줄 사람이 없으면 «초대 대기 신청» 화면에서 사용 목적을 적어 신청한다. 서버 주소는 빌드가 정한다(바꾸는 화면 없음).
import * as SecureStore from "expo-secure-store";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  LOGIN_FAILS_BEFORE_RESET_HINT,
  PASSWORD_MIN,
  PASSWORD_RESET_HINT,
  PERSONAL_TIER_LABEL,
  WAITLIST_PURPOSE_MAX,
  WAITLIST_PURPOSE_MIN,
} from "../../../../packages/domain/src/osiri";
import type { MeResponse } from "../../../server/src/osiri/account-routes.ts";
import type { Accounts } from "../../../server/src/osiri/accounts.ts";
import type { Room } from "../../../server/src/osiri/rooms.ts";
import { apiBase, type MuseApi } from "../api";
import { ApiError, readApiPayload } from "../api-response";
import { Button, Card, colors, ErrorNotice, Field, fonts, Skeleton, s, useWide } from "../ui";
import {
  GOAL_STEP,
  GoalStep,
  ONBOARDING_STEPS,
  PROFILE_STEP,
  ProfileStep,
  profileComplete,
} from "./onboarding-steps";

const text = {
  welcome: "0Siri",
  tagline: "에이전트 팀을 고용하는 플랫폼",
  tiersTitle: "등급 안내",
  // 팀 패키지 줄은 두지 않는다 — 스토어에 입점한 팀이 생기면 그 목록(스토어)이 말한다. 없는 패키지를 여기서 단정하지 않는다
  tiers: [{ name: PERSONAL_TIER_LABEL, unit: "개인 에이전트", count: 1 }],
  people: "명",
  inviteLinkFailed: (reason: string) =>
    `앱을 연 초대 링크를 읽지 못했습니다. 받은 초대 링크를 다시 눌러 주세요: ${reason}`,
  continue: "계속하기",
  phone: "전화번호",
  phonePlaceholder: "01012345678",
  password: "비밀번호",
  passwordPlaceholder: `${PASSWORD_MIN}자 이상`,
  passwordConfirm: "비밀번호 확인",
  passwordConfirmPlaceholder: "한 번 더 입력",
  passwordShort: `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다`,
  passwordMismatch: "비밀번호와 비밀번호 확인이 서로 다릅니다",
  login: "로그인",
  required: "전화번호와 비밀번호를 입력해 주세요",
  phoneRequired: "전화번호를 입력해 주세요",
  retry: "다시 시도",
  toLogin: "로그인 화면으로",
  // 초대 대기 신청
  noInviter: "초대해 줄 사람이 없나요?",
  waitlist: "초대 대기 신청",
  waitlistIntro:
    "초대는 이미 쓰고 있는 사람이 전화번호로 보냅니다. 초대해 줄 사람이 없으면 여기서 신청하세요 — 관리자가 사용 목적을 읽고 연결해 드립니다.",
  purpose: "사용 목적",
  purposeGuide:
    "무엇에, 어떻게 쓰려는지 구체적으로 적어 주세요. 하는 일, 맡기고 싶은 작업, 얼마나 자주 쓸지를 적으면 검토가 빨라집니다.",
  purposePlaceholder:
    "예: 세무사 사무소를 운영합니다. 매주 고객에게 보내는 세무 일정 안내문 초안과 상담 문의 답변 초안을 맡기려고 합니다.",
  purposeCount: (n: number) => `${n}/${WAITLIST_PURPOSE_MIN}자 이상`,
  purposeShort: (left: number) => `${left}자 더 적어 주세요`,
  purposeOk: "충분합니다",
  waitlistSubmit: "신청하기",
  waitlistDoneTitle: "신청을 받았습니다",
  waitlistDoneBody:
    "관리자가 사용 목적을 검토한 뒤 연결해 드립니다. 연결되면 방금 적은 전화번호와 비밀번호로 로그인할 수 있습니다.",
  waitlistDoneHint: "검토가 끝나기 전에 로그인하면 지금 어떤 상태인지 로그인 화면이 알려 드립니다.",
  // 초대 수락
  inviteTitle: "전화번호 확인 · 비밀번호 등록",
  invitedBy: (name: string) => `${name} 님이 초대했습니다`,
  invitedPhone: "초대받은 전화번호",
  inviteGuideAnyPhone: "앞으로 로그인에 쓸 전화번호와 비밀번호를 정해 주세요.",
  inviteGuide:
    "초대받은 전화번호 전체를 입력해 본인임을 확인하고, 앞으로 쓸 비밀번호를 정해 주세요.",
  inviteSubmit: "확인하고 시작하기",
  tokenLoadFailed: (reason: string) => `저장된 로그인 정보를 읽지 못했습니다: ${reason}`,
  tokenSaveFailed: (reason: string) =>
    `로그인 정보를 기기에 저장하지 못했습니다. 앱을 다시 열면 로그인이 필요합니다: ${reason}`,
  tokenClearFailed: (reason: string) => `기기에 남은 로그인 정보를 지우지 못했습니다: ${reason}`,
  serverLogoutFailed: (reason: string) =>
    `이 기기에서는 로그아웃했지만 서버 세션을 끝내지 못했습니다(만료될 때까지 남습니다): ${reason}`,
  stepsTitle: "가입하면 이렇게 진행됩니다",
  steps: ONBOARDING_STEPS,
  stepOf: (n: number, total: number) => `${n}/${total}`,
  done: "✓",
  noPersonalRoom: "개인 방을 찾지 못해 목표를 저장할 수 없습니다. 다시 시도해 주세요.",
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
// 앱을 켤 때(App 이 loadToken) 저장소를 못 읽으면 여기 쌓고, 곧바로 뜨는 로그인 화면이 보여 준다.
// 던지지 않는 이유: 시작 경로에서 던지면 화면이 뜨지 않는다 — 대신 로그인 화면으로 가되 그 사실을 사용자에게 알린다.
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
/**
 * 기기의 토큰은 항상 지운다(못 지우면 던진다 — 로그아웃이 안 된 것이다).
 * 서버 세션을 못 끝낸 경우는 로그아웃 자체는 됐으므로 던지지 않고 경고를 쌓아 둔다 — 로그아웃 뒤에 뜨는 로그인 화면이 보인다(takeAuthIssues).
 */
export async function logout(api: MuseApi): Promise<void> {
  try {
    await api.request("/api/auth/logout", {});
  } catch (e) {
    report(text.serverLogoutFailed(message(e)));
  }
  await clearToken();
}

// --- /api/me ---
export function useMe(api: MuseApi) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setMe(await api.request<MeResponse>("/api/me"));
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
/** 키보드가 올라온 뒤 포커스된 입력란 아래로 남길 여백 — 바로 아래 버튼·안내가 같이 보이게 */
const KEYBOARD_GAP = 96;

/**
 * 로그인 전 화면과 온보딩의 공통 틀 — 키보드가 입력란을 가리지 않게 한다.
 * 안드로이드(엣지-투-엣지)는 키보드가 창을 줄이지 않아 입력란을 덮는다. 그래서 키보드 높이만큼 아래를 채우고
 * (KeyboardAvoidingView «padding»), 키보드가 다 올라오면 포커스된 입력란을 그 위로 스크롤한다.
 */
function KeyboardPage({ children }: { children: ReactNode }) {
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      const input = TextInput.State.currentlyFocusedInput();
      if (input)
        scroll.current?.scrollResponderScrollNativeHandleToKeyboard(input, KEYBOARD_GAP, true);
    });
    return () => shown.remove();
  }, []);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "web" ? undefined : "padding"}
      >
        <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={page}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

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

// 기획 화면 1 의 구성 요소 «등급 안내 카드» — 초대와 무관하게 가입하면 받는 등급을 말한다
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

function PhoneField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field
      label={text.phone}
      value={value}
      onChangeText={(v) => onChange(v.replace(/[^\d+]/g, ""))}
      keyboardType="phone-pad"
      autoComplete="tel"
      placeholder={text.phonePlaceholder}
    />
  );
}

/** 새 비밀번호 + 확인 (초대 수락 · 초대 대기 신청). */
function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  onSubmit,
}: {
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  onSubmit?: () => void;
}) {
  return (
    <>
      <Field
        label={text.password}
        value={password}
        onChangeText={onPassword}
        secureTextEntry
        autoComplete="new-password"
        placeholder={text.passwordPlaceholder}
      />
      <Field
        label={text.passwordConfirm}
        value={confirm}
        onChangeText={onConfirm}
        secureTextEntry
        autoComplete="new-password"
        placeholder={text.passwordConfirmPlaceholder}
        onSubmitEditing={onSubmit}
      />
    </>
  );
}
/** 새 계정 입력의 화면 쪽 검사 — 틀리면 사유 문장, 맞으면 "". 전화번호 형식·중복은 서버가 말한다. */
function newAccountProblem(phone: string, password: string, confirm: string) {
  if (!normalizePhone(phone)) return text.phoneRequired;
  if (password.length < PASSWORD_MIN) return text.passwordShort;
  if (password !== confirm) return text.passwordMismatch;
  return "";
}

function BackToLogin({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ alignSelf: "center", paddingVertical: 12 }}
    >
      <Text style={[s.small, { textDecorationLine: "underline" }]}>{text.toLogin}</Text>
    </Pressable>
  );
}

// --- 인증 전 요청 ---
/** `POST /auth/login` · `/auth/invite/accept` 의 응답 — 서버 `Accounts.login()` */
type AuthResult = Awaited<ReturnType<Accounts["login"]>>;
/** `GET /auth/invite/:token` — 서버 `Accounts.previewInvite()`. 이름·번호가 없는 초대는 그 값이 null 이다 */
type InvitePreview = Awaited<ReturnType<Accounts["previewInvite"]>>;
/** 실패는 ApiError(서버가 준 사유 문장 + 상태 코드)로 온다. */
async function publicRequest<T>(path: string, body?: unknown) {
  const response = await fetch(`${apiBase()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readApiPayload<T>(response);
}
/** 초대 링크 `https://<host>/invite/<token>` · 앱 링크 `osiri://invite/<token>`. 옛 `…/?invite=<token>` 꼴도 같이 읽는다. */
function inviteFromUrl(url: string) {
  const code = /[?&]invite=([^&#]+)/.exec(url)?.[1] ?? /\/invite\/([^/?#]+)/.exec(url)?.[1] ?? "";
  try {
    return decodeURIComponent(code).trim();
  } catch {
    // ponytail: %-인코딩이 깨진 링크 — 받은 글자 그대로 서버에 묻는다. 틀린 토큰이면 초대 화면이 서버의 사유를 보인다
    return code.trim();
  }
}
/** 웹은 주소창에서 바로 읽는다. 네이티브는 앱을 연 링크를 비동기로 받아야 해서 AuthScreens 의 effect 가 읽는다. */
const inviteFromLocation = () =>
  Platform.OS === "web" && typeof location !== "undefined" ? inviteFromUrl(location.href) : "";

/**
 * 로그인 세션을 기기에 저장하고 앱으로 넘긴다. 저장에 실패해도 로그인은 됐다 — 이번 실행은 메모리의 토큰으로 계속할 수 있으므로
 * 사유를 보이고 [계속하기] 를 눌러야 넘어간다(바로 넘기면 이 화면이 사라져 아무도 못 본다).
 */
function useSignIn(onToken: (token: string) => void) {
  const [unsaved, setUnsaved] = useState({ token: "", reason: "" });
  const signIn = async (token: string) => {
    try {
      await saveToken(token);
    } catch (e) {
      setUnsaved({ token, reason: text.tokenSaveFailed(message(e)) });
      return;
    }
    onToken(token);
  };
  const pending = unsaved.token ? (
    <View style={{ marginBottom: 12 }}>
      <ErrorNotice error={unsaved.reason} />
      <Button primary onPress={() => onToken(unsaved.token)}>
        {text.continue}
      </Button>
    </View>
  ) : null;
  return { signIn, pending };
}

// --- 로그인 전 화면 3개: 로그인 · 초대 수락(초대 링크로 열렸을 때) · 초대 대기 신청 ---
export function AuthScreens({ onToken }: { onToken: (token: string) => void }) {
  const [invite, setInvite] = useState(inviteFromLocation);
  const [waitlist, setWaitlist] = useState(false);
  const [linkError, setLinkError] = useState("");

  // 네이티브 앱: 초대 링크로 앱이 열렸거나, 켜져 있는 동안 초대 링크를 눌렀을 때 (웹은 위에서 주소창을 읽었다)
  useEffect(() => {
    if (Platform.OS === "web") return;
    const open = (url: string | null) => {
      const token = url ? inviteFromUrl(url) : "";
      if (token) setInvite(token);
    };
    Linking.getInitialURL().then(open, (e) => setLinkError(text.inviteLinkFailed(message(e))));
    const sub = Linking.addEventListener("url", (event) => open(event.url));
    return () => sub.remove();
  }, []);

  const toLogin = useCallback(() => {
    setInvite("");
    setWaitlist(false);
    // 웹: 주소에 초대 토큰이 남아 있으면 새로 고칠 때 초대 화면이 다시 뜬다
    if (Platform.OS === "web" && typeof history !== "undefined" && location.pathname !== "/")
      history.replaceState(null, "", "/");
  }, []);
  // 안드로이드 뒤로 버튼: 초대·신청 화면에서는 앱을 닫지 않고 로그인 화면으로 돌아간다
  const away = !!invite || waitlist;
  useEffect(() => {
    if (!away) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      toLogin();
      return true;
    });
    return () => sub.remove();
  }, [away, toLogin]);

  if (invite)
    return <InviteAcceptScreen key={invite} token={invite} onToken={onToken} onBack={toLogin} />;
  if (waitlist) return <WaitlistScreen onBack={toLogin} />;
  return (
    <LoginScreen onToken={onToken} onWaitlist={() => setWaitlist(true)} linkError={linkError} />
  );
}

function LoginScreen({
  onToken,
  onWaitlist,
  linkError,
}: {
  onToken: (token: string) => void;
  onWaitlist: () => void;
  linkError: string;
}) {
  const wide = useWide();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(takeAuthIssues);
  const [loginFails, setLoginFails] = useState(0);
  const { signIn, pending } = useSignIn(onToken);

  const submit = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized || !password) return setError(text.required);
    setBusy(true);
    setError("");
    try {
      const result = await publicRequest<AuthResult>("/api/auth/login", {
        phone: normalized,
        password,
      });
      await signIn(result.token);
    } catch (e) {
      // 비밀번호가 틀린 것(401)만 센다 — 네트워크·서버 오류는 비밀번호 문제가 아니다.
      // 검토 중·반려된 신청자(403)는 서버가 준 문장이 그대로 보인다
      if (e instanceof ApiError && e.status === 401) setLoginFails((n) => n + 1);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const loginCard = (
    <View style={{ width: "100%", maxWidth: 420, gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text style={[s.title, { fontSize: 32 }]}>{text.welcome}</Text>
        <Text style={s.muted}>{text.tagline}</Text>
      </View>
      <TierCard />
      <Card style={{ width: "100%" }}>
        <ErrorNotice error={linkError} />
        <ErrorNotice error={error} />
        {pending}
        {loginFails >= LOGIN_FAILS_BEFORE_RESET_HINT ? (
          <Text accessibilityRole="alert" style={[s.text, { marginBottom: 12 }]}>
            {PASSWORD_RESET_HINT}
          </Text>
        ) : null}
        <PhoneField value={phone} onChange={setPhone} />
        <Field
          label={text.password}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          placeholder={text.passwordPlaceholder}
          onSubmitEditing={() => void submit()}
        />
        <Button primary busy={busy} onPress={() => void submit()}>
          {text.login}
        </Button>
        <Pressable
          accessibilityRole="link"
          onPress={onWaitlist}
          style={{ alignSelf: "center", paddingVertical: 14 }}
        >
          <Text style={s.small}>
            {text.noInviter}{" "}
            <Text style={{ color: colors.accent, textDecorationLine: "underline" }}>
              {text.waitlist}
            </Text>
          </Text>
        </Pressable>
      </Card>
    </View>
  );

  return (
    <KeyboardPage>
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
    </KeyboardPage>
  );
}

// --- 초대 수락: 전화번호 확인 · 비밀번호 등록 ---
function InviteAcceptScreen({
  token,
  onToken,
  onBack,
}: {
  token: string;
  onToken: (token: string) => void;
  onBack: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview>();
  const [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { signIn, pending } = useSignIn(onToken);

  // attempt 는 [다시 시도] 가 같은 토큰을 다시 묻게 하는 값이다
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setPreviewError("");
    publicRequest<InvitePreview>(`/api/auth/invite/${encodeURIComponent(token)}`).then(
      (data) => live && setPreview(data),
      (e) => live && setPreviewError(message(e)), // 만료·사용됨·없는 초대 — 서버 문장 그대로
    );
    return () => {
      live = false;
    };
  }, [token, attempt]);

  const submit = async () => {
    const problem = newAccountProblem(phone, password, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      const result = await publicRequest<AuthResult>("/api/auth/invite/accept", {
        token,
        phone: normalizePhone(phone),
        password,
      });
      await signIn(result.token);
    } catch (e) {
      setError(message(e)); // 전화번호 불일치·만료·사용됨 — 서버 문장 그대로
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardPage>
      <View style={{ width: "100%", maxWidth: 420, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Text style={[s.title, { fontSize: 32 }]}>{text.welcome}</Text>
          <Text style={s.heading}>{text.inviteTitle}</Text>
        </View>
        <Card style={{ width: "100%" }}>
          {previewError ? (
            <View style={{ gap: 10 }}>
              <ErrorNotice error={previewError} />
              <Button onPress={() => setAttempt((n) => n + 1)}>{text.retry}</Button>
            </View>
          ) : !preview ? (
            <Skeleton rows={3} height={56} />
          ) : (
            <>
              <View style={{ gap: 6, marginBottom: 16 }}>
                {/* 이름·번호가 없는 초대는 그 줄을 두지 않는다 — 없는 값을 지어내 채우지 않는다 */}
                {preview.inviterName === null ? null : (
                  <Text style={[s.text, { fontWeight: "600" }]}>
                    {text.invitedBy(preview.inviterName)}
                  </Text>
                )}
                {preview.phoneHint === null ? null : (
                  <View style={s.between}>
                    <Text style={s.small}>{text.invitedPhone}</Text>
                    <Text style={[s.text, { fontFamily: fonts.mono }]}>{preview.phoneHint}</Text>
                  </View>
                )}
                <Text style={s.small}>
                  {preview.phoneHint === null ? text.inviteGuideAnyPhone : text.inviteGuide}
                </Text>
              </View>
              <ErrorNotice error={error} />
              {pending}
              <PhoneField value={phone} onChange={setPhone} />
              <NewPasswordFields
                password={password}
                confirm={confirm}
                onPassword={setPassword}
                onConfirm={setConfirm}
                onSubmit={() => void submit()}
              />
              <Button primary busy={busy} onPress={() => void submit()}>
                {text.inviteSubmit}
              </Button>
            </>
          )}
          <BackToLogin onPress={onBack} />
        </Card>
      </View>
    </KeyboardPage>
  );
}

// --- 초대 대기 신청 ---
function WaitlistScreen({ onBack }: { onBack: () => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  // 서버와 같은 기준으로 센다 — 앞뒤 공백 제외
  const length = purpose.trim().length;
  const short = WAITLIST_PURPOSE_MIN - length;

  const submit = async () => {
    const problem = newAccountProblem(phone, password, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await publicRequest<unknown>("/api/auth/waitlist", {
        phone: normalizePhone(phone),
        password,
        purpose: purpose.trim(),
      });
      setDone(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardPage>
      <View style={{ width: "100%", maxWidth: 480, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Text style={[s.title, { fontSize: 32 }]}>{text.welcome}</Text>
          <Text style={s.heading}>{text.waitlist}</Text>
        </View>
        {done ? (
          <Card style={{ width: "100%", gap: 12 }}>
            <Text accessibilityRole="alert" style={s.heading}>
              {text.waitlistDoneTitle}
            </Text>
            <Text style={s.text}>{text.waitlistDoneBody}</Text>
            <Text style={s.small}>{text.waitlistDoneHint}</Text>
            <Button primary onPress={onBack}>
              {text.toLogin}
            </Button>
          </Card>
        ) : (
          <Card style={{ width: "100%" }}>
            <Text style={[s.muted, { marginBottom: 16 }]}>{text.waitlistIntro}</Text>
            <ErrorNotice error={error} />
            <PhoneField value={phone} onChange={setPhone} />
            <NewPasswordFields
              password={password}
              confirm={confirm}
              onPassword={setPassword}
              onConfirm={setConfirm}
            />
            <Field
              label={text.purpose}
              value={purpose}
              onChangeText={setPurpose}
              multiline
              maxLength={WAITLIST_PURPOSE_MAX}
              placeholder={text.purposePlaceholder}
            />
            <View style={{ gap: 4, marginTop: -8, marginBottom: 16 }}>
              <Text style={s.small}>{text.purposeGuide}</Text>
              <Text
                accessibilityLiveRegion="polite"
                style={[
                  s.small,
                  { fontFamily: fonts.mono, color: short > 0 ? colors.warn : colors.ok },
                ]}
              >
                {text.purposeCount(length)} ·{" "}
                {short > 0 ? text.purposeShort(short) : text.purposeOk}
              </Text>
            </View>
            {/* 글자 수가 모자라면 누를 수 없다 — 사유는 바로 위 글자 수 줄이 말한다 */}
            <Button primary busy={busy} disabled={short > 0} onPress={() => void submit()}>
              {text.waitlistSubmit}
            </Button>
            <BackToLogin onPress={onBack} />
          </Card>
        )}
      </View>
    </KeyboardPage>
  );
}

// --- 온보딩 3단계 (2/3 · 3/3 조각은 onboarding-steps.tsx — 스토어의 구독 뒤 온보딩과 같이 쓴다) ---
const FINISHED = text.steps.length;

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
    <KeyboardPage>
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
    </KeyboardPage>
  );
}
