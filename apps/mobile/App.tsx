// 0Siri 앱 셸 («0Siri 종합 기획» §03): 앱은 하단 탭 5개(채팅·목표·활동·스토어·설정) + 채팅,
// 웹은 2단(사이드바 280px: 방 목록 + 아래 [스토어][활동·결재함][설정] / 메인). 로그인은 전화번호+비밀번호(마스터 결정).
import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { StatusBar } from "expo-status-bar";
import {
  Bell,
  Check,
  Inbox,
  type LucideIcon,
  MessageSquare,
  Settings,
  Store,
  Target,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Section, Workspace } from "../../packages/domain/src";
import { AgentWorkspaceProvider } from "./src/agent-workspace";
import { apiBase, MuseApi } from "./src/api";
import { WorkspaceTools } from "./src/chat";
import { Details } from "./src/details";
import { LoginScreen, loadApiBase, loadToken, logout, Onboarding, useMe } from "./src/osiri/auth";
import { type CharacterPref, setCharacterPref } from "./src/osiri/eve";
import { InboxScreen } from "./src/osiri/inbox";
import {
  LiveChip,
  type Room,
  type RoomFocus,
  RoomList,
  RoomScreen,
  refreshRooms,
  resetRooms,
  useRooms,
  useRoomsLive,
} from "./src/osiri/rooms";
import { SettingsScreen } from "./src/osiri/settings";
import { StoreScreen } from "./src/osiri/store";
import { TeamGoalsScreen } from "./src/osiri/team-goals";
import { UpdateBanner } from "./src/osiri/update";
import { ThreadsProvider } from "./src/threads";
import { Badge, Button, colors, ErrorNotice, fonts, IconButton, isDark, s } from "./src/ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./src/workspace";

type Tab = "rooms" | "store" | "inbox" | "goals" | "settings";
type StoreTab = "explore" | "mine";
const nav: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "rooms", label: "채팅", icon: MessageSquare },
  { id: "goals", label: "목표", icon: Target },
  { id: "inbox", label: "활동", icon: Inbox },
  { id: "store", label: "스토어", icon: Store },
  { id: "settings", label: "설정", icon: Settings },
];
// 웹 사이드바 아래 진입 3개 (기획 화면 2). 채팅은 방 목록이, 목표는 방 안 상단 탭이 맡는다
const sideNav: Tab[] = ["store", "inbox", "settings"];
const titles: Record<Tab, string> = {
  rooms: "내 팀",
  store: "스토어",
  inbox: "활동 · 결재함",
  goals: "목표",
  settings: "설정",
};
const text = {
  loading: "0Siri 를 여는 중…",
  retry: "다시 시도",
  dismiss: "닫기",
  notifications: (n: number) => (n ? `알림 ${n}건` : "알림"),
  sideInbox: "활동·결재함",
  noPersonal: "개인 방(영시리)을 찾지 못했습니다. 다시 시도해 주세요.",
  settingsFailed: "캐릭터 설정을 읽지 못해 기본 모습으로 보여 드려요",
  noRoom: "그 방을 찾지 못했습니다. 해지됐거나 주소가 바뀌었을 수 있어요.",
};
// 옛 openmuse 섹션 → 0Siri 탭 (agent-ui 등이 navigate("chat") 을 부를 때)
const legacy: Partial<Record<Section, Tab>> = {
  chat: "rooms",
  activity: "inbox",
  connections: "settings",
  apps: "settings",
};
const isTab = (value: string): value is Tab => nav.some((item) => item.id === value);

// --- 웹 URL ↔ 상태 (§4.12 라우팅: /rooms/:id · /store?tab= · /inbox · /goals · /settings) ---
function readLocation(): { tab: Tab; roomId?: string; storeTab: StoreTab } {
  if (Platform.OS !== "web" || typeof location === "undefined")
    return { tab: "rooms", storeTab: "explore" };
  const [, first = "", second] = location.pathname.split("/");
  const storeTab = new URLSearchParams(location.search).get("tab") === "mine" ? "mine" : "explore";
  if (first === "rooms" && second) return { tab: "rooms", roomId: second, storeTab };
  return { tab: isTab(first) ? first : "rooms", storeTab };
}
function writeLocation(tab: Tab, roomId: string | undefined, storeTab: StoreTab) {
  if (Platform.OS !== "web" || typeof history === "undefined") return;
  const path =
    tab === "rooms" && roomId
      ? `/rooms/${roomId}`
      : tab === "store"
        ? `/store?tab=${storeTab}`
        : `/${tab}`;
  // 설정의 하위 화면(/settings/connections 등)은 설정 화면이 스스로 쓴다 — 여기서 덮으면 직행 링크가 죽는다.
  if (tab === "settings" && location.pathname.startsWith("/settings")) return;
  if (`${location.pathname}${location.search}` !== path) history.replaceState(null, "", path);
}

export default function App() {
  const [token, setToken] = useState<string | null>(null); // null = 아직 저장소를 안 읽음
  useEffect(() => {
    void loadApiBase()
      .then(loadToken)
      .then((saved) => setToken(saved || ""));
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    // 기획 폰트 3종 (본문 Pretendard · 제목 Noto Serif KR · 숫자 IBM Plex Mono)
    for (const href of [
      "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Noto+Serif+KR:wght@600;700&display=swap",
    ]) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
    document.body.style.fontFamily = fonts.body ?? "";
    document.body.style.backgroundColor = colors.canvas;
    // 색은 켤 때 굳으므로(ui.tsx), 시스템 다크 설정이 바뀌면 다시 읽는다
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const reload = () => location.reload();
    media.addEventListener("change", reload);
    return () => media.removeEventListener("change", reload);
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style={isDark ? "light" : "dark"} />
      {token === null ? (
        <Loading />
      ) : token ? (
        <CopilotKitProvider
          runtimeUrl={`${apiBase()}/api/copilotkit`}
          headers={{ Authorization: `Bearer ${token}` }}
        >
          <WorkspaceApp token={token} onLogout={() => setToken("")} />
        </CopilotKitProvider>
      ) : (
        <LoginScreen onToken={setToken} />
      )}
    </SafeAreaProvider>
  );
}

function Toast({
  message,
  bottom,
  onClose,
}: {
  message: string;
  bottom: number;
  onClose: () => void;
}) {
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", bottom, left: 20, right: 20, alignItems: "center" }}
    >
      <View
        style={[
          s.row,
          { gap: 10, padding: 14, backgroundColor: colors.text, borderRadius: 20, maxWidth: 560 },
        ]}
      >
        <Check size={16} color={colors.blue} />
        <Text style={{ color: colors.canvas, fontSize: 13, flexShrink: 1 }}>{message}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={text.dismiss} onPress={onClose}>
          <X size={16} color={colors.canvas} />
        </Pressable>
      </View>
    </View>
  );
}

function Loading({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: colors.canvas,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 18,
      }}
    >
      {/* 로그인 전에도 뜨는 화면이라 캐릭터를 두지 않는다 (기획 화면 1) */}
      {error ? (
        <>
          <ErrorNotice error={error} />
          {onRetry && <Button onPress={onRetry}>{text.retry}</Button>}
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.blueDark} />
          <Text style={s.muted}>{text.loading}</Text>
        </>
      )}
    </SafeAreaView>
  );
}

function WorkspaceApp({ token, onLogout }: { token: string; onLogout: () => void }) {
  const api = useMemo(() => new MuseApi(token), [token]);
  const { me, loading: meLoading, error: meError, reload: reloadMe } = useMe(api);
  const [workspace, setWorkspace] = useState<Workspace>();
  const initial = useMemo(readLocation, []);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [storeTab, setStoreTab] = useState<StoreTab>(initial.storeTab);
  const [room, setRoom] = useState<Room>();
  // 방을 열 때 보일 곳 (목록 배지 → 승인 카드, 결재함 [방에서 보기]·활동 → 그 메시지)
  const [focus, setFocus] = useState<RoomFocus>();
  // 방 목록은 rooms.tsx 의 한 벌을 본다 (사이드바·탭 배지·홈 채팅·딥링크가 같은 값)
  const { rooms, error: roomsError } = useRooms();
  // 기본 채팅 = 개인 방(영시리). 서버가 /api/rooms 호출 때 없으면 만든다
  const personal = rooms?.find((r) => r.packageId === null);
  const pending = rooms?.reduce((sum, r) => sum + r.pendingApprovals, 0) ?? 0; // 탭 배지
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  const [detail, setDetail] = useState<Detail>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setWorkspace(await api.request<Workspace>("/api/workspace"));
    setError("");
  }, [api]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((e) => setError(String(e)));
    });
    return () => listener.remove();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (rooms && !rooms.some((r) => r.packageId === null)) setError(text.noPersonal);
  }, [rooms]);
  // 열려 있는 방의 배지·상태도 목록이 바뀌면 따라간다
  useEffect(() => {
    setRoom((open) => (open && rooms?.find((r) => r.id === open.id)) || open);
  }, [rooms]);
  useEffect(() => writeLocation(tab, room?.id, storeTab), [tab, room, storeTab]);
  // 세션 만료(401) 면 로그인으로
  useEffect(() => {
    if (/401|세션|로그인/.test(meError)) onLogout();
  }, [meError, onLogout]);

  const navigate = useCallback((next: Section) => {
    const target = isTab(next) ? next : legacy[next];
    if (!target) return;
    setRoom(undefined);
    setTab(target);
  }, []);
  const openRoom = useCallback((next: Room, nextFocus?: RoomFocus) => {
    setTab("rooms");
    setRoom(next);
    setFocus(nextFocus);
  }, []);
  const openRoomById = useCallback(
    (id: string, nextFocus?: RoomFocus) =>
      void refreshRooms(api).then((list) => {
        // 조회 실패(null)는 목록이 사유를 보인다 — 여기서는 «없는 방» 만 말한다
        const found = list?.find((r) => r.id === id);
        if (found) openRoom(found, nextFocus);
        else if (list) setError(text.noRoom);
      }),
    [api, openRoom],
  );
  // 웹 딥링크 /rooms/:id — 못 찾으면 openRoomById 가 사유를 띄운다
  useEffect(() => {
    if (initial.roomId) openRoomById(initial.roomId);
  }, [initial.roomId, openRoomById]);
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  const ask = useCallback(() => navigate("rooms"), [navigate]); // ponytail: 옛 "채팅으로 질문" 은 방 목록으로

  if (!workspace || (meLoading && !me))
    return (
      <Loading
        error={error || meError}
        onRetry={() => {
          void refresh().catch((e) => setError(String(e)));
          void reloadMe();
        }}
      />
    );
  if (me && !me.profile.onboardedAt && !skipOnboarding)
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
        <Onboarding
          api={api}
          onDone={() => void reloadMe()}
          onGoStore={() => {
            setSkipOnboarding(true);
            setTab("store");
          }}
        />
      </SafeAreaView>
    );
  return (
    <WorkspaceContext.Provider
      value={{
        workspace,
        api,
        section: tab,
        navigate,
        refresh,
        open,
        close,
        notify: setToast,
        ask,
      }}
    >
      <AgentWorkspaceProvider>
        <ThreadsProvider>
          <Shell
            tab={tab}
            setTab={(next) => {
              setRoom(undefined);
              setTab(next);
            }}
            room={room}
            focus={focus}
            personal={personal}
            pending={pending}
            openRoom={openRoom}
            openRoomById={openRoomById}
            closeRoom={() => setRoom(undefined)}
            storeTab={storeTab}
            setStoreTab={setStoreTab}
            detail={detail}
            toast={toast}
            clearToast={() => setToast("")}
            error={error || (rooms ? "" : roomsError)}
            onLogout={() =>
              void logout(api)
                .then(() => {
                  resetRooms();
                  // 서버 세션 정리 경고는 auth.tsx 가 쌓아 두고, 곧바로 뜨는 로그인 화면이 보인다(takeAuthIssues)
                  onLogout();
                })
                .catch((e) => setError(String(e)))
            }
          />
        </ThreadsProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
  );
}

function Shell({
  tab,
  setTab,
  room,
  focus,
  personal,
  pending,
  openRoom,
  openRoomById,
  closeRoom,
  storeTab,
  setStoreTab,
  detail,
  toast,
  clearToast,
  error,
  onLogout,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  room?: Room;
  focus?: RoomFocus;
  personal?: Room;
  pending: number;
  openRoom: (room: Room, focus?: RoomFocus) => void;
  openRoomById: (id: string, focus?: RoomFocus) => void;
  closeRoom: () => void;
  storeTab: StoreTab;
  setStoreTab: (tab: StoreTab) => void;
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  onLogout: () => void;
}) {
  const { workspace, open, api, notify } = useWorkspace();
  // 로그인해 있는 동안 방 목록을 살아 있게 (첫 조회 + 사용자 스트림). 끊기면 배지·진척이 낡으므로 상태를 화면에 보인다
  const live = useRoomsLive();
  // 캐릭터 끄기·반응 강도 (화면 11) — 서버 설정이 정본
  useEffect(() => {
    void api
      .request<{ character: CharacterPref }>("/api/settings")
      .then((v) => setCharacterPref(v.character))
      .catch((e) => notify(`${text.settingsFailed}: ${e instanceof Error ? e.message : e}`));
  }, [api, notify]);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const notices = workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const screen =
    tab === "store" ? (
      <StoreScreen tab={storeTab} onTab={setStoreTab} onOpenRoom={openRoomById} />
    ) : tab === "inbox" ? (
      <InboxScreen onOpenRoom={openRoomById} />
    ) : tab === "goals" ? (
      <TeamGoalsScreen onOpenRoom={openRoomById} />
    ) : tab === "settings" ? (
      <SettingsScreen onLogout={onLogout} />
    ) : (
      <RoomList onOpen={openRoom} />
    );
  // 방 안: 탭 숨김, 전체 화면 (§4.0). 웹에서는 사이드바 옆 메인에 뜬다
  // 채팅 탭 = 영시리와의 기본 채팅(Muse 처럼). 팀 방은 그 화면의 버튼으로 연다
  const main = room ? (
    <RoomScreen key={room.id} room={room} focus={focus} onBack={closeRoom} onOpenRoom={openRoom} />
  ) : tab === "rooms" ? (
    personal ? (
      <RoomScreen key="home" home room={personal} onBack={closeRoom} onOpenRoom={openRoom} />
    ) : (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
        <ErrorNotice error={error} />
        {!error && <ActivityIndicator color={colors.blueDark} />}
      </View>
    )
  ) : (
    <ScrollView
      key={tab}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: desktop ? 42 : 22, paddingBottom: 28 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[s.row, { justifyContent: "space-between", marginTop: 8, marginBottom: 22 }]}>
        <Text style={[s.title, { fontSize: 25 }]}>{titles[tab]}</Text>
        <View>
          <IconButton
            icon={Bell}
            label={text.notifications(notices)}
            onPress={() => open({ type: "notifications" })}
          />
          {notices > 0 && (
            <View
              pointerEvents="none"
              style={{
                width: 6,
                height: 6,
                borderRadius: 4,
                position: "absolute",
                top: 7,
                right: 9,
                backgroundColor: colors.miss,
              }}
            />
          )}
        </View>
      </View>
      <ErrorNotice error={error} />
      {screen}
    </ScrollView>
  );
  return (
    <>
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
        <UpdateBanner />
        {desktop ? (
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View
              style={{
                width: 280,
                borderRightWidth: 1,
                borderRightColor: colors.line,
                backgroundColor: colors.sunk,
                paddingHorizontal: 14,
                paddingTop: 10,
              }}
            >
              <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                <RoomList
                  onOpen={openRoom}
                  activeId={room?.id ?? (tab === "rooms" ? personal?.id : undefined)}
                />
              </ScrollView>
              <LiveChip live={live} />
              <View
                style={{
                  flexDirection: "row",
                  gap: 4,
                  paddingVertical: 8,
                  borderTopWidth: 1,
                  borderTopColor: colors.line,
                }}
              >
                {nav
                  .filter((item) => sideNav.includes(item.id))
                  .map((item) => (
                    <NavButton
                      key={item.id}
                      item={item.id === "inbox" ? { ...item, label: text.sideInbox } : item}
                      badge={item.id === "inbox" ? pending : 0}
                      active={tab === item.id && !room}
                      onPress={() => setTab(item.id)}
                    />
                  ))}
              </View>
            </View>
            <View style={{ flex: 1, minHeight: 0, maxWidth: 960 }}>{main}</View>
          </View>
        ) : (
          <View style={{ flex: 1, minHeight: 0 }}>{main}</View>
        )}
        {!desktop && (
          <View
            style={{
              paddingHorizontal: 22,
              paddingTop: 10,
              paddingBottom: 7,
              alignItems: "center",
            }}
          >
            <LiveChip live={live} />
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                maxWidth: 420,
                padding: 5,
                backgroundColor: colors.card,
                borderRadius: 40,
                shadowColor: colors.text,
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.07,
                shadowRadius: 18,
                elevation: 3,
                borderWidth: 1,
                borderColor: colors.line,
              }}
            >
              {nav.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  badge={item.id === "inbox" ? pending : 0}
                  active={tab === item.id && (!room || item.id === "rooms")}
                  onPress={() => setTab(item.id)}
                />
              ))}
            </View>
          </View>
        )}
        {!!toast && <Toast message={toast} bottom={94} onClose={clearToast} />}
        {detail && (
          <Details
            key={
              detail.type === "task"
                ? detail.taskId
                : detail.type === "review"
                  ? detail.action.id
                  : detail.type
            }
            detail={detail}
          />
        )}
      </SafeAreaView>
    </>
  );
}

function NavButton({
  item,
  active,
  badge = 0,
  onPress,
}: {
  item: { id: Tab; label: string; icon: LucideIcon };
  active: boolean;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={badge ? `${item.label} · 승인 대기 ${badge}건` : item.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        flex: 1,
        height: 47,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? colors.accentSoft : "transparent",
        borderRadius: 28,
        gap: 2,
      }}
    >
      <item.icon size={21} strokeWidth={1.8} color={active ? colors.accent : colors.text} />
      <Text style={{ fontSize: 10, color: active ? colors.accent : colors.text }}>
        {item.label}
      </Text>
      {badge > 0 && <Badge count={badge} style={{ position: "absolute", top: 3, right: "22%" }} />}
    </Pressable>
  );
}
