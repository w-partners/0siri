import assert from "node:assert/strict";
import test from "node:test";
import { relativeDate } from "../src/relative-date.ts";

const now = Date.parse("2026-09-30T12:00:00Z");

test("recent past timestamps keep their buckets", () => {
  assert.equal(relativeDate("2026-09-30T11:59:30Z", now), "방금 전");
  assert.equal(relativeDate("2026-09-30T11:30:00Z", now), "30분 전");
  assert.equal(relativeDate("2026-09-30T09:00:00Z", now), "3시간 전");
});

test("older timestamps read as yesterday, days ago, then a date", () => {
  assert.equal(relativeDate("2026-09-29T06:00:00Z", now), "어제");
  assert.equal(relativeDate("2026-09-27T12:00:00Z", now), "3일 전");
  const expected = new Date(Date.parse("2026-09-01T12:00:00Z")).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
  assert.equal(relativeDate("2026-09-01T12:00:00Z", now), expected);
});

test("future timestamps beyond clock skew show a date instead of just now", () => {
  assert.equal(relativeDate("2026-09-30T12:00:10Z", now), "방금 전");
  const expected = new Date(Date.parse("2026-10-05T12:00:00Z")).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
  assert.equal(relativeDate("2026-10-05T12:00:00Z", now), expected);
});

test("an unparseable timestamp is returned unchanged", () => {
  assert.equal(relativeDate("not-a-date", now), "not-a-date");
});
