import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatTokens, tokenBreakdown, coverageText, laneCounters, rangeCounters } from '../public/counters.js';

const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, reasoning: 15, total: 100 };

test('Thời lượng có đơn vị, cắt giây lẻ và xử lý ranh giới giây, phút, giờ', () => {
  for (const [ms, expected] of [[-1, '0 giây'], [NaN, '0 giây'], [42_999, '42 giây'], [60_000, '1 phút 0 giây'],
    [425_000, '7 phút 5 giây'], [3599_000, '59 phút 59 giây'], [3600_000, '1 giờ 0 phút'], [11520_000, '3 giờ 12 phút']]) {
    assert.equal(formatDuration(ms), expected);
  }
});

test('Token dùng dấu tiếng Việt và đơn vị triệu, tỷ, không tạo 1.000 triệu ở ranh giới', () => {
  for (const [n, expected] of [[0, '0'], [1712, '1.712'], [999_949, '999.949'], [999_950, '1,0 triệu'],
    [1e6, '1,0 triệu'], [52e6, '52,0 triệu'], [229_700_000, '229,7 triệu'], [999_950_000, '1,00 tỷ'], [1_230_000_000, '1,23 tỷ']]) {
    assert.equal(formatTokens(n), expected);
  }
  assert.equal(formatTokens(null), '0');
  assert.equal(formatTokens(-10), '0');
});

test('Chi tiết ghi sáu thành phần, suy luận nằm trong ra và tổng không cộng suy luận lần nữa', () => {
  assert.equal(tokenBreakdown(tokens), 'Vào: 10 token · Cache đọc: 20 token · Cache ghi: 30 token · Ra: 40 token'
    + ' · Suy luận (nằm trong ra): 15 token · Tổng: 100 token');
  assert.equal(tokenBreakdown(null), 'Chưa đọc được token');
  assert.equal(rangeCounters([{ tokens }]).tokens.total, 100);
});

test('Độ phủ tính cả số liệu token bằng không, không coi thiếu số liệu là không tốn token', () => {
  const data = rangeCounters([{ tokens }, { tokens: null }, { tokens: { ...tokens, total: 0 } }]);
  assert.equal(coverageText(data), '2/3 lần có số liệu');
  assert.equal(coverageText(44, 50), '44/50 lần có số liệu');
  assert.equal(coverageText({}), '0/0 lần có số liệu');
});

test('Hợp khoảng chồng nhau, chứa nhau, liền kề và rời nhau chỉ cộng thời gian một lần', () => {
  const runs = [[0, 100], [20, 40], [80, 120], [120, 160], [200, 240]].map(([start, end]) => ({ start, end }));
  const copy = structuredClone(runs);
  assert.equal(rangeCounters(runs, 300).busyMs, 200);
  assert.deepEqual(runs, copy);
  assert.equal(rangeCounters([], 300).busyMs, 0);
});

test('Run đang chạy luôn tới now, cắt hai mép khoảng và bỏ khoảng sai', () => {
  const runs = [{ start: -20, end: 10_000, running: true, tokens }, { start: 110, end: 160 },
    { start: 200, end: 100 }, { start: NaN, end: 10 }];
  const data = rangeCounters(runs, 100, { from: 20, to: 140 });
  assert.equal(data.busyMs, 110);
  assert.equal(data.tokens.total, 100);
});

test('Làn agy chưa đọc được khác với số token thật bằng không, có lý do và độ phủ', () => {
  for (const lane of ['Opus', 'Argon']) {
    const data = laneCounters({ lane, tokens24h: { total: 0, runsWithTokens: 0, runsTotal: 12 } }, 1000);
    assert.equal(data.tokens, null);
    assert.equal(data.tokenText, 'chưa đọc được token');
    assert.equal(data.reason, 'chưa có lần gọi model nào hoàn tất để tính token');
    assert.equal(data.coverage, '0/12 lần có số liệu');
  }
  const zero = laneCounters({ lane: 'Codex', tokens24h: { total: 0, runsWithTokens: 1, runsTotal: 1 } }, 1000);
  assert.equal(zero.tokenText, '0 token');
});

test('Bộ đếm làn chỉ cộng phần trôi từ lần nhận mới và chỉ khi làn đang chạy', () => {
  const lane = { lane: 'Codex', running: true, busyMs24h: 10_000,
    tokens24h: { ...tokens, runsWithTokens: 1, runsTotal: 2 }, tokensRunning: 55 };
  assert.equal(laneCounters(lane, 5000, 2000).busyMs, 13_000);
  assert.equal(laneCounters({ ...lane, busyMs24h: 13_000 }, 6000, 5000).busyMs, 14_000);
  assert.equal(laneCounters({ ...lane, running: false }, 5000, 2000).busyMs, 10_000);
  assert.equal(laneCounters(lane, 1000, 2000).busyMs, 10_000);
  assert.equal(laneCounters(lane, 5000, 2000).runningTokens, 55);
});
