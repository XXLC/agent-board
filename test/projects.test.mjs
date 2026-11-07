import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../lib/scanner.mjs';
import { projectCatalog, resolveProject, scratchpadSession } from '../lib/projects.mjs';

test('Projects tổng hợp suy gốc từ nhiều phiên, trùng nhãn và khớp tiền tố dài nhất', async t => {
  const cache = path.resolve('.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'dự-án-tổng-hợp-'));
  t.after(async () => { assert.ok(root.startsWith(cache + path.sep)); await rm(root, { recursive: true }); });
  const projects = path.join(root, 'projects'), codex = path.join(root, 'codex');
  await mkdir(codex, { recursive: true });
  const definitions = [
    ['d--Workspace-NhomA-DuAn-B', ['D:/Workspace/NhomA/DuAn_B/k8s', 'D:/Workspace/NhomA/DuAn_B']],
    ['d--Workspace-NhomB-DuAn-B', ['D:/Workspace/NhomB/DuAn_B']],
    ['d--Workspace-NhomA-DuAn-B-con', ['D:/Workspace/NhomA/DuAn_B/con']],
  ];
  for (const [slug, cwds] of definitions) {
    const dir = path.join(projects, slug);
    await mkdir(dir, { recursive: true });
    for (const [index, cwd] of cwds.entries()) await writeFile(path.join(dir, `${index}.jsonl`), JSON.stringify({
      type: 'assistant', cwd, sessionId: `${slug}-${index}`, timestamp: '2026-11-07T00:00:00Z',
      message: { content: [{ type: 'tool_use', id: 'việc', name: 'Bash', input: {
        command: 'codex exec -C D:/Khác "Sửa dữ liệu tổng hợp"',
      } }] },
    }) + '\n');
  }
  for (const [id, cwd] of [['khớp', 'D:/Workspace/NhomA/DuAn_B/con/tệp'], ['lạ', 'E:/Ngoài']]) {
    await writeFile(path.join(codex, `rollout-${id}.jsonl`), JSON.stringify({
      type: 'session_meta', timestamp: '2026-11-07T00:00:00Z',
      payload: { id, cwd, originator: 'codex_exec' },
    }) + '\n');
  }
  const scanner = new Scanner({ claude: projects, codex });
  t.after(() => scanner.stop());
  await scanner.refresh(true);
  const catalog = projectCatalog(scanner.files.values());
  const first = catalog.find(project => project.projectKey === definitions[0][0]);
  assert.equal(first.projectPath, 'D:/Workspace/NhomA/DuAn_B');
  assert.equal(first.projectLabel, 'NhomA/DuAn_B');
  assert.equal(catalog.find(project => project.projectKey === definitions[1][0]).projectLabel, 'NhomB/DuAn_B');
  assert.equal(resolveProject({ project: 'd:\\workspace\\nhoma\\duan_b\\con\\thêm' }, catalog).projectKey, definitions[2][0]);
  for (const run of [
    { source: 'agy-db', project: '' }, { source: 'codex-rollout', project: 'D:/Workspace/NhomA/DuAn_B-khác' },
  ]) assert.equal(resolveProject(run, catalog).projectLabel, 'Không rõ dự án');
  const runs = scanner.runs();
  assert.equal(runs.find(run => run.id === 'codex:khớp').projectKey, definitions[2][0]);
  assert.equal(runs.find(run => run.id === 'codex:lạ').projectLabel, 'Không rõ dự án');
  assert.ok(runs.every(run => run.projectKey && run.projectLabel && typeof run.projectPath === 'string'));
  assert.ok(runs.filter(run => run.source === 'claude-tool').every(run => run.projectKey.startsWith('d--Workspace')));
  assert.ok(scanner.state().lanes.every(lane => lane.projectKey && lane.projectLabel && typeof lane.projectPath === 'string'));
});

test('Cwd không có gốc quan sát chung không tự dựng đường dẫn từ slug', () => {
  const catalog = projectCatalog([{ source: 'claude', projectKey: 'slug', cwds: ['D:/Một', 'E:/Hai'] }]);
  assert.equal(catalog[0].projectPath, '');
  assert.equal(resolveProject({ project: 'D:/Một/con' }, catalog).projectKey, '(không rõ)');
  assert.equal(resolveProject({ projectKey: 'slug' }, catalog).projectKey, 'slug');
});

test('Gốc project khớp slug dù cwd lang thang ra ngoài và không còn là tiền tố chung', () => {
  const entries = [{
    source: 'claude', projectKey: 'd--Workspace-Nhom-Mau-DuAn-A',
    cwds: [
      'D:/Workspace/Nhom/Mau/DuAn_A',
      'D:/Workspace/Nhom/Mau/DuAn_B/ha_tang',
      'C:/Users/nguoidung/AppData/Local/Temp',
    ],
  }, {
    // Không có cwd khớp slug: giữ cách cũ (tiền tố chung ngắn nhất).
    source: 'claude', projectKey: 'd--Programs-KhongKhop', cwds: ['D:/Programs/Goc/con', 'D:/Programs/Goc'],
  }, {
    source: 'claude', projectKey: 'd--Programs-LangThang', cwds: ['E:/Khac', 'F:/Nua'],
  }];
  const [onehealth, fallback, lost] = projectCatalog(entries);
  assert.equal(onehealth.projectPath, 'D:/Workspace/Nhom/Mau/DuAn_A');
  assert.equal(onehealth.projectLabel, 'DuAn_A');
  assert.equal(fallback.projectPath, 'D:/Programs/Goc');
  assert.equal(lost.projectPath, ''); assert.equal(lost.projectLabel, 'd--Programs-LangThang');
});

test('Cwd scratchpad suy phiên Claude từ chỉ mục tên tệp trước khi che đường dẫn', () => {
  const session = '12345678-1234-5678-abcd-123456789abc';
  const cwd = `C:/Users/Tổng-hợp/AppData/Local/Temp/claude/hash/${session}/scratchpad`;
  assert.equal(scratchpadSession(cwd), session);
  assert.equal(scratchpadSession(cwd.replaceAll('/', String.fromCharCode(92))), session);
  assert.equal(scratchpadSession(cwd.replace(session, 'không-phải-uuid')), '');
  const scanner = new Scanner({ claude: 'D:/Tổng-hợp/projects' });
  const claude = scanner.makeFile(`D:/Tổng-hợp/projects/d--Workspace-Du-an/${session}.jsonl`, 'claude');
  claude.cwds.add('D:/Workspace/Du-an'); scanner.files.set(claude.file, claude);
  const codex = scanner.makeFile('rollout-tổng-hợp.jsonl', 'codex'); scanner.files.set(codex.file, codex);
  scanner.line(codex, JSON.stringify({ type: 'session_meta', timestamp: '2026-11-07T00:00:00Z',
    payload: { id: 'codex-tổng-hợp', cwd, originator: 'codex_exec' } }));
  const run = scanner.runs().find(run => run.lane === 'Codex');
  assert.ok(!codex.project.includes(session));
  assert.equal(run.claudeSession, session); assert.equal(run.projectKey, claude.projectKey);
  assert.equal(run.projectLabel, 'Du-an'); assert.equal(run.unknownReason, undefined);
  claude.runs.set('việc', [{ id: 'việc', source: 'claude-tool', sourceSession: session, lane: 'Codex',
    start: codex.started, end: null, evidence: 'Dữ liệu tổng hợp', project: 'D:/Workspace/Du-an',
    model: '', prompt: 'Lời nhắc truyền qua stdin, không còn trong lệnh', promptSource: 'không có' }]);
  codex.model = 'gpt-6'; codex.prompt = 'Lời nhắc rollout tổng hợp';
  const merged = scanner.runs().filter(run => run.lane === 'Codex');
  assert.equal(merged.length, 1); assert.equal(merged[0].rolloutSession, codex.session);
  assert.equal(merged[0].model, 'gpt-6'); assert.equal(merged[0].promptSource, 'rollout');
  assert.equal(merged[0].projectKey, claude.projectKey); assert.equal(merged[0].outsideClaude, false);
});

test('Dự án ngoài Claude chỉ tạo từ thư mục thật, giữ tiền tố Claude dài nhất và lý do cố định', async t => {
  const cache = path.resolve('.cache'); await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, 'ngoài-Claude-tổng-hợp-'));
  t.after(async () => { assert.ok(dir.startsWith(cache + path.sep)); await rm(dir, { recursive: true }); });
  const outside = resolveProject({ source: 'agy-db', workspace: dir }, []);
  assert.equal(outside.outsideClaude, true); assert.equal(outside.projectLabel, path.basename(dir));
  assert.equal(outside.projectPath, dir.replaceAll(String.fromCharCode(92), '/'));
  assert.equal(outside.projectKey, 'ngoài-claude:' + outside.projectPath.toLowerCase());
  assert.equal(resolveProject({ source: 'codex-rollout', project: dir }, []).projectKey, outside.projectKey);
  assert.equal(resolveProject({ project: dir + '/../' + path.basename(dir) }, []).projectKey, outside.projectKey);
  const known = [{ projectKey: 'Claude', projectPath: dir, projectLabel: 'Gốc tổng hợp' }];
  assert.equal(resolveProject({ source: 'agy-db', workspace: dir + '/con' }, known).projectKey, 'Claude');
  assert.equal(resolveProject({ source: 'agy-db', workspace: dir, projectKey: 'Claude' }, known).projectKey, 'Claude');
  const merged = resolveProject({ source: 'codex-rollout', projectKey: 'Claude', outsideClaude: true,
    unknownReason: 'Lý do cũ tổng hợp', project: dir }, known);
  assert.equal(merged.outsideClaude, false); assert.equal(merged.unknownReason, undefined);
  assert.equal(resolveProject({ source: 'agy-db' }, []).unknownReason, 'agy: hội thoại không có thư mục làm việc đọc được');
  assert.equal(resolveProject({ source: 'codex-rollout' }, []).unknownReason, 'Codex: không ghi thư mục làm việc');
  assert.equal(resolveProject({ source: 'codex-rollout', project: 'C:/Temp/claude/không-rõ/scratchpad' }, []).unknownReason,
    'Codex: chạy ở thư mục tạm không rõ phiên Claude');
  assert.equal(resolveProject({ source: 'codex-rollout', project: path.join(os.homedir(), '.claude').replace(/\\/g, '/') }, []).unknownReason,
    'cwd không khớp thư mục nào');
  assert.equal(resolveProject({ source: 'agy-db', workspace: dir + '/không-tồn-tại' }, []).unknownReason,
    'cwd không khớp thư mục nào');
  const file = path.join(dir, 'tệp.txt'); await writeFile(file, 'Dữ liệu tổng hợp');
  assert.equal(resolveProject({ project: file }, []).projectKey, '(không rõ)');
});
