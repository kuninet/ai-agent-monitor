import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickClaudeQuota } from '../src/collectors/claude.js';

const e = (mtimeMs, rate_limits) => ({ mtimeMs, data: rate_limits === undefined ? {} : { rate_limits } });
const w = (used_percentage, resets_at) => ({ used_percentage, resets_at });

describe('pickClaudeQuota', () => {
  const now = 1_700_000_000_000;
  const futureSec = 1_700_010_000;
  const pastSec = 1_699_990_000;

  test('同じ resets_at で使用率の異なる 2 つのエントリ: 更新時刻が古い方が使用率が大きければ、古い方の値が出る', () => {
    const entries = [
      e(1000, { five_hour: w(80, futureSec), seven_day: w(50, futureSec) }),
      e(2000, { five_hour: w(30, futureSec), seven_day: w(20, futureSec) }),
    ];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 80);
    assert.equal(q.weekly.pct, 50);
    assert.equal(q.updatedAt, 1000);
  });

  test('resets_at が新しい枠のエントリは、使用率が小さくても優先される', () => {
    const entries = [
      e(2000, { five_hour: w(90, futureSec), seven_day: w(80, futureSec) }),
      e(1000, { five_hour: w(10, futureSec + 100), seven_day: w(15, futureSec + 200) }),
    ];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 10);
    assert.equal(q.fiveHour.resetsAt, (futureSec + 100) * 1000);
    assert.equal(q.weekly.pct, 15);
    assert.equal(q.weekly.resetsAt, (futureSec + 200) * 1000);
  });

  test('最も新しいエントリが five_hour を持たず seven_day だけを持つ: fiveHour は他のエントリの値、weekly は最も新しいエントリの値が出る', () => {
    const entries = [e(1000, { five_hour: w(50, futureSec) }), e(2000, { seven_day: w(60, futureSec) })];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 50);
    assert.equal(q.weekly.pct, 60);
    assert.equal(q.updatedAt, 2000);
  });

  test('resets_at も使用率も同じ: mtimeMs が大きい方が選ばれる (updatedAt で確認)', () => {
    const entries = [
      e(1000, { five_hour: w(50, futureSec), seven_day: w(40, futureSec) }),
      e(3000, { five_hour: w(50, futureSec), seven_day: w(40, futureSec) }),
    ];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 50);
    assert.equal(q.weekly.pct, 40);
    assert.equal(q.updatedAt, 3000);
  });

  test('rate_limits を持つエントリが 1 つも無い (空配列、{} だけ): null', () => {
    assert.equal(pickClaudeQuota([], now), null);
    assert.equal(pickClaudeQuota([e(1000)], now), null);
    assert.equal(pickClaudeQuota([{ mtimeMs: 1000, data: {} }], now), null);
  });

  test('rate_limits が {} のエントリだけ: fiveHour と weekly が null で、updatedAt はその mtimeMs', () => {
    const entries = [e(1500, {})];
    const q = pickClaudeQuota(entries, now);
    assert.deepEqual(q, {
      plan: null,
      fiveHour: null,
      weekly: null,
      updatedAt: 1500,
    });
  });

  test('resets_at が now より前なら stale: true (limitOf の挙動がそのまま出ること)', () => {
    const entries = [e(1000, { five_hour: w(50, pastSec), seven_day: w(40, futureSec) })];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.stale, true);
    assert.equal(q.weekly.stale, false);
  });

  test('updatedAt は、5h と週次で別のエントリを選んだとき、大きい方の mtimeMs', () => {
    const entries = [
      e(1000, { five_hour: w(20, futureSec + 100), seven_day: w(10, futureSec) }),
      e(2500, { five_hour: w(50, futureSec), seven_day: w(30, futureSec + 200) }),
    ];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 20);
    assert.equal(q.weekly.pct, 30);
    assert.equal(q.updatedAt, 2500);
  });

  test('five_hour.resets_at がミリ秒で書かれたエントリと、正常なエントリがあるとき: 正常なエントリの値が選ばれる', () => {
    const normalSec = Math.floor(now / 1000) + 3600;
    const msResets = normalSec * 1000;
    const entries = [e(2000, { five_hour: w(90, msResets) }), e(1000, { five_hour: w(40, normalSec) })];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 40);
    assert.equal(q.fiveHour.resetsAt, normalSec * 1000);
  });

  test('five_hour.resets_at は境界のすぐ内側 (nowSec + 5 * 3600 + 3600 - 60) が候補になり、すぐ外側 (+ 60) は候補にならない', () => {
    const nowSec = Math.floor(now / 1000);
    const inRangeSec = nowSec + 5 * 3600 + 3600 - 60;
    const outOfRangeSec = nowSec + 5 * 3600 + 3600 + 60;
    const entries = [e(2000, { five_hour: w(90, outOfRangeSec) }), e(1000, { five_hour: w(30, inRangeSec) })];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour.pct, 30);
    assert.equal(q.fiveHour.resetsAt, inRangeSec * 1000);
  });

  test('seven_day.resets_at は境界のすぐ内側 (nowSec + 7 * 24 * 3600 + 3600 - 60) が候補になり、すぐ外側 (+ 60) は候補にならない', () => {
    const nowSec = Math.floor(now / 1000);
    const inRangeSec = nowSec + 7 * 24 * 3600 + 3600 - 60;
    const outOfRangeSec = nowSec + 7 * 24 * 3600 + 3600 + 60;
    const entries = [e(2000, { seven_day: w(90, outOfRangeSec) }), e(1000, { seven_day: w(30, inRangeSec) })];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.weekly.pct, 30);
    assert.equal(q.weekly.resetsAt, inRangeSec * 1000);
  });

  test('範囲外の値しか無い枠は null になり、そのエントリが他方の枠で正常なら、そちらは選ばれる', () => {
    const nowSec = Math.floor(now / 1000);
    const outOfRangeSec = nowSec + 5 * 3600 + 2 * 3600;
    const validWeeklySec = nowSec + 3 * 24 * 3600;
    const entries = [
      e(1000, {
        five_hour: w(80, outOfRangeSec),
        seven_day: w(40, validWeeklySec),
      }),
    ];
    const q = pickClaudeQuota(entries, now);
    assert.equal(q.fiveHour, null);
    assert.equal(q.weekly.pct, 40);
    assert.equal(q.weekly.resetsAt, validWeeklySec * 1000);
    assert.equal(q.updatedAt, 1000);
  });
});
