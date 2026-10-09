// 0Siri 로그인·초대 가입·온보딩 (0SIRI-SPEC §4.1). 서버: apps/server/src/osiri/account-routes.ts
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Profile, PublicUser } from "../../../server/src/osiri/accounts.ts";
import { API_URL, type MuseApi } from "../api";
import { readApiPayload } from "../api-response";
import { Button, Card, colors, ErrorNotice, Field, Mascot, s } from "../ui";

const text = {
  welcome: "0Siri",
  tagline: "나만의 에이전트와 쌓이는 기록",
  phone: "전화번호",
  phonePlaceholder: "01012345678",
  password: "비밀번호",
  passwordPlaceholder: "8자 이상",
  login: "로그인",
  inviteToggle: "초대받으셨나요?",
  inviteClose: "로그인으로 돌아가기",
  inviteToken: "초대 코드",
  inviteTokenPlaceholder: "초대 링크의 마지막 부분",
  signup: "가입하기",
  kakao: "카카오로 계속하기",
  google: "구글로 계속하기",
  inviteOnly: "0Siri 는 지금 초대로만 가입할 수 있어요. 받은 초대 코드를 아래에 입력해 주세요.",
  required: "전화번호와 비밀번호를 입력해 주세요",
  tokenRequired: "초대 코드를 입력해 주세요",
  stepOf: (n: number) => `${n} / 4 단계`,
  retry: "다시 시도",
  steps: [
    { title: "프로필", body: "다른 사람에게 보일 이름이에요. 자격 표기는 선택이에요." },
    { title: "첫 팀 고르기", body: "스토어에서 마음에 드는 에이전트 팀을 골라 시작할 수 있어요." },
    {
      title: "도구 연결",
      body: "캘린더·메일 같은 도구는 나중에 설정에서 언제든 연결할 수 있어요.",
    },
    {
      title: "알림 권한",
      body: "에이전트가 일을 끝내면 알려드릴게요. 알림은 기기 설정에서 켤 수 있어요.",
    },
  ],
  displayName: "표시 이름",
  displayNamePlaceholder: "홍길동",
  displayNameRequired: "표시 이름을 입력해 주세요",
  credentialText: "자격 표기 (선택)",
  credentialPlaceholder: "예: 공인중개사 · 변호사",
  next: "다음",
  browseStore: "스토어 둘러보기",
  later: "나중에",
  skip: "건너뛰기",
  start: "시작하기",
  loading: "불러오는 중…",
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 숫자만 남기고 +82 를 0 으로. 검증은 서버(normalizePhone)가 한다. */
export function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("82") ? `0${digits.slice(2)}` : digits;
}

// --- 토큰 보관 --- 웹 localStorage, 네이티브 expo-secure-store(키체인/키스토어). 둘 다 실패하면 메모리(재로그인).
const TOKEN_KEY = "osiri.token";
const webStorage = Platform.OS === "web" && typeof localStorage !== "undefined";
let memoryToken = "";
export async function loadToken(): Promise<string> {
  try {
    if (webStorage) return localStorage.getItem(TOKEN_KEY) ?? "";
    return (await SecureStore.getItemAsync(TOKEN_KEY)) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}
export async function saveToken(token: string): Promise<void> {
  memoryToken = token;
  try {
    if (webStorage) localStorage.setItem(TOKEN_KEY, token);
    else await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch {}
}
export async function clearToken(): Promise<void> {
  memoryToken = "";
  try {
    if (webStorage) localStorage.removeItem(TOKEN_KEY);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {}
}
export async function logout(api: MuseApi) {
  await api.request("/api/auth/logout", {}).catch(() => undefined);
  await clearToken();
}

// --- /api/me ---
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

// --- 로그인 ---
type AuthResult = { token: string; user: PublicUser };
async function publicPost(path: string, body: unknown) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiPayload<AuthResult>(response);
}

export function LoginScreen({ onToken }: { onToken: (token: string) => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized || !password) return setError(text.required);
    if (invite && !inviteToken.trim()) return setError(text.tokenRequired);
    setBusy(true);
    setError("");
    try {
      const result = invite
        ? await publicPost("/api/auth/invite/accept", {
            token: inviteToken.trim(),
            phone: normalized,
            password,
          })
        : await publicPost("/api/auth/login", { phone: normalized, password });
      await saveToken(result.token);
      onToken(result.token);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  // 소셜 버튼: disabled 아님·"준비 중" 금지(§4.1) — 누르면 초대 안내 + 초대 입력란을 연다
  const social = () => {
    setNotice(text.inviteOnly);
    setInvite(true);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: 24,
        }}
      >
        <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
          <Mascot size={72} />
          <Text style={{ fontSize: 32, color: colors.text, letterSpacing: -1, fontWeight: "500" }}>
            {text.welcome}
          </Text>
          <Text style={[s.muted, { textAlign: "center" }]}>{text.tagline}</Text>
          <Card style={{ width: "100%" }}>
            <ErrorNotice error={error} />
            {invite ? (
              <Field
                label={text.inviteToken}
                value={inviteToken}
                onChangeText={setInviteToken}
                autoCapitalize="none"
                placeholder={text.inviteTokenPlaceholder}
              />
            ) : null}
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
              onSubmitEditing={() => void submit()}
            />
            <Button primary busy={busy} onPress={() => void submit()}>
              {invite ? text.signup : text.login}
            </Button>
            <Button
              small
              style={{ marginTop: 10, backgroundColor: "transparent" }}
              onPress={() => {
                setInvite(!invite);
                setNotice("");
              }}
            >
              {invite ? text.inviteClose : text.inviteToggle}
            </Button>
            <View style={s.divider} />
            {notice ? (
              <View style={[s.error, { backgroundColor: colors.sky }]}>
                <Text style={s.text}>{notice}</Text>
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              <Button onPress={social} style={{ backgroundColor: "#FEE500" }}>
                {text.kakao}
              </Button>
              <Button onPress={social}>{text.google}</Button>
            </View>
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// --- 온보딩 4단계 ---
export function Onboarding({
  api,
  onDone,
  onGoStore,
}: {
  api: MuseApi;
  onDone: () => void;
  onGoStore: () => void;
}) {
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [credentialText, setCredentialText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const saveProfile = () => {
    if (!displayName.trim()) return setError(text.displayNameRequired);
    void run(async () => {
      await api.request(
        "/api/me/profile",
        { displayName: displayName.trim(), credentialText: credentialText.trim() || undefined },
        "PATCH",
      );
      setStep(1);
    });
  };
  // 결정: onboardedAt 은 마지막 단계에서만 찍는다 — 중간에 나가면 다음 실행 때 온보딩이 다시 뜬다.
  // expo-notifications 미설치 → 권한 요청 없이 안내만 하고 시작한다.
  const finish = () =>
    void run(async () => {
      await api.request("/api/me/profile", { onboardedAt: new Date().toISOString() }, "PATCH");
      onDone();
    });
  const goStore = () => {
    setStep(2); // 스토어에서 돌아오면 다음 단계부터
    onGoStore();
  };
  const label = (base: string) => (error ? text.retry : base);

  const actions = [
    <Button key="1" primary busy={busy} onPress={saveProfile}>
      {label(text.next)}
    </Button>,
    <View key="2" style={{ gap: 8 }}>
      <Button primary onPress={goStore}>
        {text.browseStore}
      </Button>
      <Button onPress={() => setStep(2)}>{text.later}</Button>
    </View>,
    <Button key="3" primary onPress={() => setStep(3)}>
      {text.skip}
    </Button>,
    <Button key="4" primary busy={busy} onPress={finish}>
      {label(text.start)}
    </Button>,
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: 24,
        }}
      >
        <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
          <Mascot size={56} />
          <Card style={{ width: "100%", gap: 14 }}>
            <View style={[s.row, { gap: 6 }]}>
              {text.steps.map((item, i) => (
                <View
                  key={item.title}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: i <= step ? colors.blueDark : colors.line,
                  }}
                />
              ))}
            </View>
            <Text style={s.label}>{text.stepOf(step + 1)}</Text>
            <Text style={s.title}>{text.steps[step].title}</Text>
            <Text style={s.muted}>{text.steps[step].body}</Text>
            <ErrorNotice error={error} />
            {step === 0 ? (
              <View>
                <Field
                  label={text.displayName}
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder={text.displayNamePlaceholder}
                />
                <Field
                  label={text.credentialText}
                  value={credentialText}
                  onChangeText={setCredentialText}
                  placeholder={text.credentialPlaceholder}
                />
              </View>
            ) : null}
            {busy ? (
              <View style={[s.row, { gap: 8 }]}>
                <ActivityIndicator color={colors.blueDark} />
                <Text style={s.small}>{text.loading}</Text>
              </View>
            ) : null}
            {actions[step]}
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
