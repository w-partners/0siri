import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantMarkdown, checkboxes, isSafeAssistantUrl } from "../src/assistant-markdown.ts";

test("체크리스트 «- [ ]» 는 목록 머리만 상자 글자로 — 본문 속 «[ ]» 는 그대로", () => {
  assert.equal(
    checkboxes("- [ ] 자료 확인\n* [x] 예약\n1. [X] 명함\n본문 [ ] 그대로\n- [ ]붙음"),
    "- ☐ 자료 확인\n* ☑ 예약\n1. ☑ 명함\n본문 [ ] 그대로\n- [ ]붙음",
  );
});

test("assistant Markdown structures the reported response", () => {
  const html = assistantMarkdown.render(
    "**Short answer:** Use `SKILL.md`.\n\n- First check\n- Second check\n\n**Source URL:** https://docs.copilotkit.ai/learning",
  );
  assert.match(html, /<strong>Short answer:<\/strong>/);
  assert.match(html, /<code>SKILL\.md<\/code>/);
  assert.match(html, /<li>/);
  assert.match(html, /href="https:\/\/docs\.copilotkit\.ai\/learning"/);
  assert.doesNotMatch(html, /\*\*Short answer/);
});

test("incomplete Markdown and raw HTML stay harmless", () => {
  assert.doesNotThrow(() => assistantMarkdown.render("**Still streaming"));
  assert.match(assistantMarkdown.render("<script>alert(1)</script>"), /&lt;script&gt;/);
});

test("only absolute HTTP(S) links can open", () => {
  assert.equal(isSafeAssistantUrl("https://docs.copilotkit.ai/learning"), true);
  assert.equal(isSafeAssistantUrl("http://example.com"), true);
  for (const url of ["javascript:alert(1)", "file:///tmp/private", "//example.com", "not a URL"]) {
    assert.equal(isSafeAssistantUrl(url), false);
  }
});

test("한글: 닫는 ** 뒤에 한글이 붙어도 굵게가 풀린다", () => {
  const html = assistantMarkdown.render(
    "현재 **24.6°C(체감 26.3°C)**이며 비 올 확률은 **20%**입니다.",
  );
  assert.match(html, /<strong>24\.6°C\(체감 26\.3°C\)<\/strong>이며/);
  assert.match(html, /<strong>20%<\/strong>입니다/);
  assert.doesNotMatch(html, /\*\*/);
});
