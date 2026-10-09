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
  } catch {
    return {};
  }
}
function saveCache(cache: Record<string, number[]>) {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 저장 공간 없음 — 다음에 다시 계산한다 */
  }
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
  try {
    const cache = await indexMemories(memories);
    const [q] = await embedOnDevice([query], "query");
    const items = memories
      .map((m) => ({ ...m, score: dot(q as number[], cache[m.id] as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { items, servedBy: "device" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const items = await api.request<Memory[]>(
      `/api/memories?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    void api
      .request("/api/usage/device", {
        tier: 0,
        model: "device-embed",
        reason: `fallback:${reason}`.slice(0, 200),
      })
      .catch(() => undefined); // 라우팅 로그에 fallback_reason 을 남긴다 (실패해도 검색은 계속)
    return { items, servedBy: "server", reason };
  }
}

function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}
