// 음성 답에 넘길 글 자르기 — react-native 없이 테스트하려고 speak.tsx 에서 뗐다.

/** 지금까지 받은 글에서 끝난 문장의 끝 위치. 받는 중에는 문장 뒤 공백·줄바꿈이 와야 끝으로 본다(«3.5» 를 자르지 않게) */
export function sentenceEnd(text: string, from: number, finished: boolean) {
  if (finished) return text.length;
  let end = from;
  for (const m of text.slice(from).matchAll(/[.!?…。]+\s|\n/g)) end = from + m.index + m[0].length;
  return end;
}

/** 읽기 좋게 — 코드 블록·링크 주소·마크다운 기호는 읽지 않는다 */
export function speakable(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[사진 [0-9a-f-]{36}\]/gi, " ")
    .replace(/[*#_`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
