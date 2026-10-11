// 기기 대화(큰 층 · Gemma 4 E2B) — Android/iOS: llama.rn(llama.cpp) + GGUF 한 파일.
// 모델은 앱에 넣지 않는다. 설정 «기기 모델» 의 [켜기] 를 눌러야만 HF 허브에서 받아 앱 문서 폴더에 둔다(대화가 몰래 받지 않는다).
// 실패는 전부 throw — 호출자(chat.tsx)가 사유를 화면에 보이고 서버로 넘긴다(조용한 폴백 없음).
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";
import { initLlama, type LlamaContext } from "llama.rn";
import { TurboModuleRegistry } from "react-native";
import { BIG_LAYER, BIG_LAYER_URL } from "../../../../packages/domain/src/osiri";
import type { DeviceChatMessage, NetworkKind } from "./device-chat-logic";
import { DeviceMemoryError, type DeviceModel, type DownloadProgress } from "./device-embed.types";

const MB = 1048576;
export const DEVICE_CHAT_UNAVAILABLE =
  "이 빌드에는 기기 대화 런타임(llama.rn)이 들어 있지 않습니다 — 새 앱을 설치해야 합니다";
const NOT_DOWNLOADED = `기기 대화 모델(${BIG_LAYER.name})을 아직 받지 않았습니다 — «설정 › 기기 모델» 의 [켜기] 로 받을 수 있습니다`;
const CRASHED =
  "지난번에 기기 대화 모델을 올리다 앱이 꺼졌습니다(메모리 부족으로 보입니다) — [다시 올려 보기] 를 누르면 한 번 더 시도합니다";

function modelDir() {
  if (!FileSystem.documentDirectory) throw new Error("이 기기에는 앱 문서 폴더가 없습니다");
  return `${FileSystem.documentDirectory}models/${BIG_LAYER.repo.replace(/\//g, "--")}/`;
}
const modelUri = () => `${modelDir()}${BIG_LAYER.file}`;
const partUri = () => `${modelUri()}.part`;
/** 모델을 올리는 동안만 있는 표시 — 올리다 앱이 죽으면(메모리 부족으로 강제 종료) 남는다 */
const loadingUri = () => `${modelDir()}loading.marker`;

async function sizeOf(uri: string): Promise<number | undefined> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists ? info.size : undefined;
}

export function deviceChatAvailable() {
  return TurboModuleRegistry.get("RNLlama") != null;
}

/** 받은 파일 크기가 도메인의 bytes 와 같아야 «준비됨» 이다. 올리다 죽은 표시가 남아 있으면 oom */
export async function bigModel(): Promise<DeviceModel> {
  if (!deviceChatAvailable()) return { state: "unknown", reason: DEVICE_CHAT_UNAVAILABLE };
  const size = await sizeOf(modelUri());
  if (size === undefined) {
    const part = await sizeOf(partUri());
    return part
      ? {
          state: "none",
          reason: `받다 멈췄습니다 (${Math.floor(part / MB)} / ${Math.floor(BIG_LAYER.bytes / MB)}MB) — [켜기] 를 누르면 이어 받습니다`,
        }
      : { state: "none" };
  }
  if (size !== BIG_LAYER.bytes)
    return {
      state: "none",
      reason: `${BIG_LAYER.file} 크기가 다릅니다 — 지우고 다시 받아야 합니다`,
    };
  if ((await sizeOf(loadingUri())) !== undefined) return { state: "oom", reason: CRASHED };
  return { state: "ready" };
}

/** 지금 연결 종류 — [켜기] 가 Wi-Fi 가 아니면 확인을 받는 데 쓴다 */
export async function networkKind(): Promise<NetworkKind> {
  const state = await Network.getNetworkStateAsync();
  if (state.isConnected === false) return "offline";
  if (
    state.type === Network.NetworkStateType.WIFI ||
    state.type === Network.NetworkStateType.ETHERNET
  )
    return "wifi";
  if (state.type === Network.NetworkStateType.CELLULAR) return "metered";
  return "unknown";
}

let downloading: Promise<void> | undefined;
async function download(onProgress?: (progress: DownloadProgress) => void) {
  await FileSystem.makeDirectoryAsync(modelDir(), { intermediates: true });
  const totalBytes = BIG_LAYER.bytes;
  if ((await sizeOf(modelUri())) === totalBytes) return;
  // 크기가 다른 완성본은 버린다. 받다 만 조각(.part)은 이어 받는다
  await FileSystem.deleteAsync(modelUri(), { idempotent: true });
  let have = (await sizeOf(partUri())) ?? 0;
  if (have > totalBytes) {
    await FileSystem.deleteAsync(partUri(), { idempotent: true });
    have = 0;
  }
  const free = await FileSystem.getFreeDiskStorageAsync();
  if (free < totalBytes - have)
    throw new Error(
      `저장 공간이 모자랍니다 — 필요 ${Math.ceil((totalBytes - have) / MB)}MB · 남음 ${Math.floor(free / MB)}MB`,
    );
  onProgress?.({ receivedBytes: have, totalBytes });
  if (have < totalBytes) {
    const task = FileSystem.createDownloadResumable(
      BIG_LAYER_URL,
      partUri(),
      {},
      (p) => onProgress?.({ receivedBytes: have + p.totalBytesWritten, totalBytes }),
      have > 0 ? String(have) : undefined, // 이어 받기: 이 바이트부터 (Range)
    );
    const result = have > 0 ? await task.resumeAsync() : await task.downloadAsync();
    // 조각은 지우지 않는다 — 네트워크가 끊긴 것이면 다음 [켜기] 가 이어 받는다. 오류 응답 본문이 적힌 경우만 지운다
    if (!result || (result.status !== 200 && result.status !== 206)) {
      await FileSystem.deleteAsync(partUri(), { idempotent: true });
      throw new Error(
        `${BIG_LAYER.file} 를 받지 못했습니다 (HTTP ${result?.status ?? "응답 없음"})`,
      );
    }
  }
  const got = await sizeOf(partUri());
  if (got !== totalBytes) {
    await FileSystem.deleteAsync(partUri(), { idempotent: true });
    throw new Error(
      `${BIG_LAYER.file} 크기가 다릅니다 (받음 ${got ?? 0} · 허브 ${totalBytes}바이트) — 다시 받아 주세요`,
    );
  }
  await FileSystem.moveAsync({ from: partUri(), to: modelUri() });
  onProgress?.({ receivedBytes: totalBytes, totalBytes });
}

/** 설정의 [켜기]: 내려받는다(이어 받기). 올리기는 첫 대화 때 한다 — 받기와 메모리 실패를 따로 보이게 */
export async function downloadBigModel(onProgress?: (progress: DownloadProgress) => void) {
  if (!deviceChatAvailable()) throw new Error(DEVICE_CHAT_UNAVAILABLE);
  downloading ??= download(onProgress).finally(() => {
    downloading = undefined;
  });
  await downloading;
}

// ---- 올리기·답하기 ----
let context: Promise<LlamaContext> | undefined;
async function load(): Promise<LlamaContext> {
  const model = await bigModel();
  if (model.state === "oom") throw new DeviceMemoryError(CRASHED);
  if (model.state !== "ready") throw new Error(model.reason ?? NOT_DOWNLOADED);
  await FileSystem.writeAsStringAsync(loadingUri(), new Date().toISOString());
  try {
    // ponytail: CPU 만 쓴다(n_gpu_layers 0) — OpenCL(Adreno) 가속은 실기기 실측 뒤에 켠다
    return await initLlama({
      model: modelUri(),
      n_ctx: 4096,
      n_batch: 512,
      n_gpu_layers: 0,
      use_mmap: true,
      use_mlock: false,
    });
  } finally {
    await FileSystem.deleteAsync(loadingUri(), { idempotent: true });
  }
}
function ensureLoaded() {
  context ??= load().catch((e) => {
    context = undefined; // 다음 호출에 다시 시도
    throw e;
  });
  return context;
}

/** 지난번 «메모리 부족» 표시를 지운다 — 사용자가 [다시 올려 보기] 를 누른 것이다 */
export async function clearBigCrash() {
  await FileSystem.deleteAsync(loadingUri(), { idempotent: true });
}

/**
 * 기기에서 답한다. 채팅 틀(Gemma 4)은 GGUF 에 든 jinja 틀을 llama.rn 이 그대로 쓴다 — 토큰을 손으로 잇지 않는다.
 * onText 는 지금까지 흘러나온 답 전체를 받는다. 멈추면(stopDeviceChat) 그때까지의 답을 돌려준다.
 */
export async function chatOnDevice(
  messages: DeviceChatMessage[],
  onText: (text: string) => void,
): Promise<string> {
  if (!deviceChatAvailable()) throw new Error(DEVICE_CHAT_UNAVAILABLE);
  const llama = await ensureLoaded();
  const result = await llama.completion(
    {
      messages,
      jinja: true,
      enable_thinking: false,
      n_predict: 1024,
      // Gemma 권장 샘플링
      temperature: 1.0,
      top_k: 64,
      top_p: 0.95,
    },
    (data) => {
      if (typeof data.content === "string") onText(data.content);
    },
  );
  return (result.content || result.text).trim();
}

export async function stopDeviceChat() {
  if (!context) return;
  await (await context).stopCompletion();
}

/** 모델 파일을 지우고 올라온 모델도 내린다 */
export async function removeBigModel() {
  const loaded = context;
  context = undefined;
  if (loaded) await (await loaded.catch(() => undefined))?.release();
  await FileSystem.deleteAsync(modelDir(), { idempotent: true });
}
