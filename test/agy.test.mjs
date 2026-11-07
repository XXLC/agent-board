import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, writeFile, rm, stat, utimes, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgySource, extractModel, extractPrompt, extractTimes, extractWorkspace, filterTimes, mergeAgy } from '../lib/agy.mjs';
import { Scanner } from '../lib/scanner.mjs';
import { mergeCodex } from '../lib/parsers.mjs';

const base = 1_793_577_600_000;
function integer(value) {
  const out = [];
  do { out.push(value % 128 | (value >= 128 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(out);
}
const field = (value, tag = 10) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), integer(bytes.length), bytes]);
};
const timestamp = time => Buffer.concat([Buffer.from([8]), integer(Math.floor(time / 1000))]);
async function temporary(t) {
  const root = path.resolve('.cache');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'agy-tổng-hợp-'));
  t.after(async () => { assert.ok(dir.startsWith(root + path.sep)); await rm(dir, { recursive: true }); });
  return dir;
}
function database(file, options = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT);
    CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);`);
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(options.id || path.basename(file));
  if (options.workspaceBlob) {
    db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)');
    db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?)').run(options.workspaceBlob);
  }
  const model = options.model ?? 'claude-opus-5-5-high';
  const data = Buffer.concat([field('claude-bridge-setup.md'), field('MODEL_PLACEHOLDER_M417'), field(model)]);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, data, data.length);
  const steps = options.steps || [
    { time: base, type: 14, status: 3, text: 'Kiểm tra tài liệu tổng hợp' },
    { time: base + 30_000, type: 15, status: options.status ?? 3 },
  ];
  const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
  steps.forEach((step, i) => insert.run(i, step.type, step.status,
    step.metadata ?? Buffer.concat([field(timestamp(step.time)), field(options.fallback || 'gemini-4-argon-high')]), field(step.text || '')));
  db.close();
}

test('Model agy phải khớp chặt, bỏ tên tệp và placeholder gây nhiễu', () => {
  for (const model of ['claude-opus-5-5-high', 'claude-haiku-5', 'claude-sonnet-5-5-high',
    'gemini-4-argon-high', 'gemini-3.8-flash-low', 'gemini-3-pro-high']) {
    assert.equal(extractModel(Buffer.concat([field('claude-bridge-setup.md'), field(model)])), model);
  }
  for (const model of ['claude-bridge-setup.md', 'MODEL_PLACEHOLDER_M417', 'claude-opus',
    'gemini-4-unknown', 'tien-claude-opus-5-high']) {
    assert.equal(extractModel(field(model)), '');
  }
});

test('Chỉ lấy Timestamp ở trường đầu, bỏ số giả ở tương lai và quá khứ trong blob', () => {
  const blob = Buffer.concat([field(timestamp(base)), field(timestamp(base - 100 * 86_400_000)),
    timestamp(base + 365 * 86_400_000), field(timestamp(base + 60_000))]);
  assert.deepEqual(extractTimes(blob, base + 60_000), [base]);
  assert.deepEqual(extractTimes(field(timestamp(base + 61_000)), base + 60_000), []);
  assert.deepEqual(extractTimes(timestamp(base), base), []);
  assert.deepEqual(extractTimes(field(Buffer.from([8, 255])), base), []);
  assert.deepEqual(extractTimes(Buffer.from([10, 255]), base), []);
  assert.deepEqual(extractTimes(field(Buffer.concat([timestamp(base), Buffer.from([16]), integer(999_999_999)])), base), [base]);
  assert.deepEqual(extractTimes(field(Buffer.concat([timestamp(base), Buffer.from([16]), integer(1e9)])), base), []);
});

test('Lọc trần trước trung vị, bỏ ngoại lai quá 3 ngày và không đoán khi trống', () => {
  const day = 86_400_000;
  assert.deepEqual(filterTimes([base - 100 * day, base, base + 1000, base + 2000, base + 100 * day], base + 60_000),
    [base, base + 1000, base + 2000]);
  assert.deepEqual(filterTimes([base, base + 10 * day], base + 20 * day), []);
  assert.deepEqual(filterTimes([base + 1000], base), []);
  assert.deepEqual(filterTimes([], base), []);
  assert.deepEqual(filterTimes([base - 3 * day, base, base, base + 3 * day], base + 3 * day),
    [base - 3 * day, base, base, base + 3 * day]);
});

test('Lời nhắc agy chỉ lấy văn bản protobuf rõ ràng, che và cắt trước khi lưu', () => {
  assert.equal(extractPrompt(field(field('Sửa tài liệu tổng hợp có dấu'))), 'Sửa tài liệu tổng hợp có dấu');
  assert.equal(extractPrompt(Buffer.from('Đây là văn bản không có cấu trúc protobuf')), '');
  assert.equal(extractPrompt(Buffer.from([10, 200, 255])), '');
  assert.equal(extractPrompt(Buffer.concat([field('Sửa tài liệu tổng hợp'), field('Đọc tài liệu tổng hợp')])), '');
  const preview = extractPrompt(field('Kiểm tra token=bí-mật-tổng-hợp ' + 'dữ liệu '.repeat(100)));
  assert.ok(!preview.includes('bí-mật-tổng-hợp'));
  assert.ok(Array.from(preview).length <= 200);
});

test('Thư mục agy từ trường độ dài metadata, bỏ byte thẻ z và đường dẫn trong lời nhắc nhiễu', () => {
  const workspace = 'D:/Workspace/Tổng-hợp/Dự-án';
  const blob = Buffer.concat([
    field('C:/Nhiễu'), field(`Chỉ dẫn tổng hợp có nhắc D:/Nhiễu/hệ-thống nhưng không phải cwd`),
    field(Buffer.concat([field(workspace), field('file:///D:/Workspace/T%E1%BB%95ng-h%E1%BB%A3p/D%E1%BB%B1-%C3%A1n', 122)])),
    field('https://không-truy-cập.invalid'),
  ]);
  assert.equal(extractWorkspace(blob), workspace);
  // 0x7a là thẻ protobuf tiếp theo, không thuộc chuỗi đường dẫn phía trước.
  assert.equal(extractWorkspace(Buffer.concat([field(workspace), field('nhiễu', 122)])), workspace);
  assert.equal(extractWorkspace(field('D:/Dự án có dấu')), 'D:/Dự án có dấu');
  assert.equal(extractWorkspace(field('file:///workspace/D%E1%BB%B1-%C3%A1n')), '/workspace/Dự-án');
  assert.equal(extractWorkspace(field('Chỉ dẫn nhắc D:/Workspace/Tổng-hợp')), '');
  assert.equal(extractWorkspace(Buffer.from('D:/Workspace/byte-thô')), '');
  assert.equal(extractWorkspace(Buffer.from([10, 255])), '');
  assert.equal(extractWorkspace(field('D:/Tổng-hợp\nNội dung hội thoại tổng hợp')), '');
});

test('Worker đọc workspace cùng metadata bằng SQLite chỉ đọc, scanner suy đúng dự án', async t => {
  const dir = await temporary(t), agy = path.join(dir, 'agy'), conversations = path.join(agy, 'conversations');
  const claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex');
  await mkdir(conversations, { recursive: true }); await mkdir(claude); await mkdir(codex);
  const workspace = 'D:/Workspace/Tổng-hợp';
  const slug = 'd--Workspace-T-ng-h-p', project = path.join(claude, slug); await mkdir(project);
  await writeFile(path.join(project, 'phiên.jsonl'), JSON.stringify({ type: 'user', cwd: workspace,
    timestamp: new Date(base).toISOString(), message: { content: 'Dữ liệu tổng hợp' } }) + '\n');
  const file = path.join(conversations, 'workspace.db');
  database(file, { workspaceBlob: field(field(workspace)) });
  const before = await readFile(file), info = await stat(file);
  const scanner = new Scanner({ claude, codex, agy }); t.after(() => scanner.stop());
  await scanner.refresh(true);
  const run = scanner.runs().find(run => run.source === 'agy-db');
  assert.equal(run.workspace, workspace); assert.equal(run.projectKey, slug);
  assert.equal(run.unknownReason, undefined);
  assert.deepEqual(await readFile(file), before); assert.equal((await stat(file)).mtimeMs, info.mtimeMs);
});

test('SQLite chỉ đọc, ưu tiên gen_metadata, lấy min/max mọi bước và cache không đổi', async t => {
  const dir = await temporary(t), file = path.join(dir, 'phiên.db');
  database(file, { steps: [
    { time: base + 2000, type: 14, status: 3, text: 'Sửa dữ liệu tổng hợp' },
    { time: base, type: 15, status: 3 }, { time: base + 8000, type: 132, status: 7 },
  ] });
  const before = await readFile(file), info = await stat(file);
  const source = new AgySource(dir); t.after(() => source.stop());
  await source.refresh();
  const [run] = source.runs(base + 86_400_000);
  assert.equal(run.model, 'claude-opus-5-5-high'); assert.equal(run.lane, 'Opus');
  assert.equal(run.start, base); assert.equal(run.end, base + 8000); assert.equal(run.lastStatus, 7);
  assert.equal(run.status, 'unknown'); assert.equal(run.source, 'agy-db');
  assert.equal(run.prompt, 'Sửa dữ liệu tổng hợp');
  assert.deepEqual(await readFile(file), before); assert.equal((await stat(file)).mtimeMs, info.mtimeMs);
  assert.equal(source.statistics.parsedFiles, 1);
  await source.refresh(); assert.equal(source.statistics.parsedFiles, 0);
  assert.equal(source.statistics.conversationsRead, 1);
  await utimes(file, info.atime, new Date(info.mtimeMs + 1000));
  await source.refresh(); assert.equal(source.statistics.parsedFiles, 1);
});

test('Cache agy nhận thay đổi chỉ trong WAL và tính lại khi quá 90 giây', async t => {
  const dir = await temporary(t), file = path.join(dir, 'wal.db'); database(file, { status: 2 });
  const writer = new DatabaseSync(file); writer.exec('PRAGMA journal_mode = WAL');
  const source = new AgySource(dir);
  t.after(() => source.stop());
  try {
    await source.refresh();
    assert.equal(source.runs(Date.now())[0].running, true);
    assert.equal(source.runs(Date.now() + 91_000)[0].running, false);
    writer.prepare('UPDATE steps SET status = 3, metadata = ? WHERE idx = 1').run(field(timestamp(base + 60_000)));
    await source.refresh(); assert.equal(source.statistics.parsedFiles, 1);
    const [run] = source.runs(); assert.equal(run.running, false); assert.equal(run.end, base + 60_000);
    await source.refresh(); assert.equal(source.statistics.parsedFiles, 0);
    const walInfo = await stat(file + '-wal');
    await utimes(file + '-wal', walInfo.atime, new Date(walInfo.mtimeMs + 1000));
    await source.refresh(); assert.equal(source.statistics.parsedFiles, 1);
  } finally { writer.close(); }
});

test('Fallback metadata, model sai, tệp hỏng và cơ sở dữ liệu đang khóa không làm văng lượt quét', async t => {
  const dir = await temporary(t);
  database(path.join(dir, 'dự-phòng.db'), { model: 'MODEL_PLACEHOLDER_M417', fallback: 'gemini-4-argon-high' });
  database(path.join(dir, 'model-sai.db'), { model: 'claude-bridge-setup.md', fallback: 'không-rõ' });
  const locked = path.join(dir, 'khóa.db'); database(locked);
  const writer = new DatabaseSync(locked); writer.exec('BEGIN EXCLUSIVE');
  const source = new AgySource(dir); t.after(() => source.stop());
  try {
    await writeFile(path.join(dir, 'hỏng.db'), 'Dữ liệu tổng hợp không phải SQLite');
    await source.refresh();
    assert.equal(source.statistics.errors, 2); assert.equal(source.statistics.skipped, 1);
    assert.equal(source.statistics.conversationsRead, 1); assert.equal(source.runs()[0].lane, 'Argon');
    writer.exec('ROLLBACK'); await source.refresh();
    assert.equal(source.statistics.errors, 1); assert.equal(source.statistics.conversationsRead, 2);
    await rm(path.join(dir, 'dự-phòng.db')); await source.refresh();
    assert.equal(source.statistics.conversationsRead, 1);
  } finally { writer.close(); }
});

test('Không lấy lời nhắc assistant và không đoán khi bước người dùng đầu tiên không rõ', async t => {
  const dir = await temporary(t);
  database(path.join(dir, 'trống.db'), { steps: [
    { time: base, type: 14, status: 3 },
    { time: base + 1000, type: 15, status: 3, text: 'Đây là câu trả lời tổng hợp' },
    { time: base + 2000, type: 14, status: 3, text: 'Lời nhắc tổng hợp ở lần sau' },
  ] });
  const source = new AgySource(dir); t.after(() => source.stop()); await source.refresh();
  assert.equal(source.runs()[0].prompt, '');
});

test('Hội thoại không còn mốc sau lọc bị bỏ khỏi biểu đồ và tăng skipped', async t => {
  const dir = await temporary(t), file = path.join(dir, 'không-có-giờ.db');
  database(file, { steps: [
    { time: base, type: 14, status: 3 },
    { time: base + 10 * 86_400_000, type: 15, status: 3 },
  ] });
  await utimes(file, new Date(base + 20 * 86_400_000), new Date(base + 20 * 86_400_000));
  const source = new AgySource(dir); t.after(() => source.stop());
  await source.refresh();
  assert.equal(source.statistics.skipped, 1); assert.equal(source.statistics.errors, 0);
  assert.deepEqual(source.runs(), []);
});

test('Trần mtime dùng cả DB và WAL, giữ biên 60 giây và bỏ mốc vượt biên', async t => {
  const dir = await temporary(t), file = path.join(dir, 'trần.db');
  database(file, { steps: [
    { time: base + 60_000, type: 14, status: 3 },
    { time: base + 61_000, type: 15, status: 3 },
  ] });
  await utimes(file, new Date(base), new Date(base));
  const source = new AgySource(dir); t.after(() => source.stop());
  await source.refresh();
  assert.equal(source.runs(base + 200_000)[0].end, base + 60_000);
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA journal_mode = WAL');
    writer.prepare('UPDATE steps SET metadata = ? WHERE idx = 1').run(field(timestamp(base + 80_000)));
    await utimes(file, new Date(base), new Date(base));
    await utimes(file + '-wal', new Date(base + 20_000), new Date(base + 20_000));
    await source.refresh();
    assert.equal(source.runs(base + 200_000)[0].end, base + 80_000);
  } finally { writer.close(); }
});

test('Ghép agy một đối một, cặp gần nhất trước; giữ dự án và lời nhắc Claude', () => {
  const model = 'claude-opus-5-5-high';
  const assignments = [0, 20_000].map((start, i) => ({
    id: `lệnh-${i}`, lane: 'Opus', source: 'claude-tool', sourceSession: 'claude-tổng-hợp',
    start: base + start, model, prompt: 'Lời nhắc từ lệnh tổng hợp', project: 'D:/Dự án', projectKey: 'slug-claude',
    kind: 'giao việc', status: 'ok', endEstimated: true, endRaw: base + 3 * 86_400_000,
  }));
  const conversations = [19_000, 21_000, 300_000].map((start, i) => ({
    id: `agy-${i}`, sourceSession: `phiên-${i}`, source: 'agy-db', lane: 'Opus', model,
    start: base + start, end: base + start + 5000, status: 'unknown', lastStatus: 3,
    endEstimated: false, prompt: 'Lời nhắc từ DB tổng hợp', project: '',
  }));
  const comparison = {}, result = mergeAgy(assignments, conversations, comparison);
  assert.equal(result.length, 3); assert.equal(result.filter(r => r.agySession).length, 2);
  assert.equal(result.find(r => r.id === 'lệnh-1').agySession, 'phiên-0');
  const merged = result.find(r => r.id === 'lệnh-0');
  assert.equal(merged.projectKey, 'slug-claude');
  assert.equal(merged.project, 'D:/Dự án'); assert.equal(merged.prompt, assignments[0].prompt);
  assert.equal(merged.start, conversations[1].start); assert.equal(merged.end, conversations[1].end);
  assert.equal(merged.endEstimated, false); assert.equal(merged.endRaw, undefined);
  assert.equal(merged.status, 'unknown'); assert.match(merged.evidence, /ghép với hội thoại agy/);
  assert.equal(result.find(r => r.id === 'agy-2').source, 'agy-db'); assert.equal(comparison['3'].ok, 2);
  assert.equal(mergeAgy(assignments, [{ ...conversations[0], model: 'claude-sonnet-5' }]).length, 3);
  assert.equal(mergeAgy(assignments, [{ ...conversations[0], lane: 'Argon' }]).length, 3);
  const orphaned = mergeAgy(assignments, [{ ...conversations[0], start: base + 140_001 }]);
  assert.equal(orphaned.length, 3); assert.equal(orphaned.filter(r => r.source === 'claude-tool').length, 2);
  const boundary = mergeAgy([assignments[0]], [{ ...conversations[0], start: base + 120_000 }]);
  assert.equal(boundary.length, 1);
});

test('Scanner tích hợp agy độc lập, ghép lệnh và thống kê cảnh báo', async t => {
  const dir = await temporary(t), agy = path.join(dir, 'agy');
  await mkdir(path.join(agy, 'conversations'), { recursive: true });
  await mkdir(path.join(dir, 'claude')); await mkdir(path.join(dir, 'codex'));
  database(path.join(agy, 'conversations', 'ghép.db'));
  database(path.join(agy, 'conversations', 'độc-lập.db'), { model: 'gemini-4-argon-high' });
  const scanner = new Scanner({ claude: path.join(dir, 'claude'), codex: path.join(dir, 'codex'), agy });
  t.after(() => scanner.stop());
  const record = {
    type: 'assistant', timestamp: new Date(base).toISOString(), sessionId: 'phiên-tổng-hợp', cwd: 'D:/Dự án',
    message: { content: [{ type: 'tool_use', name: 'Bash', id: 'công-cụ', input: {
      command: 'agy.exe --model claude-opus-5-5-high -p "Lời nhắc Claude tổng hợp"',
    } }] },
  };
  await writeFile(path.join(dir, 'claude', 'phiên.jsonl'), JSON.stringify(record) + '\n');
  await scanner.refresh(true);
  const runs = scanner.runs(base + 86_400_000);
  assert.equal(runs.filter(r => r.lane === 'Opus').length, 1);
  assert.equal(runs.find(r => r.lane === 'Opus').prompt, 'Lời nhắc Claude tổng hợp');
  const standalone = runs.find(r => r.lane === 'Argon');
  assert.equal(standalone.source, 'agy-db'); assert.match(standalone.evidence, /không rõ nguồn giao/);
  const state = scanner.state(); assert.equal(state.scan.agy.conversationsRead, 2); assert.equal(state.scan.agy.merged, 1);
  assert.equal(state.scan.agy.errors, 0); assert.equal(state.scan.agy.skipped, 0);
});

test('Ước lượng kết thúc giới hạn 60 phút trong API dữ liệu, giữ mốc thô và ưu tiên rollout', () => {
  const scanner = new Scanner({});
  const entry = scanner.makeFile('phiên-tổng-hợp.jsonl', 'claude'); scanner.files.set(entry.file, entry);
  entry.last = base + 3 * 86_400_000;
  entry.runs.set('công-cụ', [{ id: 'lệnh', lane: 'Codex', source: 'claude-tool', start: base,
    end: null, project: 'D:/Dự án', status: 'unknown', evidence: 'Chưa rõ', prompt: 'Sửa lỗi tổng hợp' }]);
  const [run] = scanner.runs(base + 4 * 86_400_000);
  assert.equal(run.endEstimated, true); assert.equal(run.end, base + 3600_000); assert.equal(run.endRaw, entry.last);
  const [merged] = mergeCodex([run], [{ id: 'rollout', lane: 'Codex', sourceSession: 'phiên-rollout',
    start: base + 1000, end: base + 7200_000, project: 'D:/Dự án', kind: 'giao việc', status: 'ok' }]);
  assert.equal(merged.end, base + 7200_000); assert.equal(merged.endEstimated, false); assert.equal(merged.endRaw, undefined);
});

test('Rollout chưa hoàn tất giới hạn ước lượng, rollout hoàn tất giữ nguyên thời lượng dài', () => {
  const scanner = new Scanner({}), entry = scanner.makeFile('rollout-tổng-hợp.jsonl', 'codex');
  scanner.files.set(entry.file, entry);
  Object.assign(entry, { started: base, last: base + 3 * 86_400_000, mtime: base, originator: 'codex_exec' });
  let [run] = scanner.runs(base + 4 * 86_400_000);
  assert.equal(run.endEstimated, true); assert.equal(run.end, base + 3600_000); assert.equal(run.endRaw, entry.last);
  entry.latestComplete = entry.ended = base + 7200_000;
  [run] = scanner.runs(base + 4 * 86_400_000);
  assert.equal(run.endEstimated, false); assert.equal(run.end, entry.ended); assert.equal(run.endRaw, undefined);
});

test('Làm mới agy chồng nhau dùng chung một lần chạy và không đếm đôi', async t => {
  const dir = await temporary(t);
  database(path.join(dir, 'một.db')); database(path.join(dir, 'hai.db'));
  const source = new AgySource(dir); t.after(() => source.stop());
  const first = source.refresh(), second = source.refresh();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(source.statistics.conversationsRead, 2);
  assert.equal(source.running, null);
  await source.refresh(); assert.equal(source.statistics.parsedFiles, 0);
});

test('Tệp biến khỏi đệm khi luồng đọc đang chạy không làm văng lượt quét', async t => {
  const dir = await temporary(t);
  for (let i = 0; i < 20; i++) database(path.join(dir, `phiên-${i}.db`));
  const source = new AgySource(dir); t.after(() => source.stop());
  const original = source.cache.get.bind(source.cache);
  // Mô phỏng cuộc đua cũ: mọi mục đệm bị xóa ngay khi luồng đọc bắt đầu trả kết quả.
  let cleared = false;
  source.cache.get = key => {
    if (new Error().stack.includes('Worker.<anonymous>') && !cleared) { cleared = true; source.cache.clear(); }
    return original(key);
  };
  await assert.doesNotReject(source.refresh());
  assert.ok(cleared, 'Cuộc đua giả lập phải thực sự xảy ra.');
});

test('Tập SQLite lớn đọc song song giữ thứ tự nguồn, fallback, tổng số và lượt không đổi', async t => {
  const dir = await temporary(t);
  for (let i = 0; i < 40; i++) database(path.join(dir, `phiên-${String(i).padStart(2, '0')}.db`),
    { id: `tổng-hợp-${i}`, model: i % 2 ? '' : 'claude-opus-5-5-high' });
  const source = new AgySource(dir); t.after(() => source.stop());
  await source.refresh();
  assert.equal(source.statistics.conversationsRead, 40);
  assert.equal(source.statistics.errors, 0); assert.equal(source.workers.size, 0);
  const runs = source.runs(base + 86_400_000);
  assert.deepEqual(runs.map(run => run.id), Array.from({ length: 40 }, (_, i) => `agy:tổng-hợp-${i}`));
  assert.ok(runs.every((run, i) => run.model === (i % 2 ? 'gemini-4-argon-high' : 'claude-opus-5-5-high')));
  await source.refresh();
  assert.equal(source.statistics.parsedFiles, 0);
  assert.deepEqual(source.runs(base + 86_400_000), runs);
});

test('Đọc lát Uint8Array không sao chép vẫn giữ đúng offset và không sửa blob nguồn', () => {
  for (const [blob, extract] of [
    [field('claude-opus-5-5-high'), extractModel],
    [field(timestamp(base)), value => extractTimes(value, base)],
    [field('Lời nhắc tổng hợp có dấu'), extractPrompt],
    [field('D:/Dự án tổng hợp'), extractWorkspace],
  ]) {
    const buffer = Buffer.concat([Buffer.from('nhiễu'), blob, Buffer.from('nhiễu')]);
    const before = Buffer.from(buffer);
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset + Buffer.byteLength('nhiễu'), blob.length);
    assert.deepEqual(extract(view), extract(blob)); assert.deepEqual(buffer, before);
  }
});
