import {
  ArrowDownToLine,
  CalendarDays,
  CheckCheck,
  ChevronRight,
  Clock3,
  Globe2,
  Link2,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react-native";
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { t } from "./strings";
import {
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  Empty,
  ErrorNotice,
  relativeDate,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
  timeLabel,
} from "./ui";
import { useWorkspace } from "./workspace";

export function ActivityScreen() {
  const { workspace: w, open } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const pending = w.actions.filter((a) => a.status === "awaiting_review");
  const actions = w.actions.filter((a) => filter === "all" || a.status === "awaiting_review");
  return (
    <View style={{ gap: 20 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Button small primary={filter === "all"} onPress={() => setFilter("all")}>
          {t.screens.activity.allActivity}
        </Button>
        <Button small primary={filter === "review"} onPress={() => setFilter("review")}>
          {t.screens.activity.needsReview(pending.length)}
        </Button>
      </View>
      {actions.length > 0 && (
        <Card>
          <SectionHeading title={t.screens.activity.yourActions} />
          {actions.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => open({ type: "review", action: a })}
              style={[
                s.row,
                { gap: 15, paddingVertical: 17, borderTopWidth: 1, borderTopColor: colors.line },
              ]}
            >
              <View
                style={[
                  s.iconBox,
                  {
                    backgroundColor:
                      a.status === "awaiting_review" ? colors.lavender : colors.green,
                  },
                ]}
              >
                {a.status === "awaiting_review" ? (
                  <ShieldCheck size={18} color={colors.text} />
                ) : (
                  <CheckCheck size={18} color={colors.text} />
                )}
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.text}>{a.title}</Text>
                <Text style={s.small}>{relativeDate(a.createdAt)}</Text>
              </View>
              <Chip
                tint={
                  a.status === "failed"
                    ? "#FBEFED"
                    : a.status === "awaiting_review"
                      ? colors.lavender
                      : colors.canvas
                }
              >
                {t.details.statusLabel(a.status)}
              </Chip>
              <ChevronRight size={16} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
      )}
      {filter === "all" && (
        <Card>
          <SectionHeading title={t.screens.activity.timeline} />
          {w.activity.length ? (
            w.activity.map((a, i) => (
              <View
                key={a.id}
                style={[
                  s.row,
                  {
                    alignItems: "flex-start",
                    gap: 17,
                    paddingVertical: 18,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: colors.line,
                  },
                ]}
              >
                <View
                  style={[s.iconBox, { height: 34, width: 34, backgroundColor: colors.canvas }]}
                >
                  <Clock3 size={16} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={s.text}>{a.title}</Text>
                  <Text style={s.muted}>{resultSummary(a.detail)}</Text>
                  <Text style={s.small}>
                    {dateLabel(a.date)} · {timeLabel(a.date)}
                  </Text>
                </View>
                <Chip>{t.details.statusLabel(a.status)}</Chip>
              </View>
            ))
          ) : (
            <Empty
              icon={Clock3}
              title={t.screens.activity.emptyTitle}
              detail={t.screens.activity.emptyDetail}
            />
          )}
        </Card>
      )}
      {filter === "review" && !actions.length && (
        <Card>
          <Empty
            icon={ShieldCheck}
            title={t.screens.activity.caughtUpTitle}
            detail={t.screens.activity.caughtUpDetail}
          />
        </Card>
      )}
    </View>
  );
}
export function ConnectionsScreen({ query = "" }: { query?: string }) {
  const { workspace: w, api, refresh, notify } = useWorkspace();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect(capability: "read" | "write") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ url: string | null; connected?: boolean }>(
        "/api/google/connect",
        { capability },
      );
      if (result.url) {
        await Linking.openURL(result.url);
        notify(t.screens.connections.finishInBrowser);
      } else {
        await refresh();
        notify(t.screens.connections.localGoogleReady);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api.request("/api/google/disconnect", {});
      await refresh();
      notify(t.screens.connections.googleDisconnected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const google = w.connections.find((c) => c.id === "google");
  const connected = google?.status === "connected" || google?.status === "sample";
  const rows = [
    { id: "gmail", name: "Gmail", icon: Mail, color: "#EA5B4D", connected, group: "google" },
    {
      id: "calendar",
      name: "Google Calendar",
      icon: CalendarDays,
      color: "#4285F4",
      connected,
      group: "google",
    },
    {
      id: "browser",
      name: t.screens.connections.agentComputer,
      icon: Globe2,
      color: "#1987CF",
      connected: w.connections.some((c) => c.id === "browser" && c.status === "connected"),
      group: "browser",
    },
    {
      id: "openbot",
      name: "OpenBot",
      icon: Sparkles,
      color: "#6866A6",
      connected: false,
      group: "openbot",
    },
  ].filter((row) => `${row.name} ${row.group}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <View style={{ gap: 22 }}>
      {[true, false].map((isConnected) => {
        const group = rows.filter((row) => row.connected === isConnected);
        if (!group.length) return null;
        return (
          <View key={String(isConnected)} style={{ gap: 8 }}>
            <Text style={[s.small, { marginLeft: 12 }]}>
              {isConnected
                ? w.mode === "sample"
                  ? t.screens.connections.yourConnections
                  : t.screens.connections.connected
                : t.screens.connections.available}
            </Text>
            <View style={{ paddingHorizontal: 16, borderRadius: 23, backgroundColor: "#F3F4F5" }}>
              {group.map((row, index) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={t.screens.connections.manage(row.name)}
                  onPress={() => setSelected(row.group)}
                  style={[
                    s.row,
                    {
                      gap: 14,
                      minHeight: 61,
                      borderBottomWidth: index < group.length - 1 ? 1 : 0,
                      borderBottomColor: "#E5E7E9",
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 29,
                      height: 29,
                      borderRadius: 7,
                      backgroundColor: "#FFF",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <row.icon size={23} color={row.color} />
                  </View>
                  <Text style={[s.text, { flex: 1 }]}>{row.name}</Text>
                  {row.connected && row.group === "google" && w.mode === "sample" && (
                    <Text style={s.small}>{t.screens.connections.localData}</Text>
                  )}
                  {row.connected ? (
                    <ChevronRight size={18} color="#A4A7AA" />
                  ) : (
                    <Text
                      style={{
                        fontSize: 13,
                        color: row.group === "google" ? colors.blueDark : colors.muted,
                      }}
                    >
                      {row.group === "google"
                        ? t.screens.connections.connect
                        : t.screens.connections.setup}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
      {!rows.length && <Text style={s.muted}>{t.screens.connections.noMatch}</Text>}
      {selected && (
        <Sheet
          title={selected === "google" ? t.screens.connections.googleTitle : "OpenBot"}
          subtitle={selected === "google" ? google?.account : t.screens.connections.openBotSubtitle}
          onClose={() => setSelected(undefined)}
        >
          {selected === "google" ? (
            <View style={{ gap: 18 }}>
              <Text style={s.muted}>{t.screens.connections.googleIntro}</Text>
              <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
                {google?.capabilities.map((cap) => (
                  <Chip key={cap}>{capabilityLabel(cap)}</Chip>
                ))}
              </View>
              <ErrorNotice error={error} />
              <Button busy={busy} primary icon={Link2} onPress={() => void connect("read")}>
                {t.screens.connections.connectGoogle}
              </Button>
              <Button busy={busy} onPress={() => void connect("write")}>
                {t.screens.connections.enableWrite}
              </Button>
              {connected && (
                <Button busy={busy} danger onPress={() => void disconnect()}>
                  {t.screens.connections.disconnectGoogle}
                </Button>
              )}
              <SettingsLine
                label={t.screens.connections.environment}
                value={
                  w.mode === "sample"
                    ? t.screens.connections.envSample
                    : t.screens.connections.envLive
                }
              />
              <SettingsLine
                label={t.screens.connections.assistant}
                value={
                  w.runtime.provider === "sample"
                    ? t.screens.connections.assistantGuided
                    : w.runtime.configured
                      ? t.screens.connections.assistantConnected
                      : t.screens.connections.assistantMissing
                }
              />
              <SettingsLine
                label={t.screens.connections.richThreads}
                value={
                  w.runtime.richThreads
                    ? t.screens.connections.richThreadsOn
                    : t.screens.connections.richThreadsOff
                }
              />
              <Button
                small
                icon={ArrowDownToLine}
                onPress={() => void refresh().catch((e) => setError(String(e)))}
              >
                {t.screens.connections.refresh}
              </Button>
            </View>
          ) : (
            <View style={{ gap: 14 }}>
              <Text style={s.text}>{t.screens.connections.openBotNotice}</Text>
              <Text style={s.muted}>{t.screens.connections.openBotDetail}</Text>
            </View>
          )}
        </Sheet>
      )}
    </View>
  );
}
function SettingsLine({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={[
        s.between,
        { gap: 15, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
      ]}
    >
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.text, { fontSize: 12, flexShrink: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

function capabilityLabel(value: string) {
  const scope = value.split("/").at(-1) || value;
  const names: Record<string, string> = t.screens.capability;
  return names[scope] || scope;
}
