import { Check, Clock3, ShieldCheck, X } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { ActionProposal } from "../../../packages/domain/src";
import { DelegateSheet, NotificationsSheet, TaskDetail } from "./agent-ui";
import { t } from "./strings";
import { Button, Card, Chip, colors, ErrorNotice, LinkRow, resultSummary, Sheet, s } from "./ui";
import { type Detail, useWorkspace } from "./workspace";
export function Details({ detail }: { detail: Detail }) {
  const { close, navigate } = useWorkspace();
  if (detail.type === "task") return <TaskDetail taskId={detail.taskId} />;
  if (detail.type === "delegate")
    return (
      <DelegateSheet
        key={`${detail.goalId}:${detail.milestoneId}`}
        goalId={detail.goalId}
        milestoneId={detail.milestoneId}
      />
    );
  if (detail.type === "notifications") return <NotificationsSheet />;
  if (detail.type === "review") return <ReviewDetail initial={detail.action} />;
  return (
    <Sheet title={t.details.menu.title} subtitle={t.details.menu.subtitle} onClose={close}>
      {[
        { section: "activity" as const, title: t.details.menu.activity, icon: Clock3 },
        { section: "connections" as const, title: t.details.menu.connections, icon: ShieldCheck },
      ].map((item) => (
        <LinkRow
          key={item.section}
          title={item.title}
          icon={item.icon}
          onPress={() => {
            navigate(item.section);
            close();
          }}
        />
      ))}
    </Sheet>
  );
}
function ReviewDetail({ initial }: { initial: ActionProposal }) {
  const { workspace: w, api, refresh, close } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action =
    local.status !== initial.status ? local : w.actions.find((a) => a.id === initial.id) || local;
  const d = action.data;
  const pending = action.status === "awaiting_review";
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      setLocal(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const rows = Object.entries(d).filter(([, value]) => value !== undefined && value !== null);
  return (
    <Sheet
      title={pending ? t.details.review.title : action.title}
      subtitle={
        w.mode === "sample" ? t.details.review.subtitleSample : t.details.review.subtitleLive
      }
      onClose={close}
    >
      <View style={[s.row, { gap: 13, marginBottom: 21 }]}>
        <View style={[s.iconBox, { backgroundColor: colors.lavender }]}>
          <ShieldCheck size={22} color={colors.text} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.heading}>{action.title}</Text>
          <Text style={s.small}>{action.kind.replace(".", " · ")}</Text>
        </View>
        <Chip tint={pending ? colors.lavender : colors.green}>
          {t.details.statusLabel(action.status)}
        </Chip>
      </View>
      <Card style={{ gap: 13 }}>
        <ReviewLine label={t.details.review.account} value={action.account || w.profile.email} />
        {rows.map(([key, value]) => (
          <ReviewLine key={key} label={key.replace(/_/g, " ")} value={valueText(value)} />
        ))}
        {!rows.length && <Text style={s.muted}>{t.details.review.noDetails}</Text>}
      </Card>
      <ErrorNotice error={error || action.error} />
      {!!action.result && (
        <Card style={{ marginTop: 16, backgroundColor: colors.green, padding: 18 }}>
          <Text selectable style={s.text}>
            {resultSummary(action.result)}
          </Text>
        </Card>
      )}
      {pending ? (
        <>
          <Text style={[s.small, { marginVertical: 17 }]}>
            {t.details.review.expires(
              new Date(action.expiresAt).toLocaleString("ko-KR", {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              }),
            )}
          </Text>
          <View style={[s.row, { gap: 10, flexWrap: "wrap" }]}>
            <Button primary icon={Check} busy={busy} onPress={() => void decide("approve")}>
              {w.mode === "sample" ? t.details.review.approveLocally : t.details.review.approve}
            </Button>
            <Button icon={X} disabled={busy} onPress={() => void decide("deny")}>
              {t.details.review.deny}
            </Button>
          </View>
        </>
      ) : (
        <Button style={{ alignSelf: "flex-start", marginTop: 19 }} onPress={close}>
          {t.common.done}
        </Button>
      )}
    </Sheet>
  );
}
function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueText).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? t.common.yes : t.common.no;
  return String(value ?? "");
}
function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <Text selectable style={s.text}>
        {value}
      </Text>
    </View>
  );
}
