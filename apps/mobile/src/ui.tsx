import { ArrowUpRight, Check, ChevronRight, type LucideIcon, X } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Appearance,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "./strings";

// 색 토큰의 유일한 출처 — «0Siri 종합 기획» §03 공통 디자인 규칙의 팔레트(:root / prefers-color-scheme: dark)를 그대로 옮겼다.
// ponytail: 다크 모드는 앱을 켤 때의 시스템 설정을 따른다(StyleSheet 가 모듈 로드 시 굳는다).
// 켜진 채로 바뀌면 웹은 App 이 새로고침하고, 네이티브는 다음 실행부터 — 실시간 전환이 필요해지면 테마 컨텍스트로 올린다.
const light = {
  bg: "#F3F5F1",
  surface: "#FFFFFF",
  sunk: "#EDF1EC",
  ink: "#17211B",
  muted: "#5F7063",
  line: "#D8E0D6",
  accent: "#0C6B57",
  accentSoft: "#E1EFE9",
  onAccent: "#FFFFFF",
  brass: "#8F6E25",
  brassSoft: "#F6EDD8",
  ok: "#1C7448",
  okBg: "#E2F2E9",
  warn: "#8A5F00",
  warnBg: "#F8EDD2",
  miss: "#AE332C",
  missBg: "#F9E4E2",
};
const dark: typeof light = {
  bg: "#0E120E",
  surface: "#171D17",
  sunk: "#10150F",
  ink: "#E8EEE7",
  muted: "#93A495",
  line: "#2B352B",
  accent: "#5CC4A4",
  accentSoft: "#16302A",
  onAccent: "#0E120E",
  brass: "#D8B45C",
  brassSoft: "#33290F",
  ok: "#62C792",
  okBg: "#15301F",
  warn: "#E2B450",
  warnBg: "#33290F",
  miss: "#F08A82",
  missBg: "#3A1917",
};
export const isDark = Appearance.getColorScheme() === "dark";
const token = isDark ? dark : light;
export const colors = {
  ...token,
  // 아래는 openmuse 원본 화면이 쓰는 옛 이름 — 값은 전부 위 토큰이다(새 색을 만들지 않는다).
  canvas: token.bg,
  card: token.surface,
  text: token.ink,
  blue: token.accentSoft,
  blueDark: token.accent,
  sky: token.accentSoft,
  green: token.okBg,
  lavender: token.sunk,
  orange: token.warnBg,
  danger: token.miss,
};
// 폰트 3종(본문 Pretendard · 제목 Noto Serif KR · 숫자 IBM Plex Mono). 웹은 +html 이 웹폰트를 싣고,
// 네이티브는 기기에 없으면 시스템 글꼴로 떨어진다(글꼴 파일을 APK 에 싣지 않았다 — 실으면 expo-font 로 한 곳에서).
export const fonts = Platform.select({
  web: {
    body: '"Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
    display: '"Noto Serif KR", serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
  },
  default: { body: undefined, display: "serif", mono: "monospace" },
}) as { body: string | undefined; display: string; mono: string };
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  text: { color: colors.text, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 11, lineHeight: 17 },
  label: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: {
    color: colors.text,
    fontSize: 23,
    fontWeight: "600",
    letterSpacing: -0.7,
    fontFamily: fonts.display,
  },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 18 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 19,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
    backgroundColor: colors.card,
    minHeight: 45,
  },
  field: { gap: 7, marginBottom: 16 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 17,
    minHeight: 42,
    paddingVertical: 10,
    borderRadius: 24,
  },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.line },
  buttonText: { fontSize: 14, fontWeight: "600" },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: "flex-start",
    backgroundColor: colors.canvas,
  },
  chipText: { fontSize: 10, fontWeight: "600", color: colors.muted, fontFamily: fonts.mono },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.sky,
  },
  error: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: colors.missBg,
    marginVertical: 10,
    gap: 4,
  },
  modalShade: {
    flex: 1,
    backgroundColor: "rgba(35,48,44,0.25)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  sheet: {
    backgroundColor: colors.canvas,
    borderRadius: 26,
    width: "100%",
    maxWidth: 790,
    maxHeight: "94%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
  },
});
export function Button({
  children,
  onPress,
  icon: Icon,
  primary,
  disabled,
  busy,
  small,
  danger,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  icon?: LucideIcon;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const color = danger ? colors.danger : primary ? colors.onAccent : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary ? s.primary : s.secondary,
        small && { minHeight: 38, paddingVertical: 7, paddingHorizontal: 13 },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : Icon ? (
        <Icon size={15} color={color} />
      ) : null}
      <Text style={[s.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 22,
          backgroundColor: pressed ? colors.line : colors.card,
        },
      ]}
    >
      <Icon size={20} strokeWidth={1.8} color={colors.text} />
    </Pressable>
  );
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}
/** 승인 대기 배지 — 기획: «빨간 숫자 배지 하나로 통일». 방 목록·탭·캐릭터가 전부 이것만 쓴다. */
export function Badge({ count, style }: { count: number; style?: ViewStyle }) {
  if (count <= 0) return null;
  return (
    <View
      style={[
        {
          minWidth: 18,
          height: 18,
          paddingHorizontal: 5,
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.miss,
        },
        style,
      ]}
    >
      <Text style={{ color: "#FFF", fontSize: 11, fontWeight: "700", fontFamily: fonts.mono }}>
        {count}
      </Text>
    </View>
  );
}
/** 로딩 자리 — 기획: «로딩은 스켈레톤». */
export function Skeleton({ rows = 3, height = 64 }: { rows?: number; height?: number }) {
  return (
    <View accessibilityLabel="불러오는 중" style={{ gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 자리 표시라 순서가 곧 정체다
        <View key={i} style={{ height, borderRadius: 10, backgroundColor: colors.sunk }} />
      ))}
    </View>
  );
}
export function Chip({ children, tint }: { children: ReactNode; tint?: string }) {
  return (
    <View style={[s.chip, tint ? { backgroundColor: tint } : null]}>
      <Text style={s.chipText}>{children}</Text>
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={s.field}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...props}
        style={[
          s.input,
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", padding: 40, gap: 13 }}>
      <View style={[s.iconBox, { width: 55, height: 55, borderRadius: 18 }]}>
        <Icon size={24} color={colors.blueDark} />
      </View>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>{detail}</Text>
      {children}
    </View>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={[s.text, { color: colors.danger }]}>{error}</Text>
    </View>
  ) : null;
}
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 600;
  return (
    <Modal transparent animationType={compact ? "slide" : "fade"} visible onRequestClose={onClose}>
      <View style={[s.modalShade, compact && { padding: 0, justifyContent: "flex-end" }]}>
        <View
          accessibilityViewIsModal
          style={[
            s.sheet,
            wide && { maxWidth: 1050 },
            compact && {
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              paddingBottom: Math.max(insets.bottom, 12),
              maxHeight: "94%",
            },
          ]}
        >
          {compact && (
            <View
              style={{
                alignSelf: "center",
                width: 34,
                height: 4,
                borderRadius: 3,
                backgroundColor: colors.line,
                marginTop: 10,
              }}
            />
          )}
          <View
            style={[
              s.between,
              { padding: compact ? 20 : 24, borderBottomWidth: 1, borderBottomColor: colors.line },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.title}>{title}</Text>
              {!!subtitle && <Text style={s.muted}>{subtitle}</Text>}
            </View>
            <IconButton icon={X} label={t.common.close} onPress={onClose} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: compact ? 20 : 24 }}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function CheckRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[s.row, { gap: 10, paddingVertical: 9 }]}
    >
      <View
        style={{
          width: 19,
          height: 19,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? colors.text : colors.line,
          backgroundColor: checked ? colors.accent : colors.card,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={13} color={colors.onAccent} />}
      </View>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
export function SectionHeading({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={[s.between, { marginBottom: 19 }]}>
      <Text style={s.heading}>{title}</Text>
      {action && onPress && (
        <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { gap: 5 }]}>
          <Text style={[s.small, { color: colors.text }]}>{action}</Text>
          <ArrowUpRight size={13} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function LinkRow({
  title,
  detail,
  onPress,
  icon: Icon,
  tint,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon: LucideIcon;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        { paddingVertical: 13, gap: 14, borderRadius: 10 },
        pressed && { backgroundColor: colors.canvas },
      ]}
    >
      <View style={[s.iconBox, { backgroundColor: tint || colors.sky }]}>
        <Icon size={19} color={colors.text} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontWeight: "500" }]}>{title}</Text>
        {!!detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
  );
}
/** 0Siri's capybara mascot, shared by every assistant surface. */
export function Mascot({
  size = 42,
  variant = "sky",
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
}) {
  const palette = {
    sky: "#ECF5FA",
    sand: "#FAF0DF",
    lilac: "#F1ECF9",
  }[variant];
  return (
    <View accessibilityLabel={t.ui.mascot.label} style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          top: size * 0.15,
          left: size * 0.12,
          width: size * 0.76,
          height: size * 0.76,
          borderRadius: size,
          backgroundColor: palette,
        }}
      />
      <Image
        source={require("../assets/capybara.png")}
        resizeMode="contain"
        style={{ width: size, height: size }}
        accessible={false}
      />
    </View>
  );
}
export function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("ko-KR", options || { month: "short", day: "numeric" });
}
export function timeLabel(value: string, timeZone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", timeZone });
}
export { relativeDate } from "./relative-date";

export function resultSummary(value: string) {
  return /^Saved to (?:sample|local) sent mail(?: · .+)?$/.test(value)
    ? t.ui.result.replySaved
    : value;
}
