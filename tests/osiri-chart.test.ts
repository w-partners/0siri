import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_POINTS_MAX, parseChart } from "../packages/domain/src/osiri.ts";

test("대화 안 차트 — 형식이 맞으면 그리고, 틀리면 사유를 돌려준다", () => {
  assert.deepEqual(
    parseChart(
      '{"title":" 모델 지능 ","subtitle":"","unit":"점","source":"Artificial Analysis","data":[{"label":"A","value":57.2},{"label":"B","value":-3}],"extra":1}',
    ),
    {
      title: "모델 지능",
      subtitle: undefined,
      unit: "점",
      source: "Artificial Analysis",
      data: [
        { label: "A", value: 57.2 },
        { label: "B", value: -3 },
      ],
    },
  );
  assert.match(parseChart("{title:") as string, /JSON/);
  assert.equal(parseChart('{"data":[{"label":"A","value":1}]}'), "title 이 없습니다");
  assert.equal(parseChart('{"title":"t","data":[]}'), "data 가 없습니다");
  assert.match(parseChart('{"title":"t","data":[{"label":"A","value":"12"}]}') as string, /숫자/);
  const many = Array.from({ length: CHART_POINTS_MAX + 1 }, (_, i) => ({
    label: `${i}`,
    value: i,
  }));
  assert.match(parseChart(JSON.stringify({ title: "t", data: many })) as string, /넘습니다/);
});
