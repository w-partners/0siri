// 앱 업데이트 받기 진행 한 줄 (마스터 2026-10-12 «다운로드 시 상세정보. 프로그레스바, 속도, 모두 보이게»)
const MB = 1024 * 1024;
const mb = (bytes: number) => (bytes / MB).toFixed(1);
/** 받기 진행 한 줄 — «65.3 / 149.3MB · 4.2MB/s · 약 20초 남음». 속도를 아직 모르면(0) 속도·남은 시간을 뺀다 */
export function downloadDetail(written: number, total: number, bytesPerSec: number) {
  const parts = [`${mb(written)} / ${mb(total)}MB`];
  if (bytesPerSec > 0) {
    const left = Math.max(0, Math.ceil((total - written) / bytesPerSec));
    parts.push(
      `${mb(bytesPerSec)}MB/s`,
      left >= 60 ? `약 ${Math.floor(left / 60)}분 ${left % 60}초 남음` : `약 ${left}초 남음`,
    );
  }
  return parts.join(" · ");
}
