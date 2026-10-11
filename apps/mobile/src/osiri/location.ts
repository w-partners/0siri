// 위치(GPS) 올리기 — 날씨·주변·길 질문에 영시리가 «어디세요?» 를 묻지 않게, 대화 화면이 열릴 때 지금 위치를 서버에 둔다.
// 끄기는 설정 › 위치 (서버 PATCH /api/location). 권한을 거절하면 다시 묻지 않고 그 사실을 설정에 보인다.
import * as Location from "expo-location";
import { Platform } from "react-native";
import type { UserLocation } from "../../../server/src/osiri/location.ts";
import type { MuseApi } from "../api";

/** ponytail: 보낼 때마다 GPS 를 켜지 않게 2분에 한 번만 — 이동 중 계속 따라가야 하면 watchPosition 으로 */
const EVERY_MS = 2 * 60 * 1000;
/** 보내기 직전에 부른다 — 앱을 켠 채 이동하면 화면 열 때 올린 위치가 몇 시간째 남는다(2026-10-11 부산→제주 오답) */
const BEFORE_SEND_WAIT_MS = 4000;
let lastSent = 0;
export type LocationState = "ok" | "denied" | "off" | "error";
let state: LocationState | undefined;
export const locationState = () => state;
const settle = (next: LocationState) => {
  state = next;
  return next;
};

async function addressOf(coords: Location.LocationObjectCoords): Promise<string | undefined> {
  if (Platform.OS === "web") return; // 웹은 역지오코딩이 없다 — 좌표만 보낸다
  const [place] = await Location.reverseGeocodeAsync(coords);
  if (!place) return;
  const parts = [place.region, place.city, place.district, place.street ?? place.name];
  return [...new Set(parts.filter(Boolean))].join(" ") || undefined;
}

export async function shareLocation(api: MuseApi, force = false): Promise<LocationState> {
  if (!force && (state === "off" || state === "denied" || Date.now() - lastSent < EVERY_MS))
    return state ?? "ok";
  try {
    const current = await api.request<UserLocation>("/api/location");
    if (!current.enabled) return settle("off");
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return settle("denied");
    const { coords } = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    // 주소를 못 얻어도 좌표는 보낸다
    const address = await addressOf(coords).catch(() => undefined);
    await api.request(
      "/api/location",
      {
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: coords.accuracy ?? undefined,
        address,
      },
      "PUT",
    );
    lastSent = Date.now();
    return settle("ok");
  } catch (error) {
    console.warn(`[osiri/location] 위치를 올리지 못했습니다: ${(error as Error).message}`);
    return settle("error");
  }
}

/** GPS 를 최대 4초 기다리고 보낸다 — 늦으면 그대로 보내고 서버가 마지막 위치를 «N분 전» 으로 다룬다 */
export function shareBeforeSend(api: MuseApi): Promise<LocationState | "slow"> {
  return Promise.race([
    shareLocation(api),
    new Promise<"slow">((done) => setTimeout(() => done("slow"), BEFORE_SEND_WAIT_MS)),
  ]);
}

export async function setLocationEnabled(api: MuseApi, enabled: boolean) {
  await api.request<UserLocation>("/api/location", { enabled }, "PATCH");
  state = enabled ? undefined : "off";
  lastSent = 0;
  return enabled ? shareLocation(api, true) : "off";
}
