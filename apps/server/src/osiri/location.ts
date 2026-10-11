// 사용자 위치(GPS) — 날씨·주변·길 묻기에 쓰려고 앱이 올린 마지막 위치 하나만 둔다(records kind "location", id "me").
// 개인정보라 본인 owner 에만 쓰고 읽으며, 끄면 좌표를 지우고 다시 켤 때까지 받지 않는다.
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../db.ts";

export interface UserLocation {
  id: "me";
  enabled: boolean;
  lat?: number;
  lng?: number;
  /** 미터 */
  accuracy?: number;
  /** 기기가 역지오코딩한 주소(없을 수 있다 — 웹은 좌표만) */
  address?: string;
  at?: string;
}
/** 이보다 오래된 위치는 답에 쓰지 않는다 — 사람이 움직였을 수 있다 */
export const LOCATION_FRESH_MS = 6 * 3600 * 1000;
/** 이 안이면 «지금 위치», 넘으면 «N분 전 마지막 위치» 로 넘긴다 — 앱은 보낼 때마다(2분 간격) 새로 올린다 */
export const LOCATION_CURRENT_MS = 15 * 60 * 1000;
const KIND = "location";

export async function readLocation(db: Store, owner: string): Promise<UserLocation> {
  return (await db.get<UserLocation>(owner, KIND, "me")) ?? { id: "me", enabled: true };
}

/**
 * 대화 프롬프트의 «지금» 한 줄 — 한국 시각 기준.
 * ponytail: 지인 앱이라 시간대는 Asia/Seoul 고정 — 해외 사용자가 생기면 폰이 올리는 시간대로
 */
export function nowNote(now = new Date()) {
  const kst = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  return `Now: ${kst} (Korea time, Asia/Seoul). Resolve relative dates like 오늘·내일·이번 주 in Korea time without asking the user for a time zone.`;
}

/** 대화 프롬프트에 붙일 한 줄. 꺼졌거나 오래됐거나 없으면 undefined */
export async function locationNote(
  db: Store,
  owner: string,
  now = Date.now(),
): Promise<string | undefined> {
  const where = await readLocation(db, owner);
  if (!where.enabled || where.lat === undefined || where.lng === undefined || !where.at) return;
  const age = now - Date.parse(where.at);
  if (!(age >= 0 && age <= LOCATION_FRESH_MS)) return;
  const place = where.address ? `${where.address} ` : "";
  const minutes = Math.round(age / 60000);
  const unnamed = where.address
    ? ""
    : " Address lookup failed: do not guess a town or neighborhood name from the coordinates — say you only have the coordinates.";
  const fix = `(from their phone GPS, ${minutes} min ago, ±${Math.round(where.accuracy ?? 0)}m): ${place}(lat ${where.lat.toFixed(5)}, lng ${where.lng.toFixed(5)})`;
  // 오래된 위치를 «지금 위치» 로 단정하면 이동한 사람에게 엉뚱한 곳을 말한다(2026-10-11 부산→제주)
  if (age > LOCATION_CURRENT_MS)
    return `User's LAST KNOWN location ${fix}.${unnamed} They may have moved since. If they ask where they are now, say this is the last position the phone sent ${minutes} minutes ago and may be out of date — never state it as their current location. For weather or nearby questions, use it but mention it is from ${minutes} minutes ago.`;
  return `User's current location ${fix}.${unnamed} Use it for weather, nearby places, directions and local time questions without asking where they are; do not mention coordinates unless asked.`;
}

/**
 * 날씨 — Open-Meteo(키 없음, 무료)의 지금·오늘·내일 예보. 웹 검색은 실시간 수치를 못 주는 일이 잦아 따로 둔다.
 * 값 뜻: weather_code 는 WMO 코드(0 맑음, 1~3 구름, 45·48 안개, 51~67 비, 71~77 눈, 80~82 소나기, 95~99 뇌우).
 */
export async function weatherAt(lat: number, lng: number, fetcher: typeof fetch = fetch) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    timezone: "auto",
    forecast_days: "2",
  }).toString();
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`날씨 서비스 응답 ${response.status}`);
  return { source: "Open-Meteo", ...(await response.json()) };
}

/**
 * 좌표 → «제주특별자치도 서귀포시 표선면 표선리». 웹 브라우저는 주소를 못 얻어 좌표만 보낸다 —
 * 주소 없이 넘기면 모델이 좌표로 동네를 짐작해 옆 동네(성산읍)를 말했다(2026-10-11 실측). OSM Nominatim, 키 없음.
 * ponytail: 1초 1건 제한 — 앱이 2분 간격으로만 올려서 지인 규모엔 충분, 사용자가 늘면 카카오 로컬 API 로
 */
export async function addressAt(lat: number, lng: number, fetcher: typeof fetch = fetch) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.search = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lng),
    zoom: "16",
    "accept-language": "ko",
  }).toString();
  const response = await fetcher(url, {
    headers: { "User-Agent": "0siri (openagentx.org)" },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`주소 변환 응답 ${response.status}`);
  const a = ((await response.json()) as { address?: Record<string, string> }).address ?? {};
  const parts = [
    a.province ?? a.state,
    a.city,
    a.county ?? a.borough ?? a.city_district,
    a.town ?? a.suburb,
    a.village ?? a.quarter ?? a.neighbourhood,
  ];
  return [...new Set(parts.filter(Boolean))].join(" ") || undefined;
}

export function locationRoutes(db: Store, fetcher: typeof fetch = fetch) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/location", async (c) => c.json(await readLocation(db, c.get("owner"))));
  // 앱이 위치를 올린다. 꺼 둔 사용자의 위치는 저장하지 않는다(앱이 아직 모르고 보내도)
  app.put("/location", async (c) => {
    const body = z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(1e6).optional(),
        address: z.string().trim().max(200).optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    const current = await readLocation(db, owner);
    if (!current.enabled) return c.json(current);
    // 주소를 못 얻어도 좌표는 저장한다 — 실패는 로그에 남기고, 프롬프트는 좌표만으로 동네를 짐작하지 말라고 한다
    const address =
      body.address ??
      (await addressAt(body.lat, body.lng, fetcher).catch((error: Error) => {
        console.warn(`[osiri/location] 주소 변환 실패: ${error.message}`);
        return undefined;
      }));
    const next: UserLocation = {
      id: "me",
      enabled: true,
      ...body,
      ...(address ? { address } : {}),
      at: new Date().toISOString(),
    };
    await db.put(owner, KIND, next);
    return c.json(next);
  });
  // 켜고 끄기. 끄면 좌표·주소를 지운다
  app.patch("/location", async (c) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    const owner = c.get("owner");
    const next: UserLocation = enabled
      ? { ...(await readLocation(db, owner)), enabled: true }
      : { id: "me", enabled: false };
    await db.put(owner, KIND, next);
    return c.json(next);
  });
  return app;
}
