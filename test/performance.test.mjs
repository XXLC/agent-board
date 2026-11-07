import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Scanner } from '../lib/scanner.mjs';
import { ScanWorkers } from '../lib/scan-workers.mjs';
import { mergeCodex, promptPreview } from '../lib/parsers.mjs';
import { projectResolver, resolveProject, distinguishProjects } from '../lib/projects.mjs';

async function temporary(t) {
  const cache = path.resolve('.cache');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, 'hiệu-năng-tổng-hợp-'));
  t.after(async () => { assert.ok(dir.startsWith(cache + path.sep)); await rm(dir, { recursive: true }); });
  return dir;
}

test('Chỉ mục Codex giữ ghép tham lam, thứ tự hòa, UUID trùng và biên 120 giây như cách duyệt trực tiếp', () => {
  const projects = ['D:/Tổng-hợp', 'd:/tổng-hợp/', 'E:/Khác', '', 'D:/Tổng-hợp//'];
  const assignments = Array.from({ length: 300 }, (_, i) => ({
    id: `lệnh-${i % 293}`, lane: i % 7 ? 'Codex' : 'Opus', start: Math.floor(i / 3) * 9000,
    project: projects[i % projects.length], sourceSession: `phiên-${i % 9}`, status: 'unknown',
  }));
  const rollouts = Array.from({ length: 400 }, (_, i) => ({
    id: `rollout-${i}`, sourceSession: `rollout-${i}`, lane: 'Codex', start: (399 - i) * 3000,
    kind: i % 13 ? 'giao việc' : 'tương tác', claudeSession: i % 4 ? '' : `phiên-${i % 9}`,
    project: projects[(i + 2) % projects.length], status: 'ok',
  }));
  const norm = value => String(value || '').replaceAll(String.fromCharCode(92), '/').replace(/\/$/, '').toLowerCase();
  const used = new Set(), expected = assignments.map(run => ({ id: run.id, rolloutSession: undefined }));
  for (const rollout of [...rollouts].sort((a, b) => a.start - b.start)) {
    const match = rollout.kind !== 'tương tác' && assignments.filter(run => run.lane === 'Codex'
      && !used.has(run.id) && (norm(run.project) && norm(run.project) === norm(rollout.project)
        || rollout.claudeSession && rollout.claudeSession === run.sourceSession)
      && Math.abs(run.start - rollout.start) <= 120_000)
      .sort((a, b) => Math.abs(a.start - rollout.start) - Math.abs(b.start - rollout.start))[0];
    if (match) { used.add(match.id); expected[assignments.indexOf(match)].rolloutSession = rollout.sourceSession; }
    else expected.push({ id: rollout.id, rolloutSession: undefined });
  }
  assert.deepEqual(mergeCodex(assignments, rollouts).map(({ id, rolloutSession }) => ({ id, rolloutSession })), expected);
});

test('Chuẩn hóa theo lượt dựng tương đương tra trực tiếp, nhận dự án bổ sung và nhãn mới', async t => {
  const dir = await temporary(t);
  const projects = [{ projectKey: 'gốc', projectPath: dir, projectLabel: 'Gốc' },
    { projectKey: 'con', projectPath: dir + '/con', projectLabel: 'Con' }];
  const resolve = projectResolver(projects);
  for (const project of [dir, dir + '/con/tệp', dir.toUpperCase(), dir.replaceAll('/', String.fromCharCode(92)),
    'file:///' + dir.replaceAll(String.fromCharCode(92), '/'), '', 'C:/Temp/không-rõ', dir + '-khác']) {
    for (const source of ['agy-db', 'codex-rollout', 'claude-tool']) {
      const run = { source, workspace: project, project };
      assert.deepEqual(resolve(run), resolveProject(run, projects));
    }
  }
  projects.push({ projectKey: 'thêm', projectPath: dir + '/con/sâu', projectLabel: 'Nhãn cũ' });
  distinguishProjects(projects);
  assert.deepEqual(resolve({ project: dir + '/con/sâu/tệp' }), resolveProject({ project: dir + '/con/sâu/tệp' }, projects));
  assert.deepEqual(resolve({ projectKey: 'thêm' }), resolveProject({ projectKey: 'thêm' }, projects));
});

test('Lời nhắc trì hoãn giữ nguyên che bí mật, thứ tự bản ghi và metadata đoạn', () => {
  const scanner = new Scanner({});
  const entry = scanner.makeFile('tổng-hợp.jsonl', 'claude'); scanner.files.set(entry.file, entry);
  const base = Date.parse('2026-01-01T00:00:00Z');
  const texts = ['Dòng đầu token=giả\nDòng sau', 'Bearer\nchuỗi-giả\nNội dung tổng hợp', 'Lời nhắc cuối password=giả'];
  for (const [i, delta] of [0, 100, 50].entries()) scanner.line(entry, JSON.stringify({
    type: 'user', uuid: `tổng-hợp-${i}`, timestamp: new Date(base + delta).toISOString(),
    cwd: 'D:/Dự án', sessionId: 'phiên-tổng-hợp', message: { content: texts[i] },
  }));
  const [run] = scanner.runs(base + 3_600_000);
  assert.equal(run.prompt, promptPreview(texts[1]));
  assert.equal(typeof run.prompt, 'string');
  scanner.finishPrompts(entry);
  assert.equal(entry.prompt, promptPreview(texts[2]));
  assert.equal(entry.segments[0].prompt, promptPreview(texts[1]));
});

test('Đọc từng lát nhường vòng lặp trên một khối nhiều dòng, p99 dưới 100 ms và tối đa dưới 250 ms', async t => {
  const dir = await temporary(t), file = path.join(dir, 'lát.jsonl');
  const row = JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'progress' }) + '\n';
  await writeFile(file, row.repeat(500));
  const scanner = new Scanner({}), entry = scanner.makeFile(file, 'claude');
  const original = scanner.line.bind(scanner);
  scanner.line = (...args) => {
    const start = performance.now();
    while (performance.now() - start < 1) { /* Mô phỏng chi phí CPU của từng dòng. */ }
    original(...args);
  };
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    await scanner.readAppend(entry, (await stat(file)).size);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(ticks >= 10);
    assert.ok(delay.percentile(99) / 1e6 <= 100);
    assert.ok(delay.max / 1e6 <= 250);
  } finally { clearInterval(timer); delay.disable(); scanner.stop(); }
});

test('Luồng đọc và luồng chính giữ toàn bộ metadata, lệnh Codex và agy, dòng lỗi, UUID trùng và nối UTF-8', async t => {
  const dir = await temporary(t), file = path.join(dir, 'phiên.jsonl');
  const scanner = new Scanner({ claude: dir }), pool = new ScanWorkers({ claude: dir }, 2);
  t.after(async () => { scanner.stop(); await pool.stop(); });
  const base = { timestamp: '2026-01-01T00:00:00Z', cwd: 'D:/Dự án', sessionId: 'phiên-tổng-hợp' };
  const command = 'codex exec -C D:/Dự-án "Sửa dữ liệu tổng hợp"; agy.exe --model gemini-4-argon-high -p "Đọc dữ liệu tổng hợp"';
  const tool = { type: 'assistant', uuid: 'lệnh', message: { model: 'claude-opus', content: [
    { type: 'tool_use', id: 'công-cụ', name: 'Bash', input: { command } },
  ] } };
  const rows = [tool, { ...tool, cwd: 'E:/Cwd-bản-sao' },
    { type: 'user', uuid: 'kết-quả', message: { content: [
      { type: 'tool_result', tool_use_id: 'công-cụ', content: 'Đã xong', is_error: false },
    ] } },
    { type: 'user', uuid: 'lời-nhắc', message: { content: 'Lời nhắc tổng hợp token=giả' } },
    { type: 'assistant', uuid: 'văn-bản-lớn', message: { content: [{ type: 'thinking', thinking: 'Dữ liệu tổng hợp '.repeat(30_000) }] } },
    { type: 'api-request-blob', cwd: 'E:/Cwd-vẫn-giữ' },
  ];
  await writeFile(file, rows.map(row => JSON.stringify({ ...base, ...row })).join('\n') + '\n{"timestamp":lỗi}\n');
  const size = (await stat(file)).size;
  const entry = scanner.makeFile(file, 'claude');
  await scanner.readAppend(entry, size); scanner.finishPrompts(entry);
  const read = await pool.read(scanner.makeFile(file, 'claude'), size);
  assert.deepEqual(read.entry, entry);
  assert.equal(read.bytesRead, scanner.scan.bytesRead); assert.equal(read.invalidLines, 1);
  assert.deepEqual(read.entry.runs.get('công-cụ').map(run => run.lane), ['Codex', 'Argon']);
  const next = Buffer.from(JSON.stringify({ ...base, type: 'user', uuid: 'nối-thêm', message: { content: 'Thêm lời nhắc có dấu' } }) + '\n');
  const split = next.indexOf(Buffer.from('ờ')) + 1;
  await appendFile(file, next.subarray(0, split));
  await scanner.readAppend(entry, size + split);
  const first = await pool.read(read.entry, size + split);
  assert.equal(first.entry.offset, entry.offset);
  await appendFile(file, next.subarray(split));
  await scanner.readAppend(entry, size + next.length); scanner.finishPrompts(entry);
  const second = await pool.read(first.entry, size + next.length);
  assert.deepEqual(second.entry, entry);
});

test('Lượt không đổi tránh dựng lại; API vẫn cập nhật hết hạn trực tiếp và tệp bị thay thế vẫn được đọc', async t => {
  const dir = await temporary(t), claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex');
  await mkdir(claude); await mkdir(codex);
  const file = path.join(claude, 'phiên.jsonl');
  const row = { timestamp: '2026-01-01T00:00:00Z', type: 'user', message: { content: 'Dữ liệu tổng hợp' } };
  await writeFile(file, JSON.stringify(row) + '\n');
  const scanner = new Scanner({ claude, codex }); t.after(() => scanner.stop());
  await scanner.refresh(true);
  const original = scanner.rebuild.bind(scanner); let rebuilds = 0;
  scanner.rebuild = (...args) => { rebuilds++; return original(...args); };
  const bytes = scanner.scan.bytesRead;
  await scanner.refresh();
  assert.equal(rebuilds, 0); assert.equal(scanner.scan.bytesRead, bytes);
  const entry = [...scanner.files.values()][0];
  assert.equal(scanner.runs(entry.mtime + 59_999)[0].running, true);
  assert.equal(scanner.runs(entry.mtime + 60_000)[0].running, false);
  await writeFile(file, JSON.stringify({ ...row, message: { content: 'Thay thế' } }) + '\n');
  await scanner.refresh();
  assert.equal(scanner.runs()[0].prompt, 'Thay thế');
});
