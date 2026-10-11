// 대화에 붙이는 사진. 앱이 올리고, 메시지는 «[사진 <id>]» 표시로 가리킨다 — 대화 기록에 base64 를 싣지 않는다.
// 서버는 이번 턴의 메시지에 있는 표시만 실제 이미지로 바꿔 모델에 넘긴다. 본인 owner 의 사진만 읽는다.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

const KIND = "images";
const MAX_BYTES = 10 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 메시지 안의 사진 표시 — 앱(chat.tsx)이 같은 형식으로 넣는다 */
export const IMAGE_MARKER = /\[사진 ([0-9a-f-]{36})\]/gi;

interface ImageRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

/** 파일 머리 바이트로 형식을 정한다 — 이름·브라우저가 준 타입은 믿지 않는다 */
export function imageType(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
}

export class Images {
  constructor(
    private readonly db: Store,
    private readonly dataDir: string,
  ) {}
  private path(id: string) {
    if (!ID.test(id)) throw new AppError("사진을 찾을 수 없습니다", 404);
    return join(this.dataDir, "images", id);
  }
  async save(owner: string, name: string, bytes: Uint8Array) {
    if (bytes.length > MAX_BYTES) throw new AppError("사진은 10MB 이하만 올릴 수 있습니다", 413);
    const mimeType = imageType(bytes);
    // ponytail: 아이폰 HEIC 는 모델이 못 읽는다 — 아이폰 사용자가 생기면 서버에서 JPEG 로 바꾼다
    if (!mimeType) throw new AppError("PNG·JPEG·WEBP·GIF 사진만 올릴 수 있습니다", 422);
    const id = randomUUID();
    await mkdir(join(this.dataDir, "images"), { recursive: true, mode: 0o700 });
    await writeFile(this.path(id), bytes, { mode: 0o600, flag: "wx" });
    const record: ImageRecord = {
      id,
      name: name.slice(0, 120) || "photo",
      mimeType,
      size: bytes.length,
      createdAt: new Date().toISOString(),
    };
    await this.db.put(owner, KIND, record);
    return record;
  }
  async load(owner: string, id: string) {
    const record = await this.db.get<ImageRecord>(owner, KIND, id);
    if (!record) throw new AppError("사진을 찾을 수 없습니다", 404);
    return { ...record, bytes: await readFile(this.path(id)) };
  }
  /**
   * 사용자 메시지의 사진 표시를 모델이 보는 이미지 파트로 바꾼다. 표시가 없으면 그대로 돌려준다.
   * 못 읽은 사진은 숨기지 않고 글로 남겨 모델이 «사진을 못 열었다» 고 말하게 한다.
   */
  async expand(owner: string, text: string) {
    const ids = [...text.matchAll(IMAGE_MARKER)].map((m) => m[1] as string);
    if (!ids.length) return text;
    const parts: (
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "data"; value: string; mimeType: string } }
    )[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const image = await this.load(owner, id);
        parts.push({
          type: "image",
          source: { type: "data", value: image.bytes.toString("base64"), mimeType: image.mimeType },
        });
      } catch (error) {
        console.error(
          `[osiri/images] 사진 ${id} 읽기 실패: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed.push(id);
      }
    }
    const note = failed.length
      ? `\n\n(첨부 사진 ${failed.length}장을 서버에서 열지 못했습니다 — 사용자에게 다시 올려 달라고 하세요)`
      : "";
    return [
      { type: "text" as const, text: text.replace(IMAGE_MARKER, "").trim() + note },
      ...parts,
    ];
  }
}

export function imageRoutes(images: Images) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.post("/images", async (c) => {
    const file = (await c.req.parseBody()).file;
    if (!(file instanceof File)) throw new AppError("사진 파일을 선택하세요.");
    const saved = await images.save(
      c.get("owner"),
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    return c.json(saved, 201);
  });
  app.get("/images/:id", async (c) => {
    const image = await images.load(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", image.mimeType);
    c.header("Cache-Control", "private, max-age=86400");
    return c.body(image.bytes);
  });
  return app;
}
