// 오류 보고·제안에 실을 기록 — 화면 이동·API 호출·로그·잡히지 않은 오류를 메모리에 최근 것만 쥐고 있다(마스터 2026-10-10).
// UI 를 import 하지 않는다: ui.tsx(ErrorNotice)·api.ts 가 이 파일을 부르므로, 반대로 부르면 순환한다.
import { Appearance, Dimensions, PixelRatio, Platform } from "react-native";
import type { ReportKind } from "../../../../packages/domain/src/osiri";
import appJson from "../../app.json";

type Entry = { at: string; [k: string]: unknown };
const started = Date.now();
const logs: Entry[] = []; // ponytail: 최근 150·80개만 — 기기에 남기지 않는다(재시작하면 비어도 된다)
const activity: Entry[] = [];
const push = (list: Entry[], max: number, e: object) => {
  list.push({ at: new Date().toISOString(), ...e });
  if (list.length > max) list.shift();
};
const short = (x: unknown) =>
  (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : safeJson(x)).slice(
    0,
    600,
  );
const safeJson = (x: unknown) => {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
};

/** 사용자가 한 일 — 화면 이동·요청·누름. 보고서의 «오류 발생 전 활동» */
export function track(type: string, detail: Record<string, unknown> = {}) {
  push(activity, 80, { type, ...detail });
}

let installed = false;
/** 앱 시작 때 한 번 — console 과 전역 오류를 기록에 잇는다(원래 동작은 그대로) */
export function installDiag() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(logs, 150, { level, msg: args.map(short).join(" ") });
      orig(...args);
    };
  }
  const crash = (kind: string, e: unknown) => {
    push(logs, 150, {
      level: "error",
      msg: `${kind}: ${short(e)}`,
      stack: (e as Error)?.stack?.slice(0, 1500),
    });
    track("crash", { kind, msg: short(e) });
  };
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.addEventListener("error", (e) => crash("window.error", e.error ?? e.message));
    window.addEventListener("unhandledrejection", (e) => crash("unhandledrejection", e.reason));
  } else {
    const g = globalThis as unknown as {
      ErrorUtils?: {
        getGlobalHandler(): (e: unknown, fatal?: boolean) => void;
        setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void;
      };
    };
    const prev = g.ErrorUtils?.getGlobalHandler();
    g.ErrorUtils?.setGlobalHandler((e, fatal) => {
      crash(fatal ? "fatal" : "js-error", e);
      prev?.(e, fatal);
    });
  }
}

let screen = "?";
export function setScreen(name: string) {
  if (name === screen) return;
  screen = name;
  track("screen", { name });
}

/** 보고서에 실을 앱 쪽 맥락 전부 — 서버가 사용자·서버 정보를 더 붙인다 */
export function collectDiag(extra: Record<string, unknown> = {}) {
  const c = (Platform.constants ?? {}) as Record<string, unknown>;
  const win = Dimensions.get("window");
  const web = Platform.OS === "web" && typeof navigator !== "undefined";
  return {
    device: {
      os: Platform.OS,
      osVersion: String(Platform.Version ?? ""),
      brand: c.Brand ?? c.Manufacturer ?? "",
      model: c.Model ?? "",
      release: c.Release ?? "",
      userAgent: web ? navigator.userAgent : "",
      screen: `${Math.round(win.width)}x${Math.round(win.height)} @${PixelRatio.get()}`,
      fontScale: PixelRatio.getFontScale(),
      colorScheme: Appearance.getColorScheme() ?? "",
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      online: web ? navigator.onLine : undefined,
      appVersion: appJson.expo.version,
    },
    context: {
      screen,
      url: web && typeof location !== "undefined" ? location.href : "",
      uptimeSec: Math.round((Date.now() - started) / 1000),
      ...extra,
    },
    activity: [...activity],
    logs: [...logs],
  };
}

// 어디서든 «오류 보고» 창을 연다 — 창(ReportHost)은 App 에 하나만 있다
type Open = { kind?: ReportKind; title?: string; error?: string };
let listener: ((o: Open) => void) | null = null;
export const onOpenReport = (fn: typeof listener) => {
  listener = fn;
};
export function openReport(o: Open = {}) {
  track("open-report", { kind: o.kind ?? "bug" });
  listener?.(o);
}
