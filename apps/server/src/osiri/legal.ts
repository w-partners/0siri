// 로그인 없이 여는 공개 문서 — 개인정보처리방침(/privacy)·계정 삭제 안내(/account-delete).
// Play 등록이 «공개 URL» 을 요구한다(SEOUL-20261012-YS1 §2-7·8). 웹 앱(SPA) 보다 먼저 걸어 빈 껍데기가 나가지 않게 한다.
// 내용은 코드 실측 기준(2026-10-12): 위치 location.ts · 탈퇴 accounts.requestDeletion · 보존 RETENTION_DAYS · 푸시 push.ts · 브라우저 browser-containers.ts
import { RETENTION_DAYS } from "@openmuse/domain";
import { Hono } from "hono";

const page = (title: string, body: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 0Siri</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1f1c;--muted:#5d625a;--line:#e3e4de;--accent:#1f6f54}
@media (prefers-color-scheme:dark){:root{--bg:#141614;--fg:#e9ebe6;--muted:#a3a89f;--line:#2b2e2a;--accent:#7cc7a6}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,"Noto Sans KR",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
p,li{color:var(--fg)}small,.muted{color:var(--muted)}a{color:var(--accent)}
table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
</style></head><body><main>${body}</main></body></html>`;

const UPDATED = "2026년 10월 12일";

export const PRIVACY_HTML = page(
  "개인정보처리방침",
  `<h1>개인정보처리방침</h1><p class="muted">0Siri(영시리) · 시행일 ${UPDATED}</p>
<p>더블유파트너스(이하 «회사»)는 0Siri 앱과 웹(openagentx.org)을 운영하며, 이용자의 개인정보를 아래와 같이 처리합니다.</p>

<h2>1. 처리하는 개인정보와 목적</h2>
<table>
<tr><th>항목</th><th>목적</th><th>언제</th></tr>
<tr><td>휴대전화 번호, 비밀번호(암호화 저장), 표시 이름·소개</td><td>가입·로그인, 초대, 본인 확인</td><td>가입할 때</td></tr>
<tr><td>대화 내용, 기억(대화에서 정리한 기록과 검색용 수치 벡터), 올린 파일, 목표·승인 기록</td><td>에이전트가 답하고 일을 이어 가기 위해</td><td>앱을 쓸 때</td></tr>
<tr><td>위치(마지막 위치 한 곳)</td><td>날씨·주변 장소·길 안내 질문에 답하기 위해</td><td>위치 권한을 허용하고 켠 경우만. 설정에서 끌 수 있습니다</td></tr>
<tr><td>음성</td><td>말로 입력하기. 기기의 음성 인식 서비스가 글자로 바꾸고, 회사 서버에는 바뀐 글자만 옵니다</td><td>마이크 버튼을 누른 동안만</td></tr>
<tr><td>푸시 알림 토큰</td><td>새 메시지·승인 요청 알림</td><td>알림을 허용한 경우</td></tr>
<tr><td>대화 안 브라우저의 방문 기록·로그인 상태(쿠키)</td><td>이용자가 요청한 웹 작업을 대신 하기 위해</td><td>브라우저 기능을 쓸 때. 이용자별로 분리된 공간에만 저장합니다</td></tr>
<tr><td>사용량(호출 수·토큰 수), 접속 기록, 오류 기록</td><td>요금 한도 관리, 장애 대응, 부정 이용 방지</td><td>앱을 쓸 때</td></tr>
</table>

<h2>2. 보관 기간</h2>
<p>계정이 있는 동안 보관합니다. 계정 삭제를 요청하면 ${RETENTION_DAYS}일 뒤 계정과 위 정보를 모두 지웁니다. 단, 법령이 보관을 요구하는 기록은 그 기간 동안 따로 보관합니다.</p>

<h2>3. 외부에 맡기거나 보내는 곳</h2>
<table>
<tr><th>받는 곳</th><th>보내는 것</th><th>이유</th></tr>
<tr><td>AI 모델 제공자(OpenAI 등)</td><td>답을 만들 때 필요한 대화 내용</td><td>답변 생성. 이용자가 자기 모델 계정을 연결하면 그 계정으로 보냅니다</td></tr>
<tr><td>Google Cloud(서울)</td><td>서비스 데이터 전체</td><td>서버 운영(보관 위치)</td></tr>
<tr><td>Cloudflare</td><td>접속 시 오가는 데이터</td><td>도메인 연결·보안</td></tr>
<tr><td>Google Firebase Cloud Messaging</td><td>푸시 토큰과 알림 문구</td><td>푸시 알림 발송</td></tr>
</table>
<p>회사는 개인정보를 판매하지 않으며, 위 목적 밖으로 제3자에게 제공하지 않습니다. 법령에 따른 요청이 있는 경우는 예외입니다.</p>

<h2>4. 이용자의 권리</h2>
<p>앱의 설정에서 내 정보를 보고 고칠 수 있고, 위치 사용을 끌 수 있으며, 계정과 데이터 삭제를 요청할 수 있습니다. 삭제 방법은 <a href="/account-delete">계정 삭제 안내</a>에 있습니다.</p>

<h2>5. 안전 조치</h2>
<p>전송 구간 암호화(HTTPS), 비밀번호 암호화 저장, 이용자별 데이터 분리, 관리자 접근 기록을 운영합니다.</p>

<h2>6. 아동</h2>
<p>만 14세 미만은 가입할 수 없습니다.</p>

<h2>7. 문의</h2>
<p>개인정보 보호책임자: 더블유파트너스. 앱의 설정에서 문의하거나 <a href="/account-delete">계정 삭제 안내</a>의 방법으로 연락할 수 있습니다.</p>

<h2>8. 바뀔 때</h2>
<p>이 방침이 바뀌면 시행 7일 전에 앱과 이 페이지에 알립니다.</p>`,
);

export const ACCOUNT_DELETE_HTML = page(
  "계정 삭제 안내",
  `<h1>계정·데이터 삭제</h1><p class="muted">0Siri(영시리) · 더블유파트너스</p>
<h2>삭제 요청하는 법</h2>
<ol>
<li>앱 또는 웹(<a href="https://openagentx.org">openagentx.org</a>)에 로그인합니다. 앱을 지웠어도 웹에서 할 수 있습니다.</li>
<li><b>설정 › 데이터 삭제 › 삭제 요청</b>을 누릅니다.</li>
<li>요청한 날부터 ${RETENTION_DAYS}일 안에 아래가 모두 지워지고, 되돌릴 수 없습니다.</li>
</ol>
<h2>지워지는 것</h2>
<p>계정(전화번호·비밀번호·이름), 대화, 기억, 올린 파일, 목표·승인 기록, 위치, 푸시 토큰, 대화 안 브라우저의 저장 공간(로그인 상태 포함).</p>
<h2>남는 것</h2>
<p>삭제를 처리했다는 기록(언제, 어떤 계정 번호)만 남습니다. 법령이 보관을 요구하는 기록은 그 기간 동안 따로 보관 후 지웁니다.</p>
<h2>로그인할 수 없을 때</h2>
<p>로그인 화면의 «비밀번호 찾기»로 비밀번호를 다시 정한 뒤 위 순서대로 하십시오.</p>
<p class="muted"><a href="/privacy">개인정보처리방침</a></p>`,
);

export function legalRoutes() {
  const app = new Hono();
  app.get("/privacy", (c) => c.html(PRIVACY_HTML));
  app.get("/account-delete", (c) => c.html(ACCOUNT_DELETE_HTML));
  return app;
}
