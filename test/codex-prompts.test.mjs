import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { parseCommands, mergeCodex, missingPrompt } from '../lib/parsers.mjs';
import { readPromptFile } from '../lib/prompt-files.mjs';
import { Scanner, rolloutPrompt } from '../lib/scanner.mjs';

async function temporary(t) {
  const root = path.resolve('.cache');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'lời-nhắc-tổng-hợp-'));
  t.after(async () => { assert.ok(dir.startsWith(root + path.sep)); await rm(dir, { recursive: true }); });
  return dir;
}

test('Codex không nhận toán tử shell hoặc đối số sau dấu stdin làm lời nhắc', () => {
  for (const tail of ['2>&1 | tail -5', "*> 'D:/kết-quả.txt'", '> D:/kết-quả.txt', '>> D:/kết-quả.txt',
    '2> D:/lỗi.txt', '1>&2', '| Out-File D:/kết-quả.txt', '&& echo xong', '; echo xong', '&']) {
    const [run] = parseCommands(`codex exec -C D:/Tổng-hợp - ${tail}`);
    assert.equal(run.promptSource, 'không có', tail);
    assert.equal(run.prompt, missingPrompt(), tail);
  }
  assert.equal(parseCommands('codex exec 2>&1')[0].prompt, missingPrompt());
  assert.equal(parseCommands('codex exec -*> D:/kết-quả.txt')[0].prompt, missingPrompt());
  assert.equal(parseCommands('codex exec -p hồ-sơ --add-dir D:/thêm --ask-for-approval never - 2>&1')[0].prompt, missingPrompt());
});

test('Đọc chuỗi stdin, heredoc và nguồn tệp từ các hình dạng giao Codex', () => {
  for (const command of [
    'echo "Kiểm tra dữ liệu tổng hợp" | codex exec -s read-only - 2>&1 | tail -5',
    "'Kiểm tra dữ liệu tổng hợp' | codex exec -C 'D:/Tổng-hợp' --skip-git-repo-check - *> 'D:/kết-quả.txt'",
    'printf "%s" "Kiểm tra dữ liệu tổng hợp" | codex exec -',
    "codex exec - <<'VIEC'\n\nKiểm tra dữ liệu tổng hợp\nDòng không lưu\nVIEC",
  ]) {
    const [run] = parseCommands(command);
    assert.equal(run.prompt, 'Kiểm tra dữ liệu tổng hợp');
    assert.equal(run.promptSource, 'lệnh');
  }
  for (const command of [
    '$sp = "D:/lời-nhắc.txt"; Get-Content "D:/lời-nhắc.txt" -Raw -Encoding utf8 | & codex exec -C "D:/Tổng-hợp" -s workspace-write - 2>&1 | Out-File D:/kết-quả.txt',
    'cat D:/lời-nhắc.txt | codex exec -',
    'Get-Content -Raw -Encoding utf8 "D:/lời-nhắc.txt" | codex exec -',
    'cd D:/Tổng-hợp && "D:/công-cụ/codex.exe" exec -C D:/Tổng-hợp -o D:/kết-quả.txt < D:/lời-nhắc.txt',
  ]) {
    const [run] = parseCommands(command);
    assert.equal(run.promptFile, 'D:/lời-nhắc.txt');
    assert.equal(run.promptSource, 'không có');
    assert.equal(run.prompt, 'Lời nhắc truyền qua stdin từ tệp lời-nhắc.txt');
  }
});

test('Nhiều lần gọi trong cùng shell không mượn nguồn stdin của nhau', () => {
  const runs = parseCommands('echo "Lời nhắc đầu tổng hợp" | codex exec -; codex exec - 2>&1; cat D:/việc.txt | codex exec -');
  assert.equal(runs.length, 3);
  assert.equal(runs[0].promptSource, 'lệnh');
  assert.equal(runs[1].prompt, missingPrompt());
  assert.equal(runs[2].promptFile, 'D:/việc.txt');
  const here = parseCommands('codex exec - <<VIEC\nLời nhắc đầu tổng hợp\nVIEC\ncodex exec - <<VIEC\nLời nhắc thứ hai tổng hợp\nVIEC');
  assert.equal(here[0].prompt, 'Lời nhắc đầu tổng hợp');
  assert.equal(here[1].prompt, 'Lời nhắc thứ hai tổng hợp');
});

test('Ghép ưu tiên lời nhắc lệnh rõ nghĩa, bổ sung rollout và model khi thiếu', () => {
  const assignment = { id: 'lệnh', lane: 'Codex', project: 'D:/Tổng-hợp', start: 1000, sourceSession: 'phiên-Claude', prompt: missingPrompt() };
  const rollout = { id: 'rollout', lane: 'Codex', project: 'D:/Tổng-hợp', start: 2000, sourceSession: 'phiên-Codex',
    kind: 'giao việc', prompt: 'Lời nhắc rollout tổng hợp', promptSource: 'rollout', model: 'gpt-6' };
  for (const prompt of ['', '2', '*', missingPrompt(), missingPrompt('D:/việc.txt')]) {
    const [run] = mergeCodex([{ ...assignment, prompt, model: '' }], [rollout]);
    assert.equal(run.prompt, rollout.prompt); assert.equal(run.promptSource, 'rollout'); assert.equal(run.model, 'gpt-6');
  }
  const [run] = mergeCodex([{ ...assignment, prompt: 'Lời nhắc lệnh tổng hợp', promptSource: 'lệnh', model: 'gpt-6' }], [{ ...rollout, model: '' }]);
  assert.equal(run.promptSource, 'lệnh'); assert.equal(run.prompt, 'Lời nhắc lệnh tổng hợp'); assert.equal(run.model, 'gpt-6');
  const [missing] = mergeCodex([{ ...assignment, prompt: '2' }], [{ ...rollout, prompt: '' }]);
  assert.equal(missing.prompt, missingPrompt()); assert.equal(missing.promptSource, 'không có');
});

test('Response item bỏ mọi khối ngữ cảnh, lấy input_text đầu còn lại và chỉ lưu dòng xem trước', () => {
  for (const context of ['<environment_context>Thư mục tổng hợp</environment_context>',
    '<user_instructions>Chỉ dẫn tổng hợp</user_instructions>', '<permissions instructions>Quyền tổng hợp</permissions>',
    '<INSTRUCTIONS>Chỉ dẫn tổng hợp</INSTRUCTIONS>', '# AGENTS.md instructions\nChỉ dẫn tổng hợp',
    '<wrapper><environment_context>Ngữ cảnh tổng hợp</environment_context></wrapper>']) {
    const content = [{ type: 'input_text', text: context }, { type: 'input_text', text: '<user_request>\nSửa dữ liệu tổng hợp token=bí-mật\nDòng không lưu\n</user_request>' }];
    assert.equal(rolloutPrompt(content), 'Sửa dữ liệu tổng hợp [đã che]');
    const scanner = new Scanner({}), entry = scanner.makeFile('rollout-tổng-hợp.jsonl', 'codex');
    scanner.files.set(entry.file, entry);
    const line = payload => scanner.line(entry, JSON.stringify({ timestamp: '2026-11-07T00:00:00Z', type: 'response_item', payload }));
    line({ type: 'message', role: 'assistant', content });
    assert.equal(entry.prompt, '');
    line({ type: 'message', role: 'user', content });
    line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Không thay lời nhắc đầu' }] });
    const [run] = scanner.runs();
    assert.equal(run.prompt, 'Sửa dữ liệu tổng hợp [đã che]'); assert.equal(run.promptSource, 'rollout');
  }
});

test('Tệp lời nhắc chỉ đọc hai gốc cho phép, che bí mật và giới hạn 8 KB đầu', async t => {
  const dir = await temporary(t), tempRoot = path.join(dir, 'tmp'), claudeRoot = path.join(dir, 'projects');
  const allowed = path.join(tempRoot, 'claude');
  await mkdir(allowed, { recursive: true }); await mkdir(claudeRoot);
  const options = { tempRoot, claudeRoot };
  for (const root of [allowed, claudeRoot]) {
    const file = path.join(root, 'việc.txt');
    await writeFile(file, 'Sửa dữ liệu tổng hợp token=bí-mật\nDòng không lưu');
    assert.equal(await readPromptFile(file, options), 'Sửa dữ liệu tổng hợp [đã che]');
  }
  const outside = path.join(dir, 'ngoài.txt'); await writeFile(outside, 'Không được đọc nội dung tổng hợp này');
  assert.equal(await readPromptFile(outside, options), '');
  assert.equal(await readPromptFile(path.relative(process.cwd(), outside), options), '');
  await mkdir(allowed + '-giả');
  const fake = path.join(allowed + '-giả', 'việc.txt'); await writeFile(fake, 'Không được đọc');
  assert.equal(await readPromptFile(fake, options), '');
  const large = path.join(allowed, 'quá-lớn.txt'); await writeFile(large, 'ữ'.repeat(600_000));
  assert.equal(await readPromptFile(large, options), '');
  const boundary = path.join(allowed, 'đúng-một-MB.txt'), bytes = Buffer.alloc(1024 * 1024);
  bytes.write('Lời nhắc tổng hợp đúng giới hạn\n'); await writeFile(boundary, bytes);
  assert.equal(await readPromptFile(boundary, options), 'Lời nhắc tổng hợp đúng giới hạn');
  const limited = path.join(allowed, 'giới-hạn.txt'); await writeFile(limited, '\n'.repeat(8192) + 'Không đọc phần sau');
  assert.equal(await readPromptFile(limited, options), '');
  assert.equal(await readPromptFile(allowed, options), '');
});

test('Chặn liên kết thư mục trong cây tệp lời nhắc dù đích cũng thuộc gốc cho phép', async t => {
  const dir = await temporary(t), tempRoot = path.join(dir, 'tmp'), allowed = path.join(tempRoot, 'claude');
  const target = path.join(allowed, 'đích'); await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'việc.txt'), 'Lời nhắc tổng hợp không được theo liên kết');
  const link = path.join(allowed, 'liên-kết'); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await readPromptFile(path.join(link, 'việc.txt'), { tempRoot, claudeRoot: path.join(dir, 'projects') }), '');
});

test('Nguồn tệp chỉ được thử khi chưa ghép rollout; kết quả được gắn đúng nguồn', async () => {
  const scanner = new Scanner({});
  scanner.cachedRuns = [
    { lane: 'Codex', promptSource: 'không có', promptFile: 'D:/ngoài.txt' },
    { lane: 'Codex', promptSource: 'không có', promptFile: 'D:/đã-ghép.txt', rolloutSession: 'phiên' },
    { lane: 'Codex', promptSource: 'tệp', promptFile: 'D:/đã-mất.txt' },
  ];
  await scanner.loadPromptFiles();
  assert.equal(scanner.promptFiles.has('D:/ngoài.txt'), true); assert.equal(scanner.promptFiles.has('D:/đã-ghép.txt'), false);
  assert.equal(scanner.promptFiles.get('D:/đã-mất.txt'), '');
  const entry = scanner.makeFile('phiên.jsonl', 'claude'); scanner.files.set(entry.file, entry);
  entry.runs.set('việc', [{ id: 'lệnh', source: 'claude-tool', lane: 'Codex', promptSource: 'không có', promptFile: 'D:/ngoài.txt',
    start: 1000, end: 2000, evidence: 'Dữ liệu tổng hợp', prompt: missingPrompt() }]);
  scanner.promptFiles.set('D:/ngoài.txt', 'Dòng xem trước tổng hợp');
  const [run] = scanner.runs();
  assert.equal(run.promptSource, 'tệp'); assert.equal(run.prompt, 'Dòng xem trước tổng hợp');
});
