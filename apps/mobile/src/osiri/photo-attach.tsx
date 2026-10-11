// 대화에 사진 붙이기 — 서버에 올리고(/api/images) 메시지에 «[사진 id]» 를 넣는다. 서버 osiri/images.ts 가 그 표시를 이미지로 바꿔 모델에 넘긴다.
import * as DocumentPicker from "expo-document-picker";
import { useState } from "react";
import { Platform } from "react-native";
import { Button, ErrorNotice } from "../ui";
import { useWorkspace } from "../workspace";

/** 메시지에 넣는 표시 — 서버 IMAGE_MARKER 와 같은 형식 */
export const photoMarker = (id: string) => `[사진 ${id}]`;
/** 말풍선에서는 표시 대신 이 글자를 보여 준다 */
export const showPhotoMarkers = (text: string) =>
  text.replace(/\[사진 [0-9a-f-]{36}\]/gi, "📷 사진");

export function PhotoAttachButton({ onAttached }: { onAttached: (marker: string) => void }) {
  const { api } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  async function pick() {
    const picked = await DocumentPicker.getDocumentAsync({
      type: "image/*",
      copyToCacheDirectory: true,
    });
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
              type: asset.mimeType ?? "image/jpeg",
            } as unknown as Blob),
        asset.name,
      );
      const saved = await api.request<{ id: string }>("/api/images", form, "POST");
      onAttached(photoMarker(saved.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button small disabled={busy} onPress={() => void pick()}>
        {busy ? "사진 올리는 중…" : "사진 올리기"}
      </Button>
      <ErrorNotice error={error} />
    </>
  );
}
