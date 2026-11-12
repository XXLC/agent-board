import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { addActivity, extractCodewhaleOutput, identifier, mergeCodewhale, mergeCodex, parseCommands, promptPreview, redact, resultStatus, validHost } from '../lib/parsers.mjs';
import { Scanner } from '../lib/scanner.mjs';
import { summarizeProcesses } from '../lib/processes.mjs';
import { createBoardServer } from '../server.mjs';

test('Phân tích Codex với cờ, đường dẫn Windows và lời nhắc nguyên dòng', () => {
  const [run] = parseCommands('codex exec -s read-only -C "D:\\Dự án" --model gpt-6 "Đọc tệp D:\\việc.md và làm theo"');
  assert.equal(run.lane, 'Codex'); assert.equal(run.model, 'gpt-6'); assert.equal(run.project, 'D:\\Dự án');
  assert.equal(run.prompt, 'Đọc tệp D:\\việc.md và làm theo');
  assert.equal(parseCommands('codex.cmd exec "Sửa kiểm thử"')[0].prompt, 'Sửa kiểm thử');
});
for (const [model, lane] of [['claude-opus-5-5-high', 'Opus'], ['claude-sonnet-5-5-high', 'Opus'], ['gemini-4-argon-high', 'Argon'], ['gemini-3.8-flash-low', 'Argon']]) {
  test(`Phân làn model ${model}`, () => assert.equal(parseCommands(`& "C:\\Ứng dụng\\agy.exe" --model=${model} -p "Kiểm tra dữ liệu"`)[0].lane, lane));
}
test('Mở lớp PowerShell và không đếm tên chương trình trong văn bản', () => {
  assert.equal(parseCommands(`powershell.exe -NoProfile -Command '& "C:\\agy.exe" --model claude-opus-5-5-high -p "Sửa tài liệu"'`)[0].prompt, 'Sửa tài liệu');
  assert.deepEqual(parseCommands('echo "agy.exe --model gemini-4-argon-high -p ví dụ"'), []);
  assert.deepEqual(parseCommands('agy.exe --model không-biết -p "Kiểm tra"'), []);
  assert.deepEqual(parseCommands('codex --version'), []);
});
test('Lấy stdin từ heredoc và chuỗi PowerShell nhiều dòng', () => {
  assert.equal(parseCommands("codex exec - <<'VIEC'\nĐọc tệp D:/việc.md và làm theo\nDòng thứ hai\nVIEC")[0].prompt, 'Đọc tệp D:/việc.md và làm theo');
  assert.equal(parseCommands('@\'\nSửa báo cáo\n\'@ | agy.exe --model gemini-4-argon-high -p -')[0].prompt, 'Sửa báo cáo');
});
test('Lệnh kiểm tra vẫn được giữ và các kết quả quota được nhận diện', () => {
  assert.equal(parseCommands('agy.exe --model gemini-4-argon-high -p "pong"')[0].kind, 'kiểm tra');
  for (const text of ['quota', 'usage limit', 'rate limit', 'RESOURCE_EXHAUSTED', '429', "You've hit your usage limit"]) assert.equal(resultStatus(text), 'quota');
  assert.equal(resultStatus('Exit code: 2'), 'error'); assert.equal(resultStatus('Đã xong', false, 0), 'ok');
});
test('Hỗ trợ biến, xuống dòng, timeout, nohup và tiến trình nền có đối số riêng', () => {
  const commands = parseCommands('$agy = "C:\\Công cụ\\agy.exe"\n& $agy --model gemini-4-argon-high -p "Kiểm tra tài liệu"');
  assert.equal(commands.length, 1); assert.equal(commands[0].prompt, 'Kiểm tra tài liệu');
  assert.equal(parseCommands('cd D:/việc && timeout 120 agy.exe --model gemini-4-argon-high -p "pong"').length, 1);
  assert.equal(parseCommands('nohup agy.exe --model gemini-4-argon-high -p "pong" &').length, 1);
  assert.equal(parseCommands(`Start-Process -FilePath "agy.exe" -ArgumentList '--model gemini-4-argon-high -p "Sửa lỗi"'`)[0].background, true);
  assert.equal(parseCommands('node.exe "C:\\công cụ\\codex.js" exec "Sửa lỗi"')[0].lane, 'Codex');
});
test('Không đếm lệnh trong chú thích hoặc nội dung heredoc', () => {
  assert.deepEqual(parseCommands('# agy.exe --model gemini-4-argon-high -p "pong"'), []);
  assert.deepEqual(parseCommands("cat > việc.md <<'VIEC'\nagy.exe --model gemini-4-argon-high -p pong\nVIEC\necho xong"), []);
  const long = 'A'.repeat(32); assert.notEqual(identifier(long), identifier('B'.repeat(32))); assert.ok(!identifier(long).includes(long));
});
test('Che mẫu nhạy cảm trước khi rút gọn, không giữ dòng thứ hai', () => {
  const long = 'A'.repeat(32);
  const hidden = redact(`Bearer ${long} token=${long} sk-${long} ${long}`);
  assert.ok(!hidden.includes(long));
  assert.equal(promptPreview('\nĐọc tài liệu\nKhông hiển thị dòng này'), 'Đọc tài liệu');
  assert.equal(Array.from(promptPreview('ế'.repeat(201))).length, 200);
  assert.equal(promptPreview('a'.repeat(120) + '\nDòng khác', 120).length < 120, true);
});
test('Gộp đoạn hoạt động và xử lý bản ghi đến không đúng thứ tự', () => {
  const segments = [];
  for (const t of [0, 600_000, 1_800_001, 1_200_000]) addActivity(segments, t);
  assert.deepEqual(segments, [{ start: 0, end: 1_200_000 }, { start: 1_800_001, end: 1_800_001 }]);
  addActivity(segments, 1_800_000); assert.equal(segments.length, 1);
});
test('Ghép Codex một đối một theo dự án và cửa sổ 120 giây', () => {
  const assignments = [{
    id: 'a', lane: 'Codex', start: 1000, project: 'D:\\Dự án', projectKey: 'slug-claude', prompt: 'Sửa lỗi', status: 'unknown',
  }];
  const rollouts = [{ id: 'b', lane: 'Codex', start: 2000, end: 5000, project: 'd:/Dự án', model: 'gpt-6', sourceSession: 'phiên', status: 'ok', kind: 'giao việc' }];
  const result = mergeCodex(assignments, rollouts); assert.equal(result.length, 1); assert.equal(result[0].start, 2000); assert.equal(result[0].model, 'gpt-6'); assert.ok(result[0].merged);
  assert.equal(result[0].projectKey, 'slug-claude');
  assert.equal(mergeCodex(assignments, [{ ...rollouts[0], kind: 'tương tác' }]).length, 2);
  assert.equal(mergeCodex(assignments, [{ ...rollouts[0], start: 122_000 }]).length, 2);
  assert.equal(mergeCodex(assignments, [rollouts[0], { ...rollouts[0], id: 'c' }]).length, 2);
});
test('Tín hiệu tiến trình được rút gọn và khử trùng', () => {
  const processes = [{ Name: 'agy.exe', ProcessId: 100, CreationDate: '2026-11-07T00:00:00Z', CommandLine: 'agy.exe --model gemini-4-argon-high -p "Đọc tệp và làm theo"' }];
  const result = summarizeProcesses(processes);
  assert.equal(result.length, 1); assert.equal(result[0].prompt, 'Đọc tệp và làm theo'); assert.ok(!('CommandLine' in result[0]));
  assert.equal(summarizeProcesses([...processes, { ...processes[0], ProcessId: 101 }]).length, 2);
});
test('Host chỉ chấp nhận loopback và đúng cổng', () => {
  for (const host of ['127.0.0.1:8090', 'localhost:8090']) assert.ok(validHost(host));
  for (const host of [undefined, 'evil.test:8090', '127.0.0.1', 'localhost:8091', 'localhost:8090.evil.test']) assert.ok(!validHost(host));
  assert.ok(validHost('localhost:8123', 8123));
});

test('Quét tăng dần, nền, khử bản sao và phần UTF-8 nối thêm', async () => {
  const root = path.resolve(fileURLToPath(new URL('../.cache', import.meta.url))); await mkdir(root, { recursive: true });
  const temp = await mkdtemp(path.join(root, 'kiểm-thử-'));
  const claude = path.join(temp, 'claude'), codex = path.join(temp, 'codex'), agy = path.join(temp, 'agy');
  await Promise.all([claude, codex, agy].map(p => mkdir(p)));
  const session = '00000000-0000-0000-0000-000000000001';
  const base = { sessionId: session, cwd: 'D:/Dự án', timestamp: '2026-11-07T00:00:00Z' };
  const tool = { type: 'tool_use', id: 'tác-vụ-1', name: 'Bash', input: { command: 'agy.exe --model gemini-4-argon-high -p "Đọc hướng dẫn"', run_in_background: true } };
  const records = [
    { ...base, uuid: 'bản-1', type: 'assistant', message: { model: 'claude-opus', content: [tool] } },
    { ...base, type: 'api-request-blob', message: { content: [tool] } },
    { ...base, uuid: 'bản-1', type: 'assistant', message: { content: [tool] } },
    { ...base, uuid: 'bản-2', type: 'user', toolUseResult: { backgroundTaskId: 'nền-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tác-vụ-1', content: 'Command running in background' }] } },
    { ...base, timestamp: '2026-11-07T00:02:00Z', uuid: 'bản-3', type: 'user', message: { content: [{ type: 'text', text: '<task-notification><task-id>nền-1</task-id><status>completed</status><summary>Đã xong, exit code 0</summary></task-notification>' }] } },
  ];
  const file = path.join(claude, 'phiên.jsonl'); await writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(path.join(agy, 'cli.log'), '');
  const scanner = new Scanner({ claude, codex, agy });
  try {
    await scanner.refresh(true);
    let runs = scanner.runs(Date.parse('2026-11-08T00:00:00Z')).filter(r => r.lane === 'Argon');
    assert.equal(runs.length, 1); assert.equal(runs[0].status, 'ok'); assert.equal(runs[0].end, Date.parse('2026-11-07T00:02:00Z'));
    const bytes = scanner.scan.bytesRead; await scanner.refresh(); assert.equal(scanner.scan.bytesRead, bytes);
    const next = JSON.stringify({ ...base, uuid: 'bản-4', timestamp: '2026-11-07T01:00:00Z', type: 'user', message: { content: 'Lời nhắc có dấu' } });
    const encoded = Buffer.from(next + '\n'), split = encoded.indexOf(Buffer.from('ờ')) + 1;
    await appendFile(file, encoded.subarray(0, split)); await scanner.refresh();
    await appendFile(file, encoded.subarray(split)); await scanner.refresh();
    assert.equal(scanner.runs(Date.parse('2026-11-08T00:00:00Z')).filter(r => r.lane === 'Claude').length, 2);
    await writeFile(file, JSON.stringify(records[0]) + '\n'); await scanner.refresh();
    assert.equal(scanner.runs(Date.parse('2026-11-08T00:00:00Z')).filter(r => r.lane === 'Claude').length, 1);
  } finally { scanner.stop(); assert.ok(temp.startsWith(root + path.sep)); await rm(temp, { recursive: true }); }
});

test('Rollout Codex nhận model, hoàn tất, quota và phiên tương tác tiếp tục', () => {
  const scanner = new Scanner({});
  const entry = scanner.makeFile('rollout-kiểm-thử.jsonl', 'codex'); scanner.files.set(entry.file, entry);
  const started = Date.parse('2026-11-07T00:00:00Z'); entry.mtime = started + 60_000;
  const line = (type, payload, delta = 0) => scanner.line(entry, JSON.stringify({ timestamp: new Date(started + delta).toISOString(), type, payload }));
  line('session_meta', { id: 'phiên-tổng-hợp', originator: 'codex_exec', cwd: 'D:/Dự án' });
  line('turn_context', { model: 'gpt-6', cwd: 'D:/Dự án' });
  line('event_msg', { type: 'task_started' });
  line('event_msg', { type: 'user_message', message: 'Sửa kiểm thử\nDòng thứ hai' });
  assert.equal(scanner.runs(started + 60_000)[0].running, true);
  line('event_msg', { type: 'task_complete', last_agent_message: 'usage limit' }, 50_000);
  let run = scanner.runs(started + 60_000)[0];
  assert.equal(run.running, false); assert.equal(run.model, 'gpt-6'); assert.equal(run.status, 'quota'); assert.equal(run.end, started + 50_000); assert.equal(run.prompt, 'Sửa kiểm thử');
  entry.originator = 'codex_cli';
  line('event_msg', { type: 'task_started' }, 55_000);
  run = scanner.runs(started + 60_000)[0]; assert.equal(run.kind, 'tương tác'); assert.equal(run.running, true);
  assert.equal(scanner.runs(started + 200_000)[0].running, false);
});

test('Trường type ở cuối bản ghi lớn vẫn được xử lý, lời nhắc thay đổi theo đoạn', () => {
  const scanner = new Scanner({}); const entry = scanner.makeFile('phiên-tổng-hợp.jsonl', 'claude'); scanner.files.set(entry.file, entry);
  const record = { timestamp: '2026-11-07T00:00:00Z', sessionId: 'phiên-tổng-hợp', cwd: 'D:/Dự án', message: { content: 'Đọc tài liệu\n' + 'ữ'.repeat(6000) }, uuid: 'bản-1', type: 'user' };
  scanner.line(entry, JSON.stringify(record));
  scanner.line(entry, JSON.stringify({ ...record, timestamp: '2026-11-07T01:00:00Z', uuid: 'bản-2', message: { content: 'Sửa mã' } }));
  const runs = scanner.runs(Date.parse('2026-11-08T00:00:00Z'));
  assert.equal(runs.length, 2); assert.equal(runs[0].prompt, 'Đọc tài liệu'); assert.equal(runs[1].prompt, 'Sửa mã');
});

test('Codex đọc giây Unix của started_at và completed_at, vẫn nhận ISO và mili giây', () => {
  const base = Date.parse('2026-11-07T00:00:00Z');
  for (const encode of [value => value / 1000, value => value, value => new Date(value).toISOString()]) {
    const scanner = new Scanner({}), entry = scanner.makeFile('rollout-tổng-hợp.jsonl', 'codex');
    scanner.files.set(entry.file, entry);
    scanner.line(entry, JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'session_meta', payload: { id: 'phiên-tổng-hợp' } }));
    scanner.line(entry, JSON.stringify({ timestamp: new Date(base).toISOString(), type: 'event_msg', payload: { type: 'task_started', started_at: encode(base) } }));
    scanner.line(entry, JSON.stringify({ timestamp: new Date(base + 120_000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', completed_at: encode(base + 120_000) } }));
    const [run] = scanner.runs(base + 180_000);
    assert.equal(entry.latestStarted, base);
    assert.equal(run.end, base + 120_000); assert.equal(run.timeAdjusted, false);
  }
});

test('Dữ liệu API chặn tương lai, kết thúc ngược và giữ end null cho thanh đang chạy', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const scanner = new Scanner({}), entry = scanner.makeFile('phiên-tổng-hợp.jsonl', 'claude');
  scanner.files.set(entry.file, entry);
  entry.runs.set('công-cụ', [
    { id: 'tương-lai', lane: 'Opus', source: 'claude-tool', start: now + 60_000, end: now + 120_000, evidence: 'Dữ liệu tổng hợp.' },
    { id: 'ngược', lane: 'Argon', source: 'claude-tool', start: now - 60_000, end: now - 120_000, evidence: 'Dữ liệu tổng hợp.' },
    { id: 'hợp-lệ', lane: 'Codex', source: 'claude-tool', start: now - 60_000, end: now - 30_000, evidence: 'Dữ liệu tổng hợp.' },
  ]);
  const codex = scanner.makeFile('rollout-tổng-hợp.jsonl', 'codex'); scanner.files.set(codex.file, codex);
  Object.assign(codex, { started: now - 60_000, latestComplete: now + 60_000, ended: now + 60_000 });
  scanner.live = [{ pid: 123, lane: 'Codex', start: now + 300_000, model: 'gpt-6', prompt: '' }];
  const runs = scanner.runs(now);
  assert.ok(runs.every(r => r.start <= now && (r.end == null || r.end <= now && r.end >= r.start)));
  assert.equal(runs.find(r => r.id === 'tương-lai').end, now);
  assert.equal(runs.find(r => r.id === 'ngược').end, now - 60_000);
  assert.equal(runs.find(r => r.id === 'hợp-lệ').timeAdjusted, false);
  assert.ok(runs.filter(r => r.id !== 'hợp-lệ').every(r => r.timeAdjusted));
  assert.equal(runs.find(r => r.source === 'process').end, null);
  const state = scanner.state(now);
  assert.ok(state.lanes.every(lane => lane.start == null || lane.start <= now));
});

test('HTTP từ chối Host lạ, giữ CSP và phục vụ SSE', async () => {
  const scanner = new Scanner({});
  const server = createBoardServer(scanner); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const request = (url, host) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: url, headers: { Host: host } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; if (url === '/events' && body.includes('event: state')) { resolve({ status: res.statusCode, headers: res.headers, body }); req.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject);
  });
  try {
    assert.equal((await request('/api/state', 'ngoài.test:8090')).status, 403);
    const response = await request('/api/state', 'localhost:8090');
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).lanes.length, 5); assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(response.headers['content-security-policy'].includes("script-src 'self'")); assert.ok(!response.headers['access-control-allow-origin']);
    assert.equal((await request('/api/runs?from=sai', 'localhost:8090')).status, 400);
    assert.equal((await request('/', 'localhost:8090')).status, 200);
    for (const asset of ['/app.js', '/activity.js', '/model-labels.js', '/mindmap.js', '/mindmap-layout.js']) {
      const resource = await request(asset, 'localhost:8090');
      assert.equal(resource.status, 200);
      assert.equal(resource.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal((await request(asset, 'ngoài.test:8090')).status, 403);
    }
    const sse = await request('/events', 'localhost:8090'); assert.equal(sse.status, 200); assert.ok(sse.headers['content-type'].includes('text/event-stream')); assert.ok(sse.body.includes('"lanes"'));
  } finally { server.stopEvents(); await new Promise(resolve => server.close(resolve)); }
});
