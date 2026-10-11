// 기기 대화(큰 층) — 웹은 아직 열지 않는다. 화면은 아래 사유를 그대로 보이고 «기기» 답변 방식을 고를 수 없게 둔다.
// ponytail: transformers.js + onnx-community/gemma-4-E2B-it-ONNX(WebGPU) 는 브라우저 캐시에 2GB 넘게 받아야 하고
// 진행률·이어 받기·메모리 부족 구분이 없다 — Android 를 먼저 검증한 뒤에 붙인다.
import type { DeviceChatMessage, NetworkKind } from "./device-chat-logic";
import type { DeviceModel, DownloadProgress } from "./device-embed.types";

export const DEVICE_CHAT_UNAVAILABLE =
  "웹에서는 아직 기기 대화를 쓸 수 없습니다 — Android 앱에서 먼저 엽니다";

export function deviceChatAvailable() {
  return false;
}
export async function bigModel(): Promise<DeviceModel> {
  return { state: "unknown", reason: DEVICE_CHAT_UNAVAILABLE };
}
export async function networkKind(): Promise<NetworkKind> {
  return "unknown";
}
export async function downloadBigModel(_onProgress?: (progress: DownloadProgress) => void) {
  throw new Error(DEVICE_CHAT_UNAVAILABLE);
}
export async function clearBigCrash() {}
export async function chatOnDevice(
  _messages: DeviceChatMessage[],
  _onText: (text: string) => void,
): Promise<string> {
  throw new Error(DEVICE_CHAT_UNAVAILABLE);
}
export async function stopDeviceChat() {}
export async function removeBigModel() {}
