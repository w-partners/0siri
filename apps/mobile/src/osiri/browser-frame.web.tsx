// 웹: 같은 출처의 콘솔을 iframe 으로. 콘솔 자체가 서명 주소로 자기 서버에만 묻는다.
import { createElement } from "react";

export function BrowserFrame({ url }: { url: string }) {
  return createElement("iframe", {
    src: url,
    title: "영시리 브라우저",
    style: { flex: 1, width: "100%", height: "100%", border: 0, background: "#fcfcfc" },
  });
}
