import { useCallback, useState } from "react";
import { Linking, ScrollView, Text, type TextStyle, View, type ViewStyle } from "react-native";
import Markdown, { type MarkdownStyles, type RenderRules } from "react-native-markdown-renderer";
import { CHART_FENCE, type ChartSpec, parseChart } from "../../../packages/domain/src/osiri";
import { assistantMarkdown, isSafeAssistantUrl } from "./assistant-markdown";
import { t } from "./strings";
import { colors, ErrorNotice } from "./ui";

const textStyle = { color: colors.text, fontSize: 16, lineHeight: 24 };
const style: Partial<MarkdownStyles> = {
  text: textStyle,
  paragraph: { marginTop: 0, marginBottom: 6 },
  list: { marginBottom: 6 },
  // 목록 번호·점은 라이브러리 기본(검정)이라 어두운 테마에서 안 보였다
  listOrderedItemIcon: { color: colors.text },
  listUnorderedItemIcon: { color: colors.text },
  headingContainer: { marginTop: 8, marginBottom: 4 },
  heading1: { fontSize: 21, lineHeight: 27 },
  heading2: { fontSize: 19, lineHeight: 25 },
  heading3: { fontSize: 17, lineHeight: 23 },
  link: { color: colors.blueDark, textDecorationLine: "underline" },
  codeInline: { backgroundColor: colors.sunk, color: colors.text },
  codeBlock: { backgroundColor: colors.sunk, color: colors.text },
  // 표: 머리줄은 옅은 바탕, 줄 사이에만 가는 줄 (ChatGPT 표처럼). 넓으면 가로로 민다
  table: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
  tableHeader: { backgroundColor: colors.accentSoft },
  tableHeaderCell: { minWidth: 96, padding: 8, borderWidth: 0 },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.line },
  tableRowCell: { minWidth: 96, padding: 8, borderWidth: 0 },
};

const number = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

/** ```chart 블록 — 제목·부제·가로 막대(값 라벨)·출처 칩 */
function ChartCard({ chart }: { chart: ChartSpec }) {
  const max = Math.max(...chart.data.map((p) => Math.abs(p.value)), 0) || 1;
  return (
    <View
      accessibilityLabel={chart.title}
      style={{
        gap: 10,
        padding: 14,
        marginVertical: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.card,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text selectable style={{ color: colors.text, fontSize: 16, fontWeight: "700" }}>
          {chart.title}
        </Text>
        {!!chart.subtitle && (
          <Text selectable style={{ color: colors.muted, fontSize: 13 }}>
            {chart.subtitle}
          </Text>
        )}
      </View>
      {chart.data.map((point, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 차트 항목은 순서가 고정이고 이름이 겹칠 수 있다
        <View key={`${i}-${point.label}`} style={{ gap: 3 }}>
          <Text selectable style={{ color: colors.text, fontSize: 13 }} numberOfLines={2}>
            {point.label}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ flex: 1, height: 14, borderRadius: 7, backgroundColor: colors.sunk }}>
              <View
                style={{
                  width: `${(Math.abs(point.value) / max) * 100}%`,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: point.value < 0 ? colors.muted : colors.accent,
                }}
              />
            </View>
            <Text
              selectable
              style={{
                color: colors.text,
                fontSize: 13,
                fontWeight: "600",
                minWidth: 48,
                textAlign: "right",
              }}
            >
              {number(point.value)}
              {chart.unit ?? ""}
            </Text>
          </View>
        </View>
      ))}
      {!!chart.source && (
        <View
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 10,
            paddingVertical: 3,
            borderRadius: 999,
            backgroundColor: colors.sunk,
          }}
        >
          <Text selectable style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
            {chart.source}
          </Text>
        </View>
      )}
    </View>
  );
}
const renderCodeBlock: RenderRules["fence"] = (node, _children, _parent, styles) => (
  <Text key={node.key} selectable style={styles.codeBlock as TextStyle}>
    {node.content.replace(/\n$/, "")}
  </Text>
);
const renderFence: RenderRules["fence"] = (node, children, parent, styles) => {
  if ((node as { sourceInfo?: string }).sourceInfo?.trim() !== CHART_FENCE)
    return renderCodeBlock(node, children, parent, styles);
  const chart = parseChart(node.content);
  if (typeof chart !== "string") return <ChartCard key={node.key} chart={chart} />;
  // 형식이 틀린 차트는 사유와 원문을 그대로 보인다
  return (
    <View key={node.key} style={{ gap: 4 }}>
      <ErrorNotice error={t.ui.markdown.chartInvalid(chart)} />
      {renderCodeBlock(node, children, parent, styles)}
    </View>
  );
};
const rules: RenderRules = {
  textgroup: (node, children) => (
    <Text key={node.key} selectable style={textStyle}>
      {children}
    </Text>
  ),
  image: (node) => (
    <Text key={node.key} selectable style={{ color: colors.muted }}>
      {node.attributes.alt ? t.ui.markdown.imageAlt(node.attributes.alt) : t.ui.markdown.image}
    </Text>
  ),
  code_block: renderCodeBlock,
  fence: renderFence,
  table: (node, children, _parent, styles) => (
    <ScrollView key={node.key} horizontal style={{ marginVertical: 6 }}>
      <View style={styles.table as ViewStyle}>{children}</View>
    </ScrollView>
  ),
};

export function AssistantResponse({ content }: { content: string }) {
  const [linkError, setLinkError] = useState("");
  const onLinkPress = useCallback((url: string) => {
    if (!isSafeAssistantUrl(url)) return false;
    setLinkError("");
    void Linking.openURL(url).catch((error) =>
      setLinkError(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }, []);
  return (
    <>
      <Markdown
        markdownit={assistantMarkdown}
        style={style}
        rules={rules}
        onLinkPress={onLinkPress}
      >
        {content}
      </Markdown>
      <ErrorNotice error={linkError} />
    </>
  );
}
