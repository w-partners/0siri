// 티어 0 기억 검색 (0SIRI-SPEC §11.1): 기기 임베딩이 되면 기기에서, 안 되면 서버 /memories?q= 로.
// 어느 쪽이 답했는지 `servedBy` 로 돌려준다 — 화면은 "기기에서 검색함 / 서버에서 검색함" 배지를 숨기지 않는다.
import type { Memory as ServerMemory } from "../../../server/src/osiri/memories.ts";
import type { MuseApi } from "../api";
import { embedOnDevice } from "./device-embed";

export type Memory = ServerMemory & { score?: number };
export interface SearchResult {
  items: Memory[];
  servedBy: "device" | "server";
  reason?: string; // 서버로 넘어간 이유 (기기 실패 시)
}

const CACHE_KEY = "osiri.memvec";
// ponytail: 벡터 캐시는 localStorage(웹). 네이티브는 기기 임베딩이 없어 캐시도 없다
function loadCache(): Record<string, number[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) ?? "{}");
  } catch (e) {
    // ponytail: 캐시는 다시 만들 수 있는 사본이다 — 못 읽으면 벡터를 새로 계산할 뿐 결과는 같다. 흔적만 남긴다
    console.warn(`[osiri/tier0] 벡터 캐시를 읽지 못해 다시 계산합니다: ${String(e)}`);
    return {};
  }
}
function saveCache(cache: Record<string, number[]>) {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // ponytail: 저장 공간 부족 — 이번 검색 결과는 그대로고 다음 검색 때 다시 계산한다. 흔적만 남긴다
    console.warn(`[osiri/tier0] 벡터 캐시를 저장하지 못했습니다: ${String(e)}`);
  }
}

// 기기 검색 끔 — 설정에서 작은 층을 [삭제] 하면 켜진다. 이 기기에만 해당하는 값이라 기기 저장소에 둔다.
// 읽기·쓰기 실패는 삼키지 않는다: 끈 줄 알았는데 모델을 다시 받는 일이 없게 부르는 쪽이 사유를 보인다.
const DEVICE_OFF_KEY = "osiri.deviceSearchOff";
export const DEVICE_OFF_REASON = "설정에서 기기 검색을 꺼 두었습니다";
export function deviceSearchOff(): boolean {
  return globalThis.localStorage?.getItem(DEVICE_OFF_KEY) === "1";
}
export function setDeviceSearchOff(off: boolean) {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("이 환경에는 설정을 저장할 기기 저장소가 없습니다");
  if (off) {
    storage.setItem(DEVICE_OFF_KEY, "1");
    storage.removeItem(CACHE_KEY); // 지운 모델로 만든 벡터도 같이 지운다
  } else storage.removeItem(DEVICE_OFF_KEY);
}

/** 오프라인 대비: 기억 목록을 로컬에 두고 벡터를 미리 만든다 */
export async function indexMemories(memories: Memory[]) {
  const cache = loadCache();
  const missing = memories.filter((m) => !cache[m.id]);
  if (missing.length) {
    const vectors = await embedOnDevice(
      missing.map((m) => m.text),
      "document",
    );
    missing.forEach((m, i) => {
      cache[m.id] = vectors[i] as number[];
    });
    for (const id of Object.keys(cache)) if (!memories.some((m) => m.id === id)) delete cache[id];
    saveCache(cache);
  }
  return cache;
}

export async function searchMemories(
  api: MuseApi,
  query: string,
  memories: Memory[],
  limit = 10,
): Promise<SearchResult> {
  const serverSearch = () =>
    api.request<Memory[]>(`/api/memories?q=${encodeURIComponent(query)}&limit=${limit}`);
  // 사용자가 끈 것은 실패가 아니다 — 모델을 다시 받지 않고 곧장 서버 검색으로 간다 (라우팅 로그에 fallback 으로 적지 않는다)
  if (deviceSearchOff())
    return { items: await serverSearch(), servedBy: "server", reason: DEVICE_OFF_REASON };
  try {
    // ponytail: 첫 검색은 모델 다운로드(~300MB)를 기다리지 않는다 — 서버로 답하고 모델은 뒤에서 계속 받는다(loader 유지)
    const cache = await withTimeout(indexMemories(memories), DEVICE_WAIT_MS, "기기 색인");
    const [q] = await withTimeout(embedOnDevice([query], "query"), DEVICE_WAIT_MS, "기기 임베딩");
    const items = memories
      .map((m) => ({ ...m, score: dot(q as number[], cache[m.id] as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { items, servedBy: "device" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const items = await serverSearch();
    // 라우팅 로그에 fallback_reason 을 남긴다
    void api
      .request("/api/usage/device", {
        tier: 0,
        model: "device-embed",
        reason: `fallback:${reason}`.slice(0, 200),
      })
      .catch((logError) => {
        // ponytail: 통계 적재일 뿐이라 검색 결과는 그대로 돌려준다(사유는 화면의 reason 에 이미 있다). 적재 실패는 흔적만 남긴다
        console.warn(
          `[osiri/tier0] 폴백 사유를 라우팅 로그에 남기지 못했습니다: ${String(logError)}`,
        );
      });
    return { items, servedBy: "server", reason };
  }
}

const DEVICE_WAIT_MS = 4000;
function withTimeout<T>(p: Promise<T>, ms: number, what: string) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} ${ms}ms 초과 — 기기 모델 준비 중`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}
