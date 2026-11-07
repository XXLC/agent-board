import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../lib/scanner.mjs';
import { executionDirectory, projectCatalog, resolveCrossProject, resolveProject, scratchpadSession } from '../lib/projects.mjs';

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

test('Giao chéo dự án nhận diện đúng chéo, cùng dự án, thư mục con, thư mục tạm và ngoài Claude', async t => {
  const cache = path.resolve('.cache'); await mkdir(cache, { recursive: true });
  const outsideDir = await mkdtemp(path.join(cache, 'ngoài-Claude-chéo-'));
  t.after(async () => { assert.ok(outsideDir.startsWith(cache + path.sep)); await rm(outsideDir, { recursive: true }); });
  const catalog = [
    { projectKey: 'd--Workspace-DuAn-A', projectPath: 'D:/Workspace/DuAn_A', projectLabel: 'DuAn_A' },
    { projectKey: 'd--Workspace-DuAn-B', projectPath: 'D:/Workspace/DuAn_B', projectLabel: 'DuAn_B' },
  ];
  const baseA = {
    projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A',
    projectPath: 'D:/Workspace/DuAn_A', outsideClaude: false,
  };
  const crossAgy = resolveCrossProject({
    ...baseA, lane: 'Argon', source: 'agy-db', claudeSession: 'phiên-a', workspace: 'D:/Workspace/DuAn_B/gói-con',
  }, catalog);
  assert.deepEqual(crossAgy, {
    crossProject: true,
    eligible: true,
    workProjectKey: 'd--Workspace-DuAn-B',
    workProjectLabel: 'DuAn_B',
    workProjectPath: 'D:/Workspace/DuAn_B',
    workProjectOutsideClaude: false,
  });
  const crossOutside = resolveCrossProject({
    ...baseA, lane: 'Codex', source: 'codex-rollout', claudeSession: 'phiên-a', project: outsideDir,
  }, catalog);
  assert.equal(crossOutside.crossProject, true);
  assert.equal(crossOutside.workProjectOutsideClaude, true);
  assert.equal(crossOutside.workProjectLabel, path.basename(outsideDir));
  for (const sameOrInvalid of [
    { ...baseA, lane: 'Opus', source: 'agy-db', workspace: 'D:/Workspace/DuAn_A/thư-mục-con' },
    { ...baseA, lane: 'Codex', source: 'codex-rollout', project: 'C:/Users/nguoidung/AppData/Local/Temp/claude/scratchpad' },
    { ...baseA, lane: 'Codex', source: 'codex-rollout', project: path.join(os.homedir(), '.claude').replace(/\\/g, '/') },
    { ...baseA, lane: 'Argon', source: 'agy-db', workspace: 'D:/Không-tồn-tại/DuAn_Lạ' },
    { ...baseA, lane: 'Argon', source: 'claude-tool', project: 'D:/Workspace/DuAn_B', commandProject: '' },
    {
      projectKey: 'd--Workspace-DuAn-B', projectLabel: 'DuAn_B', projectPath: 'D:/Workspace/DuAn_B',
      lane: 'Argon', source: 'agy-db', workspace: 'D:/Workspace/DuAn_B/con',
    },
  ]) {
    const result = resolveCrossProject(sameOrInvalid, catalog);
    assert.equal(result.crossProject, false);
    assert.equal('workProjectKey' in result, false);
    assert.equal('workProjectLabel' in result, false);
    assert.equal('workProjectPath' in result, false);
    assert.equal('workProjectOutsideClaude' in result, false);
  }
  assert.equal(executionDirectory({ source: 'claude-tool', project: 'D:/Workspace/DuAn_B', commandProject: '' }), '');
  assert.equal(executionDirectory({ source: 'claude-tool', commandProject: 'D:/Workspace/DuAn_B' }), 'D:/Workspace/DuAn_B');
});

test('Scanner gắn trường giao chéo dự án cho runs, state và thống kê mà không đổi trường dự án gốc', async t => {
  const cache = path.resolve('.cache'); await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'quét-giao-chéo-'));
  t.after(async () => { assert.ok(root.startsWith(cache + path.sep)); await rm(root, { recursive: true }); });
  const projects = path.join(root, 'projects'), codex = path.join(root, 'codex');
  await mkdir(path.join(projects, 'd--Workspace-DuAn-A'), { recursive: true });
  await mkdir(path.join(projects, 'd--Workspace-DuAn-B'), { recursive: true });
  await mkdir(codex, { recursive: true });
  await writeFile(path.join(projects, 'd--Workspace-DuAn-B', 'b.jsonl'), JSON.stringify({
    type: 'user', cwd: 'D:/Workspace/DuAn_B', sessionId: 'phiên-b', timestamp: '2026-11-07T00:00:00Z',
    message: { content: 'Khởi tạo DuAn_B tổng hợp' },
  }) + '\n');
  await writeFile(path.join(projects, 'd--Workspace-DuAn-A', 'a.jsonl'), [
    {
      type: 'assistant', cwd: 'D:/Workspace/DuAn_A', sessionId: 'phiên-a', timestamp: '2026-11-07T00:01:00Z',
      message: { content: [{ type: 'tool_use', id: 'giao-chéo', name: 'Bash', input: {
        command: 'codex exec -C D:/Workspace/DuAn_B "Kiểm tra chéo tổng hợp"',
      } }] },
    },
    {
      type: 'assistant', cwd: 'D:/Workspace/DuAn_B', sessionId: 'phiên-a', timestamp: '2026-11-07T00:02:00Z',
      message: { content: [{ type: 'tool_use', id: 'không-cờ-c', name: 'Bash', input: {
        command: 'agy chat -m gemini-4-argon-high --mode agent --print "Chạy không cờ C tổng hợp"',
      } }] },
    },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const scanner = new Scanner({ claude: projects, codex });
  t.after(() => scanner.stop());
  await scanner.refresh(true);
  const runs = scanner.runs(0, Date.now() + 86400_000);
  const crossRun = runs.find(run => run.lane === 'Codex');
  assert.equal(crossRun.projectKey, 'd--Workspace-DuAn-A');
  assert.equal(crossRun.projectLabel, 'DuAn_A');
  assert.equal(crossRun.crossProject, true);
  assert.equal(crossRun.workProjectKey, 'd--Workspace-DuAn-B');
  assert.equal(crossRun.workProjectLabel, 'DuAn_B');
  assert.equal(crossRun.workProjectPath, 'D:/Workspace/DuAn_B');
  assert.equal(crossRun.workProjectOutsideClaude, false);
  assert.equal('commandProject' in crossRun, false);
  assert.equal('eligible' in crossRun, false);
  const noFlagRun = runs.find(run => run.lane === 'Argon');
  assert.equal(noFlagRun.crossProject, false);
  assert.equal('workProjectKey' in noFlagRun, false);
  const state = scanner.state();
  const codexLane = state.lanes.find(lane => lane.lane === 'Codex');
  assert.equal(codexLane.crossProject, true);
  assert.equal(codexLane.workProjectLabel, 'DuAn_B');
  const argonLane = state.lanes.find(lane => lane.lane === 'Argon');
  assert.equal(argonLane.crossProject, false);
  assert.equal('workProjectLabel' in argonLane, false);
  assert.deepEqual(state.scan.statistics.crossProjects, { count: 1, total: 1 });
});
