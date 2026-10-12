// 시각이 저장되기 전(v0.44 이전)에 쌓인 메시지의 시각을 실제 흔적에서 되찾는다 (마스터 2026-10-12 «메세지마다 날짜·시간 표시»).
// 지어내지 않는다 — 출처가 있는 것만 정확한 시각(times)으로, 없으면 같은 턴의 앞 시각을 «근사»(approx)로 따로 돌려준다.
//  1) 메시지 id 에 박힌 생성 시각 ms (`user-1791720849973-…` · `openai-…`) — 클라이언트·모델 어댑터가 만들 때 찍은 값
//  2) 검색 색인 시각 — 저장 직후 색인되므로 답이 끝난 시각과 거의 같다. 단 앞 메시지 뒤 10분 안일 때만:
//     색인 기능(10-11) 이전 대화는 서버 시작 때 한꺼번에 색인돼서 하루씩 늦다(라이브 실측 83,602~125,947초)
const ID_MS = /^[a-z]+-(\d{13})-/;
const INDEX_WINDOW_MS = 10 * 60 * 1000;

export function recoverTimes(
  messages: { id: string }[],
  saved: Record<string, string>,
  indexed: Map<string, Date>,
  now = Date.now(),
): { times: Record<string, string>; approx: Record<string, string> } {
  const times: Record<string, string> = {};
  const approx: Record<string, string> = {};
  let last: number | undefined;
  for (const { id } of messages) {
    const fromId = Number(ID_MS.exec(id)?.[1]);
    const at = indexed.get(id)?.getTime();
    const exact = saved[id]
      ? Date.parse(saved[id])
      : fromId > 0 && fromId <= now
        ? fromId
        : at !== undefined && last !== undefined && at >= last && at - last <= INDEX_WINDOW_MS
          ? at
          : undefined;
    if (exact !== undefined && !Number.isNaN(exact)) {
      times[id] = new Date(exact).toISOString();
      last = exact;
    } else if (last !== undefined) approx[id] = new Date(last).toISOString();
  }
  return { times, approx };
}
