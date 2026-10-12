import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadDetail } from "../src/osiri/download-detail.ts";

const MB = 1024 * 1024;
test("받은 양·전체·속도·남은 시간", () => {
  assert.equal(downloadDetail(0, 150 * MB, 0), "0.0 / 150.0MB"); // 속도 모르면 양만
  assert.equal(
    downloadDetail(50 * MB, 150 * MB, 5 * MB),
    "50.0 / 150.0MB · 5.0MB/s · 약 20초 남음",
  );
  assert.equal(
    downloadDetail(10 * MB, 150 * MB, 1 * MB),
    "10.0 / 150.0MB · 1.0MB/s · 약 2분 20초 남음",
  );
});
