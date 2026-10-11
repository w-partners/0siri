// 기기 대화(큰 층)의 순수 로직 — 런타임·화면과 떨어져 있어 테스트에서 그대로 부른다 (apps/mobile/test/device-chat-logic.test.ts).
import { BIG_LAYER, DEVICE_ANSWER_LABEL } from "../../../../packages/domain/src/osiri";

/** 지금 연결 종류. unknown = 기기가 알려 주지 않았다 */
export type NetworkKind = "wifi" | "metered" | "offline" | "unknown";
/** [켜기] 를 눌렀을 때: 바로 받는다 · 먼저 확인을 받는다 · 받지 않는다(연결 없음) */
export type DownloadGate = "start" | "confirm" | "offline";

/** Wi-Fi(·유선)일 때만 묻지 않고 받는다. 모바일 데이터이거나 종류를 모르면 확인을 받는다 */
export function downloadGate(kind: NetworkKind): DownloadGate {
  if (kind === "offline") return "offline";
  return kind === "wifi" ? "start" : "confirm";
}

/** 기기 모델에 넘기는 대화 한 줄 (llama.rn 의 OpenAI 호환 메시지) */
export interface DeviceChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
/** 앱 대화 목록의 메시지 중 여기서 읽는 부분 (AG-UI Message 와 모양이 같다) */
interface ChatMessageLike {
  id: string;
  role: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

export const DEVICE_SYSTEM_PROMPT = [
  "당신은 0Siri(영시리)입니다. 사용자의 휴대폰 안에서 돌아가는 작은 모델로 답합니다.",
  "한국어로 물으면 한국어로, 짧고 정확하게 답하세요.",
  "지금은 도구(날씨·기억·웹 검색·파일·팀 업무)를 쓸 수 없습니다. 그런 일이 필요하면 지어내지 말고, «설정 › 답변 방식» 을 서버로 바꾸면 할 수 있다고 알려 주세요.",
].join("\n");

/** 문자열이거나 텍스트 조각 배열인 내용에서 글만 꺼낸다 (첨부 등 글이 아닌 조각은 버린다) */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * 앱 대화 → 기기 모델 입력. 시스템 문장 + 최근 사용자·답변만, 글자 예산(budget) 안에서 뒤에서부터 채운다.
 * 맨 끝(방금 보낸 말)은 예산을 넘어도 넣는다. 첫 줄이 답변이면 버린다 — 채팅 틀은 사용자 말로 시작해야 한다.
 */
export function deviceChatMessages(
  history: readonly ChatMessageLike[],
  budget = 6000,
): DeviceChatMessage[] {
  const turns: DeviceChatMessage[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = textOf(message.content).trim();
    if (content) turns.push({ role: message.role, content });
  }
  const picked: DeviceChatMessage[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    if (picked.length && used + turn.content.length > budget) break;
    picked.unshift(turn);
    used += turn.content.length;
  }
  while (picked[0]?.role === "assistant") picked.shift();
  return [{ role: "system", content: DEVICE_SYSTEM_PROMPT }, ...picked];
}

/** 기기 답변 메시지에 붙이는 표시 — PUT /api/conversation 으로 함께 저장돼 다시 열어도 라벨이 남는다 */
export const deviceAnswerMetadata = () => ({
  answeredBy: { source: "device", model: BIG_LAYER.name },
});
/** 기기가 답한 메시지면 «기기에서 답함 · Gemma 4 E2B», 아니면 undefined */
export function deviceAnswerLabel(message: ChatMessageLike): string | undefined {
  const by = message.metadata?.answeredBy as { source?: unknown } | undefined;
  return by?.source === "device" ? DEVICE_ANSWER_LABEL : undefined;
}

/** id 가 같은 메시지의 내용만 바꾼 새 목록 (흘러나오는 답을 한 메시지에 이어 쓴다) */
export function withContent<T extends ChatMessageLike>(
  messages: readonly T[],
  id: string,
  content: string,
): T[] {
  return messages.map((message) => (message.id === id ? { ...message, content } : message));
}
