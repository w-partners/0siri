// 기기 임베딩 — Android/iOS: onnxruntime-react-native(CPU) + @huggingface/tokenizers (0SIRI-SPEC §2.3 · §11).
// 서버·웹과 같은 ONNX q8 파일, 같은 토크나이저(transformers.js 가 안에서 쓰는 그 패키지)를 쓴다 → 벡터가 서로 맞는다.
// 모델은 앱에 넣지 않는다. 설정 «기기» 카드의 [받기] 를 눌러야만 HF 허브에서 받아 앱 문서 폴더에 둔다(검색이 몰래 받지 않는다).
// 실패는 전부 throw — 호출자(tier0.ts)가 서버로 넘기고 사유를 붙인다.
import * as FileSystem from "expo-file-system/legacy";
import { NativeModules } from "react-native";
import {
  EMBED_DTYPE as DTYPE,
  embedDocumentText,
  embedQueryText,
  EMBED_MODEL_ID as MODEL,
} from "../../../../packages/domain/src/osiri";
import {
  DeviceMemoryError,
  type DeviceModel,
  type DevicePrepared,
  type DeviceReport,
  type DownloadProgress,
} from "./device-embed.types";
import { measureWith, normalize, unavailableReport, type Vec } from "./device-measure";
import { loadTokenizer } from "./device-tokenizer";

/** 네이티브는 [받기] 를 눌러야만 받는다 — 지우면 그대로 «미다운로드» 가 되고, 따로 꺼 둘 것이 없다 */
export const DOWNLOADS_ON_FIRST_USE = false;

const HUB = "https://huggingface.co";
// transformers.js 가 dtype 마다 붙이는 파일 접미어 (q8 → model_quantized.onnx). 모르는 dtype 이면 받지 않고 멈춘다.
const ONNX_SUFFIX: Record<string, string> = { q8: "_quantized" };
const OUTPUT = "sentence_embedding";
const MB = 1048576;
const NO_RUNTIME = "이 빌드에는 기기 임베딩 런타임(onnxruntime)이 들어 있지 않습니다";
const NOT_DOWNLOADED = "기기 모델을 아직 받지 않았습니다 — 설정 › 기기 모델에서 받을 수 있습니다";
const CRASHED =
  "지난번에 모델을 올리다 앱이 꺼졌습니다(메모리 부족으로 보입니다) — [받기] 를 누르면 다시 올려 봅니다";

/** 허브 경로들. 가중치(.onnx_data)는 .onnx 와 같은 폴더에 같은 이름으로 있어야 런타임이 찾는다 */
function hubPaths() {
  const suffix = ONNX_SUFFIX[DTYPE];
  if (suffix === undefined) throw new Error(`기기 런타임이 모르는 양자화입니다: ${DTYPE}`);
  const onnx = `onnx/model${suffix}.onnx`;
  return { onnx, all: [onnx, `${onnx}_data`, "tokenizer.json", "tokenizer_config.json"] };
}
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
function modelDir() {
  if (!FileSystem.documentDirectory) throw new Error("이 기기에는 앱 문서 폴더가 없습니다");
  return `${FileSystem.documentDirectory}models/${MODEL.replace(/\//g, "--")}/`;
}
const local = (path: string) => `${modelDir()}${baseName(path)}`;
/** 다 받았다는 표시: 파일 이름 → 바이트. 이것과 실제 크기가 맞아야 «준비됨» 이다 */
const manifestUri = () => `${modelDir()}manifest.json`;
/** 모델을 올리는 동안만 있는 표시 — 올리다 앱이 죽으면 남는다 */
const loadingUri = () => `${modelDir()}loading.marker`;

async function sizeOf(uri: string): Promise<number | undefined> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists ? info.size : undefined;
}

type Manifest = { model: string; dtype: string; files: Record<string, number> };
async function readManifest(): Promise<Manifest | undefined> {
  if ((await sizeOf(manifestUri())) === undefined) return undefined;
  const manifest = JSON.parse(await FileSystem.readAsStringAsync(manifestUri())) as Manifest;
  return manifest.model === MODEL && manifest.dtype === DTYPE ? manifest : undefined;
}

let prepared: DevicePrepared | undefined;

export function deviceAvailable() {
  return NativeModules.Onnxruntime != null;
}

export async function deviceModel(): Promise<DeviceModel> {
  const manifest = await readManifest();
  if (!manifest) return { state: "none" };
  for (const [name, size] of Object.entries(manifest.files)) {
    const actual = await sizeOf(`${modelDir()}${name}`);
    if (actual !== size)
      return { state: "none", reason: `${name} 이 없거나 크기가 다릅니다 — 다시 받아야 합니다` };
  }
  if ((await sizeOf(loadingUri())) !== undefined) return { state: "oom", reason: CRASHED };
  return { state: "ready", prepared };
}

// ---- 내려받기 ----
/** 허브가 알려 주는 파일 크기 (받은 파일의 크기 검증·진행률·남은 공간 확인에 쓴다) */
async function hubSizes(): Promise<Record<string, number>> {
  const response = await fetch(`${HUB}/api/models/${MODEL}/tree/main?recursive=1`);
  if (!response.ok) throw new Error(`허브 파일 목록을 받지 못했습니다 (HTTP ${response.status})`);
  const entries = (await response.json()) as { path: string; size: number }[];
  return Object.fromEntries(entries.map((entry) => [entry.path, entry.size]));
}

let downloading: Promise<void> | undefined;
async function download(onProgress?: (progress: DownloadProgress) => void) {
  const dir = modelDir();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const sizes = await hubSizes();
  const files = [];
  for (const path of hubPaths().all) {
    const size = sizes[path];
    if (typeof size !== "number") throw new Error(`허브에 ${path} 가 없습니다`);
    const uri = local(path);
    const whole = (await sizeOf(uri)) === size;
    // 크기가 다른 완성본은 버린다. 받다 만 조각(.part)은 이어 받는다
    if (!whole) await FileSystem.deleteAsync(uri, { idempotent: true });
    let have = whole ? size : ((await sizeOf(`${uri}.part`)) ?? 0);
    if (have > size) {
      await FileSystem.deleteAsync(`${uri}.part`, { idempotent: true });
      have = 0;
    }
    files.push({ path, size, uri, whole, have });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let doneBytes = files.reduce((sum, file) => sum + file.have, 0);
  const free = await FileSystem.getFreeDiskStorageAsync();
  if (free < totalBytes - doneBytes)
    throw new Error(
      `저장 공간이 모자랍니다 — 필요 ${Math.ceil((totalBytes - doneBytes) / MB)}MB · 남음 ${Math.floor(free / MB)}MB`,
    );
  onProgress?.({ receivedBytes: doneBytes, totalBytes });
  for (const file of files) {
    if (file.whole) continue;
    const part = `${file.uri}.part`;
    if (file.have < file.size) {
      const before = doneBytes - file.have;
      const task = FileSystem.createDownloadResumable(
        `${HUB}/${MODEL}/resolve/main/${file.path}`,
        part,
        {},
        (p) => onProgress?.({ receivedBytes: before + p.totalBytesWritten, totalBytes }),
        file.have > 0 ? String(file.have) : undefined, // 이어 받기: 이 바이트부터 (Range)
      );
      const result = file.have > 0 ? await task.resumeAsync() : await task.downloadAsync();
      // 조각은 지우지 않는다 — 네트워크가 끊긴 것이면 다음 [받기] 가 이어 받는다. 오류 응답 본문이 적힌 경우만 지운다
      if (!result || (result.status !== 200 && result.status !== 206)) {
        await FileSystem.deleteAsync(part, { idempotent: true });
        throw new Error(`${file.path} 를 받지 못했습니다 (HTTP ${result?.status ?? "응답 없음"})`);
      }
    }
    const got = await sizeOf(part);
    if (got !== file.size) {
      await FileSystem.deleteAsync(part, { idempotent: true });
      throw new Error(
        `${file.path} 크기가 다릅니다 (받음 ${got ?? 0} · 허브 ${file.size}바이트) — 다시 받아 주세요`,
      );
    }
    await FileSystem.moveAsync({ from: part, to: file.uri });
    doneBytes += file.size - file.have;
    onProgress?.({ receivedBytes: doneBytes, totalBytes });
  }
  const manifest: Manifest = {
    model: MODEL,
    dtype: DTYPE,
    files: Object.fromEntries(files.map((file) => [baseName(file.path), file.size])),
  };
  await FileSystem.writeAsStringAsync(manifestUri(), JSON.stringify(manifest));
}

// ---- 올리기·임베딩 ----
type Embedder = { embed: (text: string) => Promise<Vec>; loadMs: number };
let loader: Promise<Embedder> | undefined;

async function load(): Promise<Embedder> {
  if (!deviceAvailable()) throw new Error(NO_RUNTIME);
  const started = performance.now();
  const model = await deviceModel();
  if (model.state === "oom") throw new DeviceMemoryError(CRASHED);
  if (model.state !== "ready") throw new Error(model.reason ?? NOT_DOWNLOADED);
  await FileSystem.writeAsStringAsync(loadingUri(), new Date().toISOString());
  try {
    const ort = await import("onnxruntime-react-native");
    // 어휘가 커서 Hermes 에서는 라이브러리 기본 적재가 토큰을 잃는다 — device-tokenizer.ts 참조
    const { tokenizer } = loadTokenizer(
      await FileSystem.readAsStringAsync(local("tokenizer.json")),
      await FileSystem.readAsStringAsync(local("tokenizer_config.json")),
    );
    const session = await ort.InferenceSession.create(
      local(hubPaths().onnx).replace(/^file:\/\//, ""),
    );
    const embed = async (text: string) => {
      const ids = tokenizer.encode(text).ids;
      const shape = [1, ids.length];
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
        attention_mask: new ort.Tensor(
          "int64",
          new BigInt64Array(ids.length).fill(BigInt(1)),
          shape,
        ),
      };
      // 텍스트 전용: 이미지·영상·오디오 소프트 토큰은 0개를 넣는다 (transformers.js EmbeddingGemma2Model.forward 와 같다)
      for (const input of session.inputMetadata) {
        if (input.name in feeds) continue;
        const width = input.isTensor ? input.shape.at(-1) : undefined;
        if (typeof width !== "number")
          throw new Error(`모델 입력 ${input.name} 의 모양을 알 수 없습니다`);
        feeds[input.name] = new ort.Tensor("float32", new Float32Array(0), [0, width]);
      }
      const output = (await session.run(feeds, [OUTPUT]))[OUTPUT];
      if (!output) throw new Error(`모델 출력에 ${OUTPUT} 이 없습니다`);
      return normalize(output.data as Float32Array);
    };
    return { embed, loadMs: Math.round(performance.now() - started) };
  } finally {
    await FileSystem.deleteAsync(loadingUri(), { idempotent: true });
  }
}

function ensureLoaded() {
  loader ??= load().catch((e) => {
    loader = undefined; // 다음 호출에 다시 시도
    throw e;
  });
  return loader;
}

let queue: Promise<unknown> = Promise.resolve();
export function embedOnDevice(texts: string[], kind: "query" | "document"): Promise<Vec[]> {
  // 한 번에 한 문장씩, 줄 세워 돌린다 — 겹쳐 돌리면 메모리만 더 쓰고 빨라지지 않는다
  const run = queue.then(async () => {
    const { embed } = await ensureLoaded();
    const vectors: Vec[] = [];
    for (const text of texts)
      vectors.push(await embed(kind === "query" ? embedQueryText(text) : embedDocumentText(text)));
    return vectors;
  });
  queue = run.catch(() => undefined); // 실패는 부른 쪽이 받는다 — 줄만 이어 간다
  return run;
}

/** 설정 «기기» 카드의 [받기]: 내려받고(이어 받기) → 올리고 → 문장 하나를 돌려 잰다 */
export async function prepareDevice(
  onProgress?: (progress: DownloadProgress) => void,
): Promise<DevicePrepared> {
  if (!deviceAvailable()) throw new Error(NO_RUNTIME);
  downloading ??= download(onProgress).finally(() => {
    downloading = undefined;
  });
  await downloading;
  // 사용자가 다시 누른 것이다 — 지난번에 죽은 표시를 지우고 한 번 더 올려 본다
  await FileSystem.deleteAsync(loadingUri(), { idempotent: true });
  const { loadMs } = await ensureLoaded();
  const started = performance.now();
  await embedOnDevice(["상태 확인"], "query");
  prepared = { loadMs, embedMs: Math.round(performance.now() - started) };
  return prepared;
}

/** 모델 파일을 지운다. 이미 올라온 모델은 앱을 다시 켤 때까지 메모리에 남는다 */
export async function removeModel() {
  await FileSystem.deleteAsync(modelDir(), { idempotent: true });
  loader = undefined;
  prepared = undefined;
}

/** 9단계 실측. 받지 않았으면 받지 않고 사유를 돌려준다 */
export async function measureDevice(): Promise<DeviceReport> {
  if (!deviceAvailable()) return unavailableReport(NO_RUNTIME);
  return measureWith(
    async () => ({ backend: "cpu", loadMs: (await ensureLoaded()).loadMs }),
    embedOnDevice,
    () => undefined, // ponytail: 네이티브 메모리 사용량은 JS 에서 잴 방법이 없다 — 재려면 네이티브 모듈이 필요하다
  );
}
