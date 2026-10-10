// 문자 인증 — 공용 OTP 서비스(zalman, tailnet)를 부른다 (마스터 2026-10-10 «문자 인증시스템은 이 링크를 확인해서 구축» — 주소는 OTP_BASE).
// 정본 설명서: <OTP_BASE>/guide. 발송·유효시간·재발송 간격·시도 제한·1회용은 그 서비스가 책임진다 — 여기서 다시 만들지 않는다.
// 여기서 하는 일: 키를 붙여 부르고, 사유 코드를 사람이 읽을 문구로 바꾼다.
// 설정이 없으면 조용히 건너뛰지 않는다 — 인증이 필요한 요청이 503 으로 실패한다.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { OtpPurpose } from "../../../../packages/domain/src/osiri.ts";
import { AppError } from "../errors.ts";

export interface Otp {
  /** 인증번호 문자를 보낸다. 번호는 normalizePhone 을 거친 01012345678 형태 */
  request(phone: string, purpose: OtpPurpose): Promise<{ expiresIn: number; resendAfter: number }>;
  /** 맞으면 그대로 끝, 틀리면 AppError. 맞힌 번호는 서비스가 그 자리에서 소비한다 */
  verify(phone: string, code: string, purpose: OtpPurpose): Promise<void>;
}

// 서비스 사유 코드(<OTP_BASE>/guide §4) → 사용자 문구. 모르는 코드는 코드를 그대로 보인다
const REASONS: Record<string, string> = {
  bad_phone: "전화번호 형식이 올바르지 않습니다",
  resend_too_soon: "인증번호를 방금 보냈어요. 잠시 뒤 다시 요청하세요",
  hourly_limit: "이 번호로 너무 자주 요청했어요. 한 시간 뒤 다시 요청하세요",
  send_failed: "문자를 보내지 못했어요. 잠시 뒤 다시 요청하세요",
  no_active_code: "인증번호를 먼저 받아 주세요",
  wrong_code: "인증번호가 맞지 않습니다",
  too_many_attempts: "인증번호를 너무 많이 틀렸어요. 새로 받아 주세요",
  expired: "인증번호 시간이 지났어요. 새로 받아 주세요",
};

function message(body: Record<string, unknown>) {
  const reason = String(body.reason ?? "unknown");
  const base = REASONS[reason] ?? `문자 인증 실패 (${reason})`;
  if (reason === "wrong_code" && typeof body.attempts_left === "number")
    return `${base} (남은 기회 ${body.attempts_left}번)`;
  if (reason === "resend_too_soon" && typeof body.retry_after === "number")
    return `${base} (${body.retry_after}초 뒤)`;
  return base;
}

export function otpGateway(base?: string, keyFile?: string): Otp {
  const missing = [!base && "OTP_BASE", !keyFile && "OTP_KEY_FILE"].filter(Boolean).join("·");
  if (missing)
    console.warn(`[osiri] 문자 인증 미설정(${missing}) — 가입·비밀번호 찾기가 503 으로 실패합니다`);
  const call = async (path: string, body: object) => {
    if (missing) throw new AppError(`문자 인증이 설정되지 않았습니다 (${missing})`, 503);
    // 키는 부를 때마다 파일에서 읽는다 — 회전(rotate)해도 서버를 다시 띄울 필요가 없다
    const key = readFileSync((keyFile as string).replace(/^~/, homedir()), "utf8").trim();
    const r = await fetch(`${base}/v1/otp/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 401) {
      console.error(
        "[osiri] 문자 인증 서비스가 키를 거절했습니다(401) — OTP_KEY_FILE·등록 상태 확인",
      );
      throw new AppError("문자 인증 서비스에 연결할 수 없습니다", 503);
    }
    if (!r.ok || json.ok !== true) {
      if (json.reason === "send_failed") console.error("[osiri] 문자 발송 실패:", json.detail);
      throw new AppError(message(json), r.status >= 500 ? 502 : r.status === 429 ? 429 : 400);
    }
    return json;
  };
  return {
    async request(phone, purpose) {
      const json = await call("request", { phone, purpose });
      return { expiresIn: Number(json.expires_in), resendAfter: Number(json.resend_after) };
    },
    async verify(phone, code, purpose) {
      if (!/^\d{4,8}$/.test(code.trim())) throw new AppError("인증번호를 입력하세요", 400);
      await call("verify", { phone, code: code.trim(), purpose });
    },
  };
}
