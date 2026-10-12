import MarkdownIt from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";

// 한글: «**24°C(체감)**이며» 처럼 닫는 ** 뒤에 한글이 바로 붙어도 굵게가 풀리게 (CommonMark 기본은 안 풀린다)
export const assistantMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
}).use(cjkFriendly);

// 체크리스트 «- [ ] 할 일» — markdown-it 은 GFM 작업 목록을 몰라 «[ ]» 가 글자로 나온다. 목록 줄 머리만 상자 글자로 바꾼다
// ponytail: 눌러서 체크하는 기능은 없다 — 표시만. 필요해지면 markdown-it-task-lists 로
export const checkboxes = (content: string) =>
  content.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s)/gm,
    (_, head: string, mark: string) => `${head}${mark === " " ? "☐" : "☑"}`,
  );

export function isSafeAssistantUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}
