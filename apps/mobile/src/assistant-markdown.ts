import MarkdownIt from "markdown-it";
import cjkFriendly from "markdown-it-cjk-friendly";

// 한글: «**24°C(체감)**이며» 처럼 닫는 ** 뒤에 한글이 바로 붙어도 굵게가 풀리게 (CommonMark 기본은 안 풀린다)
export const assistantMarkdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
}).use(cjkFriendly);

export function isSafeAssistantUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}
