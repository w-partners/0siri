// 자동 업데이트 (마스터 2026-10-10 "앱은 자동업데이트가 되도록, 설치 승인은 사람이 하더라도").
// 서버 /releases/latest.json 과 내 버전을 비교해 새 버전이면 APK 를 미리 받아 두고,
// 버튼 한 번으로 안드로이드 설치 화면을 연다 — 설치 승인은 사람이 한다. 웹은 서버가 곧 최신이라 대상 아님.
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import appJson from "../../app.json";
import { apiBase } from "../api";
import { Button, colors, s } from "../ui";

type Latest = { version: string; url: string; sha256: string; size: number };

export function isNewer(candidate: string, current: string) {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

const text = {
  downloading: (v: string) => `새 버전 v${v} 내려받는 중…`,
  ready: (v: string) => `새 버전 v${v} 준비됨`,
  install: "설치",
  failed: (why: string) => `업데이트 확인 실패: ${why}`,
};

export function UpdateBanner() {
  const [latest, setLatest] = useState<Latest>();
  const [file, setFile] = useState<string>();
  const [status, setStatus] = useState("");

  const check = useCallback(async () => {
    if (Platform.OS !== "android") return;
    try {
      const res = await fetch(`${apiBase()}/releases/latest.json`, { cache: "no-store" });
      if (res.status === 404) return; // 릴리스를 안 내는 서버 — 기능 미구성이지 실패가 아니다
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as Latest;
      if (!isNewer(next.version, appJson.expo.version)) {
        setLatest(undefined);
        return;
      }
      setLatest(next);
      const dest = `${FileSystem.cacheDirectory}0siri-${next.version}.apk`;
      const info = await FileSystem.getInfoAsync(dest);
      // ponytail: 크기만 대조한다. sha256 은 120MB 를 JS 로 해시해야 해서 뺐다 — 출처가 우리 HTTPS 도메인 하나다
      if (!(info.exists && info.size === next.size)) {
        setStatus(text.downloading(next.version));
        const url = next.url.startsWith("http") ? next.url : `${apiBase()}${next.url}`;
        const dl = await FileSystem.downloadAsync(url, dest);
        if (dl.status !== 200) throw new Error(`다운로드 ${dl.status}`);
      }
      setFile(dest);
      setStatus("");
    } catch (e) {
      setStatus(text.failed(e instanceof Error ? e.message : String(e)));
    }
  }, []);

  useEffect(() => {
    void check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => sub.remove();
  }, [check]);

  const install = async () => {
    if (!file) return;
    const uri = await FileSystem.getContentUriAsync(file);
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: uri,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      type: "application/vnd.android.package-archive",
    });
  };

  if (!latest && !status) return null;
  return (
    <View
      style={[
        s.row,
        {
          justifyContent: "space-between",
          marginHorizontal: 16,
          marginTop: 6,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 14,
          backgroundColor: colors.lavender,
        },
      ]}
    >
      <Text style={[s.small, { flex: 1 }]}>
        {status || (latest ? text.ready(latest.version) : "")}
      </Text>
      {file && <Button onPress={() => void install()}>{text.install}</Button>}
    </View>
  );
}
