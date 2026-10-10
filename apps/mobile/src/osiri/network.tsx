// 0Siri 설정 › 초대 · 네트워크 (마스터 2026-10-10): 초대는 전화번호로만 한다 — 따로 입력하는 초대 코드는 없다.
// 서버: apps/server/src/osiri/account-routes.ts (`/api/invites` · `/api/network`).
// 트리는 항상 «나» 가 뿌리다 — 서버가 내 아래만 준다. 위(나를 들인 사람)·옆으로 가는 길은 데이터에 없으므로 화면에도 없다.
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { Platform, Pressable, Share, Text, View } from "react-native";
import {
  INVITE_STATUS_LABELS,
  type InviteStatus,
  NETWORK_NODE_STATUS_LABELS,
  type NetworkNodeStatus,
} from "../../../../packages/domain/src/osiri";
import type { Accounts, InviteView, NetworkNode } from "../../../server/src/osiri/accounts.ts";
import {
  Button,
  Card,
  Chip,
  colors,
  dateLabel,
  ErrorNotice,
  Field,
  SectionHeading,
  s,
} from "../ui";
import { useWorkspace } from "../workspace";
import { normalizePhone } from "./auth";
import { Confirm, column, columns, Loaded, mono } from "./connections";
import { useAction, useLoad } from "./store";

/** `GET /network` — 서버 `Accounts.network()` */
type Network = Awaited<ReturnType<Accounts["network"]>>;
/** `POST /invites` 응답 — 링크는 이때 한 번만 온다(서버는 토큰을 해시로만 둔다) */
type Issued = { link: string; invite: InviteView };

const text = {
  inviteTitle: "초대하기",
  inviteHint:
    "초대할 분의 전화번호를 적으면 그 번호 전용 초대 링크가 만들어집니다. 받은 분은 링크를 열어 전화번호를 확인하고 비밀번호를 등록합니다.",
  phone: "초대할 전화번호",
  phonePlaceholder: "01012345678",
  phoneRequired: "초대할 전화번호를 입력해 주세요",
  create: "초대 링크 만들기",
  issuedFor: (phone: string) => `${phone} 초대 링크`,
  issuedOnce:
    "이 링크는 지금만 보입니다. 다시 필요하면 같은 번호로 초대를 다시 만드세요 — 그러면 먼저 보낸 링크는 쓸 수 없게 됩니다.",
  copy: "복사",
  copied: "초대 링크를 복사했습니다",
  share: "공유",
  shareMessage: "0Siri 초대 링크입니다. 열어서 전화번호를 확인하고 비밀번호를 등록해 주세요.",
  selectHint: "이 환경에서는 복사·공유 버튼을 쓸 수 없습니다 — 링크를 직접 선택해 복사해 주세요.",
  sentTitle: "내가 보낸 초대",
  noSent: "보낸 초대가 없습니다 — 위에서 전화번호로 초대하면 여기에 보입니다",
  expires: (date: string) => `${date} 만료`,
  cancel: "취소",
  cancelConfirm: (phone: string) =>
    `${phone} 초대를 취소하면 보낸 링크를 더 쓸 수 없습니다. 다시 초대하려면 새 링크를 만들어야 합니다.`,
  cancelAction: "초대 취소",
  cancelled: "초대를 취소했습니다",
  treeTitle: "내 네트워크",
  treeHint: "내가 초대한 사람과, 그 사람들이 다시 초대한 사람들입니다.",
  me: "나",
  // 서버의 counts 는 가입한 회원만 센다 — 아직 가입 전인 초대는 빠진다
  direct: (n: number) => `내 초대로 가입 ${n}명`,
  total: (n: number) => `아래 전체 가입 ${n}명`,
  emptyTree: "아직 내 초대로 들어온 사람이 없습니다 — 초대를 보내면 여기에 보입니다",
  joined: (date: string) => `${date} 가입`,
  below: (n: number) => `아래 ${n}명`,
  expand: (name: string) => `${name} 아래 펼치기`,
  collapse: (name: string) => `${name} 아래 접기`,
};

const inviteTint: Record<InviteStatus, string> = {
  pending: colors.accentSoft,
  joined: colors.okBg,
  expired: colors.warnBg,
};
const nodeTint: Record<NetworkNodeStatus, string> = {
  joined: colors.okBg,
  invited: colors.accentSoft,
};

// 복사·공유는 있는 환경에서만 버튼을 둔다 (눌러도 아무 일 없는 버튼을 두지 않는다)
const canCopy = Platform.OS === "web" && typeof navigator !== "undefined" && !!navigator.clipboard;
const canShare =
  Platform.OS !== "web" ||
  (typeof navigator !== "undefined" && typeof navigator.share === "function");
async function shareLink(link: string) {
  if (Platform.OS !== "web") {
    await Share.share({ message: `${text.shareMessage}\n${link}` });
    return;
  }
  try {
    await navigator.share({ text: text.shareMessage, url: link });
  } catch (e) {
    // 공유 창을 사용자가 닫은 것은 실패가 아니다 — 그 밖의 사유는 그대로 올린다
    if (e instanceof Error && e.name === "AbortError") return;
    throw e;
  }
}

export function NetworkScreen() {
  const { api } = useWorkspace();
  const invites = useLoad(() => api.request<InviteView[]>("/api/invites"));
  const network = useLoad(() => api.request<Network>("/api/network"));
  // 초대를 만들거나 취소하면 목록과 트리(초대 중인 잎)가 같이 바뀐다 — 둘 다 서버에서 다시 읽는다
  const refresh = () => {
    invites.retry();
    network.retry();
  };
  return (
    <View style={columns}>
      <View style={column}>
        <InviteForm onIssued={refresh} />
        <View>
          <SectionHeading title={text.sentTitle} />
          <Card style={{ gap: 12 }}>
            <Loaded state={invites}>
              {(items) =>
                items.length === 0 ? (
                  <Text style={s.small}>{text.noSent}</Text>
                ) : (
                  items.map((invite) => (
                    <SentInvite key={invite.id} invite={invite} onCancelled={refresh} />
                  ))
                )
              }
            </Loaded>
          </Card>
        </View>
      </View>
      <View style={column}>
        <View>
          <SectionHeading title={text.treeTitle} />
          <Card style={{ gap: 12 }}>
            <Loaded state={network} rows={4}>
              {(data) => <Tree network={data} />}
            </Loaded>
          </Card>
        </View>
      </View>
    </View>
  );
}

function InviteForm({ onIssued }: { onIssued: () => void }) {
  const { api, notify } = useWorkspace();
  const [phone, setPhone] = useState("");
  const [issued, setIssued] = useState<Issued>();
  const create = useAction();
  const send = useAction(); // 복사·공유 실패 사유
  const submit = () =>
    create.run(async () => {
      const normalized = normalizePhone(phone);
      if (!normalized) throw new Error(text.phoneRequired);
      setIssued(await api.request<Issued>("/api/invites", { phone: normalized }));
      setPhone("");
      onIssued();
    });
  return (
    <View>
      <SectionHeading title={text.inviteTitle} />
      <Card style={{ gap: 12 }}>
        <Text style={s.small}>{text.inviteHint}</Text>
        <Field
          label={text.phone}
          value={phone}
          onChangeText={(v) => setPhone(v.replace(/[^\d+]/g, ""))}
          keyboardType="phone-pad"
          placeholder={text.phonePlaceholder}
          onSubmitEditing={() => void submit()}
        />
        <ErrorNotice error={create.error} />
        <Button small primary busy={create.busy} onPress={() => void submit()}>
          {text.create}
        </Button>
        {issued && (
          <View
            accessibilityRole="alert"
            style={{ gap: 8, padding: 12, borderRadius: 10, backgroundColor: colors.okBg }}
          >
            <Text style={[s.text, { fontWeight: "600" }]}>
              {text.issuedFor(issued.invite.phone)}
            </Text>
            <Text selectable style={[s.text, mono]}>
              {issued.link}
            </Text>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              {canCopy && (
                <Button
                  small
                  busy={send.busy}
                  onPress={() =>
                    void send.run(async () => {
                      await navigator.clipboard.writeText(issued.link);
                      notify(text.copied);
                    })
                  }
                >
                  {text.copy}
                </Button>
              )}
              {canShare && (
                <Button
                  small
                  primary
                  busy={send.busy}
                  onPress={() => void send.run(() => shareLink(issued.link))}
                >
                  {text.share}
                </Button>
              )}
            </View>
            {!canCopy && !canShare && <Text style={s.small}>{text.selectHint}</Text>}
            <ErrorNotice error={send.error} />
            <Text style={s.small}>{text.issuedOnce}</Text>
          </View>
        )}
      </Card>
    </View>
  );
}

function SentInvite({ invite, onCancelled }: { invite: InviteView; onCancelled: () => void }) {
  const { api, notify } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const cancel = useAction();
  return (
    <View style={{ gap: 8 }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8, flexWrap: "wrap", flexShrink: 1 }]}>
          <Text style={[s.text, mono]}>{invite.phone}</Text>
          <Chip tint={inviteTint[invite.status]}>{INVITE_STATUS_LABELS[invite.status]}</Chip>
          {invite.status === "pending" && (
            <Text style={s.small}>{text.expires(dateLabel(invite.expiresAt))}</Text>
          )}
        </View>
        {invite.status === "pending" && !confirming && (
          <Button small danger onPress={() => setConfirming(true)}>
            {text.cancel}
          </Button>
        )}
      </View>
      {confirming && (
        <Confirm
          message={text.cancelConfirm(invite.phone)}
          action={text.cancelAction}
          busy={cancel.busy}
          error={cancel.error}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            void cancel.run(async () => {
              await api.request(
                `/api/invites/${encodeURIComponent(invite.id)}`,
                undefined,
                "DELETE",
              );
              notify(text.cancelled);
              onCancelled();
            })
          }
        />
      )}
    </View>
  );
}

// ---- 트리 ----
/** 처음에는 바로 아래 두 단계까지 펼쳐 둔다 — 그 아래는 눌러서 연다 */
const OPEN_DEPTH = 2;

function Tree({ network }: { network: Network }) {
  const { root, counts } = network;
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.small}>{text.treeHint}</Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Chip tint={colors.accentSoft}>{text.me}</Chip>
        <Text style={[s.text, { fontWeight: "600" }]}>{root.name ?? root.phone}</Text>
        <Text style={[s.small, mono]}>
          {text.direct(counts.direct)} · {text.total(counts.total)}
        </Text>
      </View>
      {root.children.length === 0 ? (
        <Text style={s.small}>{text.emptyTree}</Text>
      ) : (
        <Branch nodes={root.children} depth={1} />
      )}
    </View>
  );
}

/** 한 단계 들여쓰기 + 세로 줄. 단계마다 한 번씩 겹쳐져 깊이가 그대로 보인다. */
function Branch({ nodes, depth }: { nodes: NetworkNode[]; depth: number }) {
  return (
    <View
      style={{
        marginLeft: 7,
        paddingLeft: 9,
        borderLeftWidth: 1,
        borderLeftColor: colors.line,
        gap: 2,
      }}
    >
      {nodes.map((node) => (
        <NodeRow key={`${node.status}:${node.id}`} node={node} depth={depth} />
      ))}
    </View>
  );
}

function NodeRow({ node, depth }: { node: NetworkNode; depth: number }) {
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const hasChildren = node.children.length > 0;
  // 이름이 없으면(가입 전 초대 · 이름을 안 정한 회원) 번호가 곧 이름표다 — 지어낸 이름을 두지 않는다
  const name = node.name ?? node.phone;
  const Arrow = open ? ChevronDown : ChevronRight;
  const line = (
    <View style={[s.row, { gap: 8, flexWrap: "wrap", flex: 1, minHeight: 40 }]}>
      {hasChildren ? <Arrow size={16} color={colors.muted} /> : <View style={{ width: 16 }} />}
      {node.name === null ? (
        <Text style={[s.text, mono]}>{node.phone}</Text>
      ) : (
        <>
          <Text style={[s.text, { fontWeight: "500" }]}>{node.name}</Text>
          <Text style={[s.small, mono]}>{node.phone}</Text>
        </>
      )}
      <Chip tint={nodeTint[node.status]}>{NETWORK_NODE_STATUS_LABELS[node.status]}</Chip>
      {node.joinedAt !== null && (
        <Text style={s.small}>{text.joined(dateLabel(node.joinedAt))}</Text>
      )}
      {hasChildren && !open && (
        <Text style={[s.small, mono]}>{text.below(node.children.length)}</Text>
      )}
    </View>
  );
  return (
    <View>
      {hasChildren ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? text.collapse(name) : text.expand(name)}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={({ pressed }) => [
            s.row,
            { borderRadius: 8 },
            pressed && { backgroundColor: colors.canvas },
          ]}
        >
          {line}
        </Pressable>
      ) : (
        <View style={s.row}>{line}</View>
      )}
      {hasChildren && open && <Branch nodes={node.children} depth={depth + 1} />}
    </View>
  );
}
