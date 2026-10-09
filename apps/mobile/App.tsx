// 0Siri 앱 셸 (0SIRI-SPEC §4.0): 앱은 하단 탭 5개(방·스토어·결재함·목표·설정), 방 안에서는 탭을 숨긴다.
// 웹은 2단(사이드바 280px + 메인). 로그인은 전화번호+비밀번호(§4.1), 온보딩 4단계 뒤에 셸로 들어온다.
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
import { CharacterAvatar } from "./src/osiri/eve";
import { InboxScreen } from "./src/osiri/inbox";
import { type Room, RoomList, RoomScreen } from "./src/osiri/rooms";
import { SettingsScreen } from "./src/osiri/settings";
import { StoreScreen } from "./src/osiri/store";
import { TeamGoalsScreen } from "./src/osiri/team-goals";
import { UpdateBanner } from "./src/osiri/update";
import { ThreadsProvider } from "./src/threads";
import { Button, colors, ErrorNotice, IconButton, s } from "./src/ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./src/workspace";

type Tab = "rooms" | "store" | "inbox" | "goals" | "settings";
type StoreTab = "explore" | "mine";
const nav: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "rooms", label: "채팅", icon: MessageSquare },
  { id: "store", label: "스토어", icon: Store },
  { id: "inbox", label: "결재함", icon: Inbox },
  { id: "goals", label: "목표", icon: Target },
  { id: "settings", label: "설정", icon: Settings },
];
const titles: Record<Tab, string> = {
  rooms: "내 팀",
  store: "스토어",
  inbox: "결재함",
  goals: "목표",
  settings: "설정",
};
const text = {
  loading: "0Siri 를 여는 중…",
  retry: "다시 시도",
  dismiss: "닫기",
  notifications: (n: number) => (n ? `알림 ${n}건` : "알림"),
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
  if (`${location.pathname}${location.search}` !== path) history.replaceState(null, "", path);
}

export default function App() {
  const [token, setToken] = useState<string | null>(null); // null = 아직 저장소를 안 읽음
  useEffect(() => {
    void loadApiBase()
      .then(loadToken)
      .then((saved) => setToken(saved || ""));
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
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
      <CharacterAvatar size={84} mood="thinking" />
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
  // 기본 채팅 = 개인 방(영시리). 서버가 /api/rooms 호출 때 없으면 만든다
  const [personal, setPersonal] = useState<Room>();
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
  // 개인 방(홈 채팅) + 웹 딥링크 /rooms/:id — 한 번의 목록 조회로 둘 다
  useEffect(() => {
    void api
      .request<Room[]>("/api/rooms")
      .then((rooms) => {
        setPersonal(rooms.find((r) => r.packageId === null));
        if (initial.roomId) setRoom(rooms.find((r) => r.id === initial.roomId));
      })
      .catch((e) => setError(String(e)));
  }, [api, initial.roomId]);
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
  const openRoom = useCallback((next: Room) => {
    setTab("rooms");
    setRoom(next);
  }, []);
  const openRoomById = useCallback(
    (id: string) =>
      void api
        .request<Room[]>("/api/rooms")
        .then((rooms) => {
          const found = rooms.find((r) => r.id === id);
          if (found) openRoom(found);
        })
        .catch((e) => setError(String(e))),
    [api, openRoom],
  );
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
            personal={personal}
            openRoom={openRoom}
            openRoomById={openRoomById}
            closeRoom={() => setRoom(undefined)}
            storeTab={storeTab}
            setStoreTab={setStoreTab}
            detail={detail}
            toast={toast}
            clearToast={() => setToast("")}
            error={error}
            onLogout={() => void logout(api).then(onLogout)}
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
  personal,
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
  personal?: Room;
  openRoom: (room: Room) => void;
  openRoomById: (id: string) => void;
  closeRoom: () => void;
  storeTab: StoreTab;
  setStoreTab: (tab: StoreTab) => void;
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  onLogout: () => void;
}) {
  const { workspace, open } = useWorkspace();
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const pending = workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const screen =
    tab === "store" ? (
      <StoreScreen tab={storeTab} onTab={setStoreTab} onOpenRoom={openRoomById} />
    ) : tab === "inbox" ? (
      <InboxScreen />
    ) : tab === "goals" ? (
      <TeamGoalsScreen />
    ) : tab === "settings" ? (
      <SettingsScreen onLogout={onLogout} />
    ) : (
      <RoomList onOpen={openRoom} />
    );
  // 방 안: 탭 숨김, 전체 화면 (§4.0). 웹에서는 사이드바 옆 메인에 뜬다
  // 채팅 탭 = 영시리와의 기본 채팅(Muse 처럼). 팀 방은 그 화면의 버튼으로 연다
  const main = room ? (
    <RoomScreen key={room.id} room={room} onBack={closeRoom} />
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
            label={text.notifications(pending)}
            onPress={() => open({ type: "notifications" })}
          />
          {pending > 0 && (
            <View
              pointerEvents="none"
              style={{
                width: 6,
                height: 6,
                borderRadius: 4,
                position: "absolute",
                top: 7,
                right: 9,
                backgroundColor: colors.blueDark,
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
                borderRightColor: "#ECECEC",
                paddingHorizontal: 14,
                paddingTop: 10,
              }}
            >
              <View style={{ flexDirection: "row", gap: 4, marginBottom: 12 }}>
                {nav.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    active={tab === item.id && !room}
                    onPress={() => setTab(item.id)}
                  />
                ))}
              </View>
              <ScrollView showsVerticalScrollIndicator={false}>
                <RoomList onOpen={openRoom} />
              </ScrollView>
            </View>
            <View style={{ flex: 1, minHeight: 0, maxWidth: 960 }}>{main}</View>
          </View>
        ) : (
          <View style={{ flex: 1, minHeight: 0 }}>{main}</View>
        )}
        {!desktop && !room && (
          <View
            style={{
              paddingHorizontal: 22,
              paddingTop: 10,
              paddingBottom: 7,
              alignItems: "center",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                maxWidth: 420,
                padding: 5,
                backgroundColor: "#FFF",
                borderRadius: 40,
                shadowColor: "#132631",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.07,
                shadowRadius: 18,
                elevation: 3,
                borderWidth: 1,
                borderColor: "#F8F8F8",
              }}
            >
              {nav.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  active={tab === item.id}
                  onPress={() => setTab(item.id)}
                />
              ))}
            </View>
          </View>
        )}
        {!!toast && (
          <View
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 94, left: 20, right: 20, alignItems: "center" }}
          >
            <View
              style={[
                s.row,
                {
                  gap: 10,
                  padding: 14,
                  backgroundColor: colors.text,
                  borderRadius: 20,
                  maxWidth: 560,
                },
              ]}
            >
              <Check size={16} color={colors.blue} />
              <Text style={{ color: "#FFF", fontSize: 13, flexShrink: 1 }}>{toast}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={text.dismiss}
                onPress={clearToast}
              >
                <X size={16} color="#FFF" />
              </Pressable>
            </View>
          </View>
        )}
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
  onPress,
}: {
  item: { id: Tab; label: string; icon: LucideIcon };
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        flex: 1,
        height: 47,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? "#F0F1F2" : "transparent",
        borderRadius: 28,
        gap: 2,
      }}
    >
      <item.icon size={21} strokeWidth={1.8} color={colors.text} />
      <Text style={{ fontSize: 10, color: colors.text }}>{item.label}</Text>
    </Pressable>
  );
}
