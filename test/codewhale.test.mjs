import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodewhaleOutput, mergeCodewhale, parseCommands, resultStatus } from '../lib/parsers.mjs';
import { tokenBreakdown } from '../public/counters.js';
import { LANE_LABELS } from '../public/model-labels.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../lib/scanner.mjs';

const lanes = command => parseCommands(command).map(({ lane, model, prompt }) => ({ lane, model, prompt }));

test('Lệnh codewhale exec thành lần giao cho làn DeepSeek, kể cả .cmd, alias codew và đường dẫn đầy đủ', () => {
  assert.deepEqual(lanes('codewhale exec "Reply with exactly: pong"'),
    [{ lane: 'DeepSeek', model: '', prompt: 'Reply with exactly: pong' }]);
  assert.deepEqual(lanes('& "C:\\Users\\x\\AppData\\Roaming\\npm\\codewhale.cmd" exec --auto --model deepseek-v4-pro "Lam viec A"'),
    [{ lane: 'DeepSeek', model: 'deepseek-v4-pro', prompt: 'Lam viec A' }]);
  assert.deepEqual(lanes('cd /d/proj && codew exec --auto --max-turns 4 -- "-lam gi do"'),
    [{ lane: 'DeepSeek', model: '', prompt: '-lam gi do' }]);
});

test('Không coi trợ giúp, phiên bản, lệnh con khác hay chuỗi trích dẫn là lần giao DeepSeek', () => {
  for (const command of ['codewhale --version', 'codewhale exec --help', 'codewhale sessions', 'echo codewhale exec "khong phai lenh"']) {
    assert.deepEqual(lanes(command), [], command);
  }
});

test('Làn DeepSeek có tên hiển thị riêng và model deepseek- không rơi sang làn khác', () => {
  assert.equal(LANE_LABELS.DeepSeek, 'DeepSeek');
});

test('Hết số dư 402 chỉ nhận khi đi kèm ngữ cảnh lỗi; số 402 trần không phải quota', () => {
  assert.equal(resultStatus('HTTP 402 Insufficient Balance'), 'quota');
  assert.equal(resultStatus('Error: status code: 402'), 'quota');
  assert.equal(resultStatus('429 Too Many Requests'), 'quota');
  assert.equal(resultStatus('xem dòng 402 của tệp'), 'ok');
  assert.equal(resultStatus('Process exited with code 402'), 'error');
  assert.equal(resultStatus('xong'), 'ok');
});

test('Đọc phiên, model và token từ đầu ra Codewhale bằng dữ liệu tổng hợp', () => {
  const usage = JSON.stringify({ usage: { input_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, output_tokens: 50, reasoning_tokens: 10 } });
  const result = extractCodewhaleOutput(`session: 665eb77a-74d8-43a1-9276-28c3e6af0c66\n"model":"deepseek-v4-pro" ${usage}`);
  assert.equal(result.sessionHint, '665eb77a-74d8-43a1-9276-28c3e6af0c66');
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.deepEqual(result.tokens, { input: 600, cacheRead: 400, cacheWrite: 0, output: 50, reasoning: 10, total: 1050 });
});

test('Đầu ra không có usage thì không đoán token', () => {
  const result = extractCodewhaleOutput('pong');
  assert.equal(result.tokens, null);
  assert.equal(result.model, '');
});

test('Wrapper node deepseek-exec.mjs là lần giao DeepSeek: dự án từ --cwd, model từ --model, không nhận khi chỉ là chuỗi trích dẫn', () => {
  const rows = command => parseCommands(command).map(({ lane, project, model, promptSource }) => ({ lane, project, model, promptSource }));
  assert.deepEqual(rows('cd /d/x && node /d/Workspace/ai-standalone-bridge/src/deepseek-exec.mjs --cwd D:\\Workspace\\app --prompt-file "$SP/q.txt" --auto --model deepseek-v4-pro'),
    [{ lane: 'DeepSeek', project: 'D:\\Workspace\\app', model: 'deepseek-v4-pro', promptSource: 'không có' }]);
  assert.deepEqual(rows('node deepseek-exec.mjs --cwd D:\\proj --prompt "Làm A"'),
    [{ lane: 'DeepSeek', project: 'D:\\proj', model: '', promptSource: 'lệnh' }]);
  assert.deepEqual(rows('echo node deepseek-exec.mjs --cwd D:\\proj --prompt "x"'), []);
});

test('Ghép phiên Codewhale với lần giao nền khi thông báo hoàn tất đến muộn, vẫn không ghép khi ngoài khoảng chạy', () => {
  const run = (id, start, end, extra = {}) => ({ id, lane: 'DeepSeek', project: 'D:\\Workspace\\app', model: 'deepseek-v4-pro', start, end, endEstimated: false, background: true, prompt: '', promptSource: 'không có', sourceSession: 'claude-1', projectKey: 'hlds', status: 'unknown', kind: 'giao việc', ...extra });
  const session = (start, extra = {}) => ({ id: `codewhale:${start}`, lane: 'DeepSeek', source: 'codewhale-session', sourceSession: `s${start}`, workspace: 'D:\\Workspace\\app', project: 'D:\\Workspace\\app', model: 'deepseek-v4-pro', start, end: start, kind: 'hội thoại', status: 'unknown', prompt: '', tokens: null, ...extra });
  // Lần giao nền chạy 11:29:00, thông báo đến 11:48:00 (muộn), phiên lưu 11:36:00.
  const base = Date.parse('2026-11-12T11:29:00Z');
  const merged = mergeCodewhale([run('r1', base, base + 19 * 60_000)], [session(base + 7 * 60_000)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].projectKey, 'hlds');
  assert.equal(merged[0].merged, true);
  // Phiên nằm ngoài khoảng chạy thì giữ riêng.
  const outside = mergeCodewhale([run('r1', base, base + 19 * 60_000)], [session(base + 60 * 60_000)]);
  assert.equal(outside.length, 2);
  // Lần giao không chạy nền: vẫn giữ cửa sổ 120 giây.
  const foreground = mergeCodewhale([run('r1', base, base + 19 * 60_000, { background: false })], [session(base + 7 * 60_000)]);
  assert.equal(foreground.length, 2);
});

test('Phiên Codewhale chỉ có tổng token gộp được giữ làm số liệu chỉ-tổng, không bịa thành phần vào/ra', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cw-total-'));
  try {
    const file = path.join(dir, 'a1b2c3d4-0000-4000-8000-000000000002.json');
    const body = JSON.stringify({ metadata: { id: 'a1b2c3d4-0000-4000-8000-000000000002', model: 'deepseek-flash', workspace: 'D:\\Workspace\\app', created_at: '2026-11-12T10:00:00Z', updated_at: '2026-11-12T10:00:05Z', total_tokens: 45881 }, messages: [] });
    await writeFile(file, body);
    const entry = { file, source: 'codewhale', session: 'x' };
    await new Scanner().readCodewhale(entry, Buffer.byteLength(body));
    assert.deepEqual(entry.tokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 45881, totalOnly: true });
    assert.match(tokenBreakdown(entry.tokens), /Tổng: .*45.*881 token \(số liệu gộp/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Phiên Codewhale có chuỗi giống khóa trong nội dung vẫn được đọc, lời nhắc bị che', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cw-secret-'));
  try {
    const file = path.join(dir, 'a1b2c3d4-0000-4000-8000-000000000001.json');
    const body = JSON.stringify({
      metadata: { id: 'a1b2c3d4-0000-4000-8000-000000000001', model: 'deepseek-flash', workspace: 'D:\\Workspace\\app', created_at: '2026-11-12T10:00:00Z', updated_at: '2026-11-12T10:00:05Z' },
      messages: [{ role: 'user', content: 'Rà soát mã dùng sk-test-0000-CHI-DUNG-KIEM-THU' }, { role: 'assistant', content: 'xong sk-test-0000-CHI-DUNG-KIEM-THU' }],
    });
    await writeFile(file, body);
    const entry = { file, source: 'codewhale', session: 'x' };
    await new Scanner().readCodewhale(entry, Buffer.byteLength(body));
    assert.notEqual(entry.started, null);
    assert.equal(entry.model, 'deepseek-flash');
    assert.equal(entry.cwd, 'D:\\Workspace\\app');
    assert.ok(!JSON.stringify(entry).includes('sk-test-0000'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
