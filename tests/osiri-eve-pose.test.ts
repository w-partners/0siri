// 영시리 캐릭터 포즈: 기분 → 포즈 매핑, 그리고 모든 포즈 그림이 실제로 있다(빠지면 앱이 빈 캐릭터를 그린다)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { POSES, poseFor } from "../apps/mobile/src/osiri/eve-pose.ts";

test("mood → pose: idle dozes then sleeps, work alternates, approval waits with the thinking pose", () => {
  assert.equal(poseFor("idle"), "idle");
  assert.equal(poseFor("idle", 1), "resting");
  assert.equal(poseFor("idle", 2), "sleeping");
  assert.equal(poseFor("listening", 2), "idle", "졸음은 쉴 때만");
  assert.equal(poseFor("thinking"), "working");
  assert.equal(poseFor("thinking", 0, true), "working_alt");
  assert.equal(poseFor("happy"), "success");
  assert.equal(poseFor("alert"), "thinking");
  assert.equal(poseFor("speaking"), "idle");
});

test("every pose image exists as a 320x320 RGBA PNG and eve.tsx requires each one", () => {
  const eve = readFileSync(new URL("../apps/mobile/src/osiri/eve.tsx", import.meta.url), "utf8");
  for (const pose of POSES) {
    const png = readFileSync(new URL(`../apps/mobile/assets/osiri/${pose}.png`, import.meta.url));
    assert.equal(png.toString("ascii", 1, 4), "PNG", pose);
    assert.equal(png.readUInt32BE(16), 320, `${pose} width`);
    assert.equal(png.readUInt32BE(20), 320, `${pose} height`);
    assert.equal(png[25], 6, `${pose} RGBA`);
    assert.ok(eve.includes(`require("../../assets/osiri/${pose}.png")`), `${pose} required`);
  }
});
