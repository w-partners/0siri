// 시험용 문자 인증 — WRONG_OTP_CODE 만 거절하고 나머지는 통과시킨다(초대·가입 시험은 문자 인증이 주제가 아니다).
// 실제 서비스(OTP_BASE)는 부르지 않는다. 문자 인증 자체는 tests/osiri-otp.test.ts 가 본다.
import { AppError } from "../../apps/server/src/errors.ts";
import type { Otp } from "../../apps/server/src/osiri/otp.ts";

export const WRONG_OTP_CODE = "999999";
export const sentOtps: { phone: string; purpose: string }[] = [];

export const fakeOtp: Otp = {
  async request(phone, purpose) {
    sentOtps.push({ phone, purpose });
    return { expiresIn: 180, resendAfter: 60 };
  },
  async verify(_phone, code) {
    if (code === WRONG_OTP_CODE) throw new AppError("인증번호가 맞지 않습니다", 400);
  },
};
