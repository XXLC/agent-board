import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scanner } from '../lib/scanner.mjs';
import { ScanWorkers } from '../lib/scan-workers.mjs';
import { laneTokenMetrics } from '../lib/tokens.mjs';

const BASE = Date.parse('2026-01-02T00:00:00Z');
const ZERO = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
const usage = (input = 10, read = 20, write = 30, output = 40) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output,
});
const claudeRecord = (id, uuid, values, delta = 0) => ({
  type: 'assistant', uuid, timestamp: new Date(BASE + delta).toISOString(), cwd: 'D:/Dự án tổng hợp',
  message: { id, model: 'claude-opus', content: [], ...(values === undefined ? {} : { usage: values }) },
});
function fixture(source = 'claude') {
  const scanner = new Scanner({});
  const entry = scanner.makeFile('phiên-tổng-hợp.jsonl', source);
  scanner.files.set(entry.file, entry);
  const line = record => scanner.line(entry, JSON.stringify(record));
  return { scanner, entry, line, runs: () => scanner.runs(BASE + 7_200_000) };
}

test('Claude khử usage lặp theo message.id và cộng nhiều thông điệp đúng định nghĩa total', () => {
  const { line, runs } = fixture();
  line(claudeRecord('thông-điệp-1', 'dòng-1', usage()));
  line(claudeRecord('thông-điệp-1', 'dòng-2', usage(), 1000));
  line(claudeRecord('thông-điệp-2', 'dòng-3', usage(1, 2, 3, 4), 2000));
  const [run] = runs();
  assert.deepEqual(run.tokens, { input: 11, cacheRead: 22, cacheWrite: 33, output: 44, reasoning: 0, total: 110 });
  assert.equal(run.tokenSource, 'claude');
  assert.ok(!('tokenMessages' in run));
});

test('Claude lấy cực đại từng trường khi usage tích lũy hoặc dòng cuối nhỏ hơn', () => {
  const { line, runs } = fixture();
  line(claudeRecord('thông-điệp', 'dòng-1', usage()));
  line(claudeRecord('thông-điệp', 'dòng-2', usage(12, 21, 31, 50), 1000));
  line(claudeRecord('thông-điệp', 'dòng-3', usage(11, 25, 30, 45), 2000));
  assert.deepEqual(runs()[0].tokens, { input: 12, cacheRead: 25, cacheWrite: 31, output: 50, reasoning: 0, total: 118 });
});

test('Claude dự phòng uuid khi thiếu message.id và cập nhật usage mà không đổi mốc bản sao', () => {
  const { line, runs } = fixture();
  line(claudeRecord(undefined, 'dòng-1', usage()));
  line(claudeRecord(undefined, 'dòng-1', usage(10, 20, 30, 50)));
  line(claudeRecord(undefined, 'dòng-2', usage(1, 0, 0, 1), 1000));
  assert.deepEqual(runs()[0].tokens, { input: 11, cacheRead: 20, cacheWrite: 30, output: 51, reasoning: 0, total: 112 });
  assert.equal(runs()[0].end, BASE + 1000);
});

test('Claude chỉ lấy usage assistant, phân biệt thiếu dữ liệu với bộ đếm bằng không', () => {
  const { line, runs } = fixture();
  line({ ...claudeRecord('thông-điệp', 'dòng-1', usage()), type: 'user' });
  line(claudeRecord('thông-điệp-2', 'dòng-2', {}));
  assert.equal(runs()[0].tokens, null);
  assert.equal(runs()[0].tokenSource, null);
  line(claudeRecord('thông-điệp-3', 'dòng-3', usage(0, 0, 0, 0), 1000));
  assert.deepEqual(runs()[0].tokens, ZERO);
  assert.equal(runs()[0].tokenSource, 'claude');
});

test('Usage thiếu trường hoặc sai kiểu không tạo số âm, số lẻ hay NaN', () => {
  const { line, runs } = fixture();
  line(claudeRecord('thông-điệp', 'dòng-1', usage(-1, '20', 1.5, 8)));
  assert.deepEqual(runs()[0].tokens, { ...ZERO, output: 8, total: 8 });
});

test('Đoạn Claude giữ token riêng và hợp đúng khi bản ghi đến muộn nối hai đoạn', () => {
  const { line, runs } = fixture();
  line(claudeRecord('thông-điệp-1', 'dòng-1', usage(1, 2, 3, 4)));
  line(claudeRecord('thông-điệp-2', 'dòng-2', usage(5, 6, 7, 8), 1_200_000));
  assert.deepEqual(runs().map(run => run.tokens.total), [10, 26]);
  line(claudeRecord('thông-điệp-3', 'dòng-3', usage(1, 0, 0, 1), 600_000));
  assert.equal(runs().length, 1);
  assert.deepEqual(runs()[0].tokens, { input: 7, cacheRead: 8, cacheWrite: 10, output: 13, reasoning: 0, total: 38 });
});

test('Hợp đoạn Claude vẫn khử cùng message.id xuất hiện ở hai đoạn', () => {
  const { line, runs } = fixture();
  line(claudeRecord('thông-điệp', 'dòng-1', usage()));
  line(claudeRecord('thông-điệp', 'dòng-2', usage(10, 20, 30, 50), 1_200_000));
  line({ ...claudeRecord(undefined, 'dòng-3', undefined, 600_000), type: 'progress' });
  assert.equal(runs().length, 1);
  assert.equal(runs()[0].tokens.total, 110);
});

const codexUsage = (input = 100, cached = 30, output = 40, reasoning = 10) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const codexRecord = (type, payload, delta = 0) => ({ type, payload, timestamp: new Date(BASE + delta).toISOString() });
const tokenEvent = values => codexRecord('event_msg', { type: 'token_count', info: { total_token_usage: values } });

test('Codex chuẩn hóa cached và reasoning, không cộng reasoning hai lần', () => {
  const { line, runs } = fixture('codex');
  line(tokenEvent(codexUsage()));
  assert.deepEqual(runs()[0].tokens, { input: 70, cacheRead: 30, cacheWrite: 0, output: 40, reasoning: 10, total: 140 });
  assert.equal(runs()[0].tokenSource, 'codex');
});

test('Codex lấy tích lũy cuối, không cộng các token_count và bỏ sự kiện info null', () => {
  const { line, runs } = fixture('codex');
  line(tokenEvent(codexUsage()));
  line(tokenEvent(codexUsage(300, 100, 90, 30)));
  line(codexRecord('event_msg', { type: 'token_count', info: null }));
  assert.deepEqual(runs()[0].tokens, { input: 200, cacheRead: 100, cacheWrite: 0, output: 90, reasoning: 30, total: 390 });
});

test('Codex token_usage_record chọn thread_token_usage, không cộng bản ghi phản chiếu', () => {
  const { line, runs } = fixture('codex');
  const values = codexUsage(300, 100, 90, 30);
  line(codexRecord('token_usage_record', { usage: codexUsage(), turn_token_usage: codexUsage(), thread_token_usage: values }));
  line(tokenEvent(values));
  line(codexRecord('token_usage_record', { thread_token_usage: codexUsage(400, 110, 100, 35) }));
  assert.deepEqual(runs()[0].tokens, { input: 290, cacheRead: 110, cacheWrite: 0, output: 100, reasoning: 35, total: 500 });
});

test('Codex không suy tổng từ total_tokens hoặc bộ đếm mỗi lượt khi thiếu tích lũy', () => {
  const { line, runs } = fixture('codex');
  line(codexRecord('token_usage_record', { usage: codexUsage(), turn_token_usage: codexUsage() }));
  line(tokenEvent({ total_tokens: 100 }));
  assert.equal(runs()[0].tokens, null);
  assert.equal(runs()[0].tokenSource, null);
  line(tokenEvent({ input_tokens: 12, total_tokens: 999 }));
  assert.deepEqual(runs()[0].tokens, { ...ZERO, input: 12, total: 12 });
});

test('Phiên Codex đang chạy xuất giá trị token tích lũy hiện có', () => {
  const { line, scanner, entry } = fixture('codex');
  entry.mtime = BASE;
  line(codexRecord('event_msg', { type: 'task_started' }));
  line(tokenEvent(codexUsage()));
  const [run] = scanner.runs(BASE + 1000);
  assert.equal(run.running, true);
  assert.equal(run.end, null);
  assert.equal(run.tokens.total, 140);
  assert.equal(scanner.state(BASE + 1000).lanes.find(lane => lane.lane === 'Codex').tokensRunning, 140);
});

test('Ghép Claude-tool lấy token rollout và không lấy token đoạn Claude giao việc', () => {
  const { scanner, entry, line } = fixture();
  line(claudeRecord('thông-điệp', 'dòng-1', usage()));
  entry.runs.set('công-cụ', [{
    id: 'lần-giao', lane: 'Codex', source: 'claude-tool', sourceSession: entry.session,
    start: BASE, end: BASE + 1000, project: entry.project, kind: 'giao việc', status: 'ok', evidence: 'Dữ liệu tổng hợp.',
  }]);
  const rollout = scanner.makeFile('rollout-tổng-hợp.jsonl', 'codex');
  scanner.files.set(rollout.file, rollout);
  scanner.line(rollout, JSON.stringify(codexRecord('session_meta', { originator: 'codex_exec', cwd: entry.project })));
  scanner.line(rollout, JSON.stringify(tokenEvent(codexUsage())));
  const run = scanner.runs(BASE + 7_200_000).find(run => run.id === 'lần-giao');
  assert.equal(run.merged, true);
  assert.equal(run.tokens.total, 140);
  assert.equal(run.tokenSource, 'codex');
  assert.equal(scanner.runs(BASE + 7_200_000).filter(run => run.lane === 'Codex').length, 1);
});

test('Lệnh chưa ghép, agy độc lập và agy đã ghép đều để token null khi chưa xác minh được nguồn', () => {
  const { scanner, entry } = fixture();
  entry.runs.set('công-cụ', [
    { id: 'chưa-ghép', lane: 'Codex', start: BASE, end: BASE + 1000, source: 'claude-tool', evidence: 'Dữ liệu tổng hợp.' },
    { id: 'đã-ghép', lane: 'Opus', model: 'claude-opus-5-5-high', start: BASE, end: BASE + 1000,
      source: 'claude-tool', status: 'unknown', evidence: 'Dữ liệu tổng hợp.' },
  ]);
  for (const [i, model] of ['claude-opus-5-5-high', 'gemini-4-argon-high'].entries()) {
    scanner.agy.cache.set(`tổng-hợp-${i}`, { mtime: BASE, record: {
      id: `hội-thoại-${i}`, model, start: BASE, end: BASE + 2000, lastStatus: 3,
    } });
  }
  const runs = scanner.runs(BASE + 7_200_000);
  assert.equal(runs.length, 3);
  assert.ok(runs.some(run => run.agySession));
  assert.ok(runs.every(run => run.tokens === null && run.tokenSource === null));
});

const interval = (start, end, tokens = null, running = false) => ({ start, end, tokens, running });

test('busyMs24h lấy hợp khoảng chồng nhau, chứa nhau và liền kề', () => {
  const result = laneTokenMetrics([
    interval(BASE - 3000, BASE - 1000), interval(BASE - 4000, BASE - 2000),
    interval(BASE - 2500, BASE - 2000), interval(BASE - 1000, BASE),
  ], BASE);
  assert.equal(result.busyMs24h, 4000);
});

test('busyMs24h cắt cả hai mép cửa sổ, lấy tới now cho run đang chạy từ hôm trước', () => {
  const from = BASE - 86_400_000;
  assert.equal(laneTokenMetrics([
    interval(from - 2000, from - 1000), interval(from - 1000, from + 1000),
    interval(BASE - 2000, BASE + 2000), interval(BASE - 4000, null, null, true),
    interval(BASE + 1000, BASE + 3000),
  ], BASE).busyMs24h, 5000);
  const result = laneTokenMetrics([interval(from - 1000, null, { ...ZERO, total: 5 }, true)], BASE);
  assert.equal(result.busyMs24h, 86_400_000);
  assert.equal(result.tokensRunning, 5);
  assert.equal(result.tokens24h.runsTotal, 0);
});

test('tokens24h đếm độ phủ, cộng mọi thành phần và tokensRunning không phụ thuộc giờ bắt đầu', () => {
  const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, reasoning: 5, total: 100 };
  const result = laneTokenMetrics([
    interval(BASE - 86_400_001, null, tokens, true), interval(BASE - 86_400_000, BASE - 1000, tokens),
    interval(BASE - 500, null, tokens, true), interval(BASE, BASE), interval(BASE - 100, BASE, ZERO),
  ], BASE);
  assert.deepEqual(result.tokens24h, {
    input: 20, cacheRead: 40, cacheWrite: 60, output: 80, reasoning: 10, total: 200, runsWithTokens: 3, runsTotal: 4,
  });
  assert.equal(result.tokensRunning, 200);
});

test('Làn rỗng có bộ đếm đầy đủ bằng không', () => {
  const { scanner } = fixture();
  for (const lane of scanner.state(BASE).lanes) {
    assert.deepEqual(lane.tokens24h, { ...ZERO, runsWithTokens: 0, runsTotal: 0 });
    assert.equal(lane.tokensRunning, 0);
    assert.equal(lane.busyMs24h, 0);
  }
});

test('state tổng hợp Claude trên đoạn hoạt động, không cộng lần giao việc', () => {
  const { scanner, entry, line } = fixture();
  line(claudeRecord('thông-điệp', 'dòng-1', usage()));
  line(claudeRecord('thông-điệp-2', 'dòng-2', usage(1, 2, 3, 4), 1000));
  entry.runs.set('công-cụ', [{ id: 'lần-giao', lane: 'Codex', start: BASE, end: BASE + 1000,
    source: 'claude-tool', evidence: 'Dữ liệu tổng hợp.' }]);
  const state = scanner.state(BASE + 2000), claude = state.lanes.find(lane => lane.lane === 'Claude');
  assert.deepEqual(claude.tokens24h, {
    input: 11, cacheRead: 22, cacheWrite: 33, output: 44, reasoning: 0, total: 110, runsWithTokens: 1, runsTotal: 1,
  });
  assert.equal(claude.busyMs24h, 1000);
  const codex = state.lanes.find(lane => lane.lane === 'Codex');
  assert.equal(codex.tokens24h.runsTotal, 1);
  assert.equal(codex.tokens24h.runsWithTokens, 0);
});

test('Token qua luồng quét và nối thêm vẫn khử đúng mã thông điệp', async () => {
  const root = fileURLToPath(new URL('../.cache/', import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'kiểm-thử-token-'));
  const scanner = new Scanner({}), workers = new ScanWorkers({});
  try {
    const file = path.join(dir, 'phiên.jsonl'), entry = scanner.makeFile(file, 'claude');
    await writeFile(file, JSON.stringify(claudeRecord('thông-điệp', 'dòng-1', usage())) + '\n');
    const result = await workers.read(entry, (await stat(file)).size);
    scanner.files.set(file, result.entry);
    await appendFile(file, JSON.stringify(claudeRecord('thông-điệp', 'dòng-2', usage(10, 20, 30, 50), 1000)) + '\n');
    await scanner.readAppend(result.entry, (await stat(file)).size);
    const [run] = scanner.runs(BASE + 7_200_000);
    assert.equal(run.tokens.total, 110);
    run.tokens.total = 999;
    assert.equal(scanner.runs(BASE + 7_200_000)[0].tokens.total, 110);
  } finally {
    scanner.stop(); await workers.stop();
    assert.ok(path.resolve(dir).startsWith(path.resolve(root) + path.sep));
    await rm(dir, { recursive: true });
  }
});
