// 기능이 있어도 찾을 수 없으면 없는 것이다(마스터 2026-10-11). 화면 안내문이 가리키는 경로 «설정 › 연결 › …» 의
// 이름 하나하나가 실제 화면에 찍히는 글자(문자열·JSX 텍스트)로 있는지 본다. 경로는 반드시 «…» 로 감싼다.
// ponytail: 이름이 «어딘가에» 있는지만 본다 — «스토어 › 내 팀» 처럼 다른 화면의 이름을 잘못 이으면 못 잡는다.
// 계층까지 보려면 화면 목록(App.tsx 탭·설정 항목)을 도메인 상수로 올려 경로를 그 트리와 대조한다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "../apps/mobile");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
const files = [
  join(ROOT, "App.tsx"),
  ...walk(join(ROOT, "src")),
  join(ROOT, "../../packages/domain/src/osiri.ts"),
];
const code = files.map(
  (f) => [f, readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")] as const,
);

const labels = new Set<string>();
for (const [, s] of code) {
  for (const m of s.matchAll(/["'`]([^"'`\n]{1,40})["'`]/g)) labels.add(m[1].trim());
  for (const m of s.matchAll(/>\s*([^<>{}\n]{1,40}?)\s*</g)) labels.add(m[1].trim());
}

test("화면 안내문의 경로는 «…» 로 감싸고, 그 안의 이름은 모두 실제 화면에 있다", () => {
  const broken: string[] = [];
  for (const [f, s] of code) {
    for (const m of s.matchAll(/["'`]([^"'`\n]*›[^"'`\n]*)["'`]/g)) {
      const where = `${f.replace(ROOT, "mobile")}: ${m[1].slice(0, 60)}`;
      const paths = [...m[1].matchAll(/«([^»]*›[^»]*)»/g)].map((p) => p[1]);
      if (!paths.length) broken.push(`«…» 없음 — ${where}`);
      for (const path of paths)
        for (const name of path.split("›").map((x) => x.trim()))
          if (!labels.has(name)) broken.push(`«${name}» 가 화면에 없음 — ${where}`);
    }
  }
  assert.deepEqual(broken, []);
});
