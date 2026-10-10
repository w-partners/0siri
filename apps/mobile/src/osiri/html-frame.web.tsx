// 웹: 격리된 iframe(srcDoc). sandbox 에 allow-same-origin 을 주지 않아 페이지가 우리 저장소·쿠키·토큰에 닿지 못한다.
import { createElement } from "react";

export function HtmlFrame({ html }: { html: string }) {
  return createElement("iframe", {
    srcDoc: html,
    sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    title: "artifact",
    style: { flex: 1, width: "100%", height: "100%", border: 0, background: "#fff" },
  });
}
