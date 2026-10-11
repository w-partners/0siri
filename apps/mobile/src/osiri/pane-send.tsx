// 방에 붙은 tmux 창(내 PC)으로 파일을 보낸다 — 러너가 그 창 폴더의 .0siri/inbox 에 쓴다. 서버 osiri/panes.ts
import * as DocumentPicker from "expo-document-picker";
import { useEffect, useState } from "react";
import { Platform, Text } from "react-native";
import type { PaneLink } from "../../../../packages/domain/src/osiri";
import { Button, ErrorNotice, s } from "../ui";
import { useWorkspace } from "../workspace";

export function PaneFileButton({
  roomId,
  onSent,
}: {
  roomId: string;
  /** PC 에 쓴 경로 — 다음 말에 넣으면 CLI 가 읽는다 */
  onSent: (path: string) => void;
}) {
  const { api } = useWorkspace();
  const [link, setLink] = useState<PaneLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.request<{ link: PaneLink | null }>(`/api/panes/${encodeURIComponent(roomId)}`).then(
      (r) => setLink(r.link),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [api, roomId]);
  if (!link) return error ? <ErrorNotice error={error} /> : null;
  async function send() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (!asset) return;
    setBusy(true);
    setError(undefined);
    try {
      const form = new FormData();
      // 웹은 File, 앱은 {uri,name,type} — React Native 의 FormData 가 그 모양을 파일로 올린다
      form.append(
        "file",
        Platform.OS === "web" && asset.file
          ? asset.file
          : ({
              uri: asset.uri,
              name: asset.name,
              type: asset.mimeType ?? "application/octet-stream",
            } as unknown as Blob),
        asset.name,
      );
      const r = await api.request<{ path: string }>(
        `/api/panes/${encodeURIComponent(roomId)}/files`,
        form,
        "POST",
      );
      onSent(r.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Text style={s.muted}>PC 로 보내면 {link.cwd}/.0siri/inbox 에 저장됩니다</Text>
      <Button small disabled={busy} onPress={() => void send()}>
        PC 로 파일 보내기
      </Button>
      <ErrorNotice error={error} />
    </>
  );
}
