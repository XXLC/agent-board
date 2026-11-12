import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodewhaleOutput, parseCommands, resultStatus } from '../lib/parsers.mjs';
import { LANE_LABELS } from '../public/model-labels.js';

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
