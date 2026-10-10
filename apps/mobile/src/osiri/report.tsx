// «오류 보고·제안» 창 — 설정 메뉴와 화면의 오류 문구에서 연다. 보내면 서버가 page-picker 관리자로 넘긴다.
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  REPORT_KIND_LABELS,
  REPORT_KINDS,
  type ReportKind,
} from "../../../../packages/domain/src/osiri";
import { Button, colors, ErrorNotice, Field, Sheet, s, useAction } from "../ui";
import { useWorkspace } from "../workspace";
import { collectDiag, onOpenReport } from "./diag";

const text = {
  title: "오류 보고 · 제안",
  subject: "제목",
  subjectHint: { bug: "예: 대화를 보내면 멈춰요", idea: "예: 피드를 주제별로 모아 보고 싶어요" },
  detail: "자세히",
  detailHint: { bug: "무엇을 하다가 어떻게 됐는지", idea: "무엇이 있으면 좋겠는지" },
  includes:
    "기기 정보 · 앱 버전 · 최근 활동과 로그가 함께 갑니다. 비밀번호와 대화 내용은 보내지 않아요.",
  preview: "보낼 내용 보기",
  hide: "접기",
  send: "보내기",
  sent: (id: number) => `보냈어요 (접수 #${id}). 고맙습니다!`,
  close: "닫기",
  need: "제목을 적어 주세요",
};

/** App 에 하나 — openReport() 가 열 때까지 아무것도 그리지 않는다 */
export function ReportHost() {
  const [open, setOpen] = useState<{ kind: ReportKind; title: string; error: string } | null>(null);
  useEffect(() => {
    onOpenReport((o) =>
      setOpen({ kind: o.kind ?? "bug", title: o.title ?? "", error: o.error ?? "" }),
    );
    return () => onOpenReport(null);
  }, []);
  return open ? <ReportSheet {...open} onClose={() => setOpen(null)} /> : null;
}

function ReportSheet(props: {
  kind: ReportKind;
  title: string;
  error: string;
  onClose: () => void;
}) {
  const { api } = useWorkspace();
  const [kind, setKind] = useState(props.kind);
  const [title, setTitle] = useState(props.title);
  const [detail, setDetail] = useState(props.error ? `화면에 뜬 오류: ${props.error}\n\n` : "");
  const [preview, setPreview] = useState(false);
  const [sentId, setSentId] = useState<number | null>(null);
  const action = useAction();
  const client = () => collectDiag(props.error ? { shownError: props.error } : {});
  const send = () =>
    action.run(async () => {
      if (!title.trim()) throw new Error(text.need);
      const r = await api.request<{ id: number }>("/api/error-report", {
        kind,
        title: title.trim(),
        description: detail.trim(),
        client: client(),
      });
      setSentId(r.id);
    });
  return (
    <Sheet title={text.title} onClose={props.onClose}>
      {sentId !== null ? (
        <View style={{ gap: 12 }}>
          <Text style={s.text}>{text.sent(sentId)}</Text>
          <Button onPress={props.onClose}>{text.close}</Button>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <View style={[s.row, { gap: 8 }]}>
            {REPORT_KINDS.map((k) => (
              <Pressable
                key={k}
                accessibilityRole="radio"
                accessibilityState={{ selected: kind === k }}
                onPress={() => setKind(k)}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: kind === k ? colors.accent : colors.line,
                  backgroundColor: kind === k ? colors.accentSoft : "transparent",
                }}
              >
                <Text style={[s.text, { fontWeight: kind === k ? "700" : "400" }]}>
                  {REPORT_KIND_LABELS[k]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Field
            label={text.subject}
            placeholder={text.subjectHint[kind]}
            value={title}
            onChangeText={setTitle}
            maxLength={200}
          />
          <Field
            label={text.detail}
            placeholder={text.detailHint[kind]}
            value={detail}
            onChangeText={setDetail}
            multiline
            maxLength={4000}
            style={{ minHeight: 110, textAlignVertical: "top" }}
          />
          <Text style={s.small}>{text.includes}</Text>
          <Pressable accessibilityRole="button" onPress={() => setPreview(!preview)}>
            <Text style={[s.small, { color: colors.accent }]}>
              {preview ? text.hide : text.preview}
            </Text>
          </Pressable>
          {preview && (
            <Text style={[s.small, { fontFamily: "monospace" }]} selectable>
              {JSON.stringify(client(), null, 1).slice(0, 6000)}
            </Text>
          )}
          <ErrorNotice error={action.error} />
          <Button primary busy={action.busy} onPress={() => void send()}>
            {text.send}
          </Button>
        </View>
      )}
    </Sheet>
  );
}
