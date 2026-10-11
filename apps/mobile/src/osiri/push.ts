// 푸시 알림(안드로이드) — 로그인 뒤 기기 FCM 토큰을 서버에 등록하고, 알림을 누르면 그 단체 톡을 연다.
// 서버 osiri/push.ts 가 FCM v1 로 보낸다. google-services.json 이 빠진 APK 는 토큰을 못 받는다 — 그 실패를 화면 알림으로 드러낸다.
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { PUSH_CHANNEL } from "../../../../packages/domain/src/osiri";
import type { MuseApi } from "../api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** 권한·채널·토큰 등록. 안드로이드가 아니면 아무것도 안 한다(웹 푸시는 아직 없음). 실패는 throw — 부르는 쪽이 화면에 알린다 */
export async function registerPush(api: MuseApi): Promise<"registered" | "denied" | "unsupported"> {
  if (Platform.OS !== "android") return "unsupported";
  // 안드로이드 8+ 는 채널이 있어야 소리·헤드업이 뜬다 (서버가 이 채널로 보낸다)
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, {
    name: "대화",
    importance: Notifications.AndroidImportance.HIGH,
  });
  // 안드로이드 13+ 는 알림 권한을 따로 묻는다
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return "denied";
  const { data: token } = await Notifications.getDevicePushTokenAsync();
  await api.request("/api/push/tokens", { token });
  return "registered";
}

/** 알림을 누르면 groupId 로 연다 (앱이 꺼져 있다 켜진 경우 포함). 해제 함수를 돌려준다 */
export function onPushOpen(open: (groupId: string) => void): () => void {
  if (Platform.OS !== "android") return () => {};
  const read = (response: Notifications.NotificationResponse | null) => {
    const groupId = response?.notification.request.content.data?.groupId;
    if (typeof groupId === "string") open(groupId);
  };
  void Notifications.getLastNotificationResponseAsync().then(read);
  const sub = Notifications.addNotificationResponseReceivedListener(read);
  return () => sub.remove();
}
