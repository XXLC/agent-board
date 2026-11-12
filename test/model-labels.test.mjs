import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { modelLabel, modelFamilyLane, countModels, latestPerFamily, modelText, LANE_LABELS } from '../public/model-labels.js';
import { Scanner } from '../lib/scanner.mjs';
import { parseCommands, mergeCodex } from '../lib/parsers.mjs';
import { readCodexDefault } from '../lib/codex-config.mjs';
import { ScanWorkers } from '../lib/scan-workers.mjs';

const cases = [
  ['claude-sonnet-5-5', 'Sonnet 5.5', 'sonnet', '5.5', ''],
  ['claude-opus-5-5', 'Opus 5.5', 'opus', '5.5', ''],
  ['claude-sonnet-5', 'Sonnet 5', 'sonnet', '5', ''],
  ['claude-opus-5', 'Opus 5', 'opus', '5', ''],
  ['claude-haiku-5-5', 'Haiku 5.5', 'haiku', '5.5', ''],
  ['claude-opus-4-8', 'Opus 4.8', 'opus', '4.8', ''],
  ['claude-opus-5-5-high', 'Opus 5.5', 'opus', '5.5', 'high'],
  ['claude-sonnet-5-5-high', 'Sonnet 5.5', 'sonnet', '5.5', 'high'],
  ['claude-opus-5-5-medium', 'Opus 5.5', 'opus', '5.5', 'medium'],
  ['claude-haiku-5-5-low', 'Haiku 5.5', 'haiku', '5.5', 'low'],
  ['claude-opus-5-5-xhigh', 'Opus 5.5', 'opus', '5.5', 'xhigh'],
  ['gemini-4-argon-high', 'Gemini Argon', 'argon', '4', 'high'],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'flash', '3.5', ''],
  ['gemini-4-argon-medium', 'Gemini Argon', 'argon', '4', 'medium'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash', 'flash', '3.8', 'medium'],
  ['gemini-4-argon-low', 'Gemini Argon', 'argon', '4', 'low'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash', 'flash', '3.8', 'low'],
  ['gemini-3-pro-high', 'Gemini 3 Pro', 'pro', '3', 'high'],
  ['gemini-3-5-pro-medium', 'Gemini 3.5 Pro', 'pro', '3.5', 'medium'],
  ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt', '', ''],
  ['model-lạ-high', 'model-lạ-high', '', '', ''],
  ['', 'Chưa rõ model', '', '', ''],
];
for (const [raw, name, family, version, effort] of cases) test(`Nhãn model ${raw || 'rỗng'}`, () => {
  assert.deepEqual(modelLabel(raw), { name, family, version, effort, raw });
});

test('Làn giữ tên hiển thị riêng và chỉ cảnh báo model khác tên làn khi có model', () => {
  assert.deepEqual(LANE_LABELS, { Claude: 'Claude Code', Codex: 'Codex', Opus: 'Antigravity Claude', Argon: 'Gemini', DeepSeek: 'DeepSeek' });
  // Làn Gemini: mọi model Gemini đều đúng làn (Flash là mặc định, Argon và Carbon cũng vậy); chỉ model hãng khác mới lệch.
  for (const lane of ['Argon', LANE_LABELS.Argon]) {
    for (const id of ['gemini-4-argon-high', 'gemini-3.8-flash-high', 'gemini-3.5-flash-lite', 'gemini-4-carbon-high', 'gemini-3-pro-high', '']) {
      assert.equal(modelFamilyLane(lane, modelLabel(id)).offLabel, false, id);
    }
    assert.equal(modelFamilyLane(lane, modelLabel('claude-sonnet-5-5-high')).offLabel, true);
    assert.equal(modelFamilyLane(lane, modelLabel('gpt-6.1-sol')).offLabel, true);
  }
  // Làn Antigravity Claude: Opus, Sonnet, Haiku đều đúng làn.
  for (const lane of ['Opus', LANE_LABELS.Opus]) {
    for (const id of ['claude-opus-5-5-medium', 'claude-sonnet-5-5-high', 'claude-haiku-5-5-low']) {
      assert.equal(modelFamilyLane(lane, modelLabel(id)).offLabel, false, id);
    }
    assert.equal(modelFamilyLane(lane, modelLabel('gemini-3.8-flash-high')).offLabel, true);
  }
  assert.deepEqual(modelLabel('gemini-4-carbon-high'), { name: 'Gemini Carbon', family: 'carbon', version: '4', effort: 'high', raw: 'gemini-4-carbon-high' });
  assert.equal(modelFamilyLane('Claude', modelLabel('claude-opus-5-5')).offLabel, false);
  assert.equal(modelText({ lane: 'Codex', model: '' }), 'Chưa rõ model (lệnh không ghi -m, chưa ghép rollout)');
});

test('Rollout lấy effort ở cả hai vị trí, ưu tiên khóa trực tiếp và giữ nguyên model', () => {
  const scanner = new Scanner({});
  for (const [index, payload, expected] of [
    [1, { effort: 'high' }, 'high'],
    [2, { collaboration_mode: { settings: { reasoning_effort: 'medium' } } }, 'medium'],
    [3, { effort: 'low', collaboration_mode: { settings: { reasoning_effort: 'xhigh' } } }, 'low'],
  ]) {
    const entry = scanner.makeFile(`rollout-${index}.jsonl`, 'codex');
    scanner.files.set(entry.file, entry);
    scanner.line(entry, JSON.stringify({ type: 'turn_context', timestamp: '2026-01-01T00:00:00Z', payload: { model: 'gpt-6.1-sol', ...payload } }));
    const run = scanner.runs().find(run => run.sourceSession === entry.session);
    assert.equal(run.effort, expected); assert.equal(run.model, 'gpt-6.1-sol'); assert.equal(run.modelSource, 'rollout');
  }
});

test('Codex phân nguồn lệnh, rollout và chưa rõ, không dùng cấu hình để đoán model', () => {
  const commands = parseCommands('codex exec -m gpt-6.1-sol "Việc tổng hợp"; codex exec "Việc khác"');
  assert.equal(commands[0].modelSource, 'lệnh'); assert.equal(commands[1].modelSource, 'chưa rõ');
  const command = { ...commands[0], id: 'lệnh', start: 1000, project: 'D:/Tổng hợp', kind: 'giao việc' };
  for (const model of ['gpt-6.1-sol', '']) {
    const [run] = mergeCodex([command], [{ model, effort: 'high', start: 1001, project: command.project, sourceSession: 'rollout' }]);
    assert.equal(run.modelSource, model ? 'rollout' : 'lệnh');
  }
  const scanner = new Scanner({});
  scanner.config.codexDefault = { model: 'gpt-6.1-sol', effort: 'high' };
  const entry = scanner.makeFile('claude.jsonl', 'claude'); scanner.files.set(entry.file, entry);
  entry.runs.set('lệnh', commands.map((run, i) => ({ ...run, id: `lệnh-${i}`, source: 'claude-tool', start: i + 1000, end: i + 2000, evidence: 'Dữ liệu tổng hợp' })));
  const runs = scanner.runs();
  assert.equal(runs[1].model, ''); assert.equal(runs[1].modelSource, 'chưa rõ');
  assert.deepEqual(scanner.state().scan.statistics.codexModels, { rollout: 0, lệnh: 1, 'chưa rõ': 1 });
});

test('Tín hiệu tiến trình Codex có model khác rollout giữ đúng nguồn lệnh và không mượn effort', () => {
  const scanner = new Scanner({}), now = Date.now();
  const entry = scanner.makeFile('rollout.jsonl', 'codex'); scanner.files.set(entry.file, entry);
  Object.assign(entry, { started: now - 1000, model: 'gpt-6.1-sol', effort: 'high' });
  scanner.live = [{ lane: 'Codex', start: now - 1000, model: 'gpt-tổng-hợp', modelSource: 'lệnh', pid: 1 }];
  const [run] = scanner.runs(now);
  assert.equal(run.model, 'gpt-tổng-hợp'); assert.equal(run.modelSource, 'lệnh'); assert.equal(run.effort, '');
});

test('Thẻ Claude đếm đúng model trong 24 giờ và thẻ Codex giữ model gần nhất đã biết', () => {
  const scanner = new Scanner({}), now = Date.now();
  const claude = scanner.makeFile('claude.jsonl', 'claude'); scanner.files.set(claude.file, claude);
  claude.segments = [
    { start: now - 90_000_000, end: now - 89_000_000, model: 'claude-opus-5-5' },
    { start: now - 86_400_000, end: now - 86_000_000, model: 'claude-sonnet-5-5' },
    { start: now - 300_000, end: now - 200_000, model: 'claude-sonnet-5-5' },
    { start: now - 100_000, end: now - 90_000, model: 'claude-opus-5-5' },
  ];
  claude.runs.set('lệnh', [
    { lane: 'Codex', id: 'đã-biết', start: now - 300_000, end: now - 200_000, model: 'gpt-6.1-sol', evidence: 'Dữ liệu tổng hợp' },
    { lane: 'Codex', id: 'chưa-rõ', start: now - 100_000, end: now - 90_000, model: '', evidence: 'Dữ liệu tổng hợp' },
  ]);
  const state = scanner.state(now), card = state.lanes.find(lane => lane.lane === 'Claude');
  assert.equal(card.activity24h, 3);
  assert.deepEqual(card.models24h, { 'claude-sonnet-5-5': 2, 'claude-opus-5-5': 1 });
  assert.equal(state.lanes.find(lane => lane.lane === 'Codex').knownModel, 'gpt-6.1-sol');
  assert.deepEqual(countModels(Object.entries(card.models24h).map(([model, count]) => ({ model, count }))),
    [{ name: 'Sonnet 5.5', count: 2 }, { name: 'Opus 5.5', count: 1 }]);
});

test('Cấu hình Codex chỉ giữ hai khóa gốc, cache 60 giây, bỏ cấu hình lỗi hoặc thiếu', async t => {
  const root = path.resolve('.cache'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'model-tổng-hợp-'));
  t.after(async () => { assert.ok(dir.startsWith(root + path.sep)); await rm(dir, { recursive: true }); });
  const config = path.join(dir, 'config.toml');
  const sensitive = 'GIÁ_TRỊ_GIẢ_NHẠY_CẢM_KHÔNG_XUẤT_RA';
  await writeFile(config, `khóa_giả = "${sensitive}"\nmodel = "gpt-6.1-sol" # Cấu hình tổng hợp\nmodel_reasoning_effort = 'high'\n[profiles.khác]\nmodel = "${sensitive}"\nmodel_reasoning_effort = "${sensitive}"\n`);
  assert.deepEqual(await readCodexDefault(config), { model: 'gpt-6.1-sol', effort: 'high' });
  const claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex');
  await mkdir(claude); await mkdir(codex);
  const scanner = new Scanner({ claude, codex, codexConfig: config }); t.after(() => scanner.stop());
  await scanner.refresh(true);
  await writeFile(config, 'model = "gpt-tổng-hợp"\nmodel_reasoning_effort = "low"\n');
  await scanner.refresh();
  assert.deepEqual(scanner.state().config.codexDefault, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(JSON.stringify(scanner).includes(sensitive), false);
  assert.equal(JSON.stringify(scanner.state()).includes(sensitive), false);
  assert.equal(JSON.stringify(scanner.runs()).includes(sensitive), false);
  scanner.configReadAt -= 60_001; await scanner.refresh();
  assert.deepEqual(scanner.state().config.codexDefault, { model: 'gpt-tổng-hợp', effort: 'low' });
  await writeFile(config, 'model = "gpt-6.1-sol"\n');
  assert.equal(await readCodexDefault(config), undefined);
  assert.equal(await readCodexDefault(path.join(dir, 'không-có.toml')), undefined);
  scanner.configReadAt -= 60_001; await scanner.refresh();
  assert.equal(scanner.state().config.codexDefault, undefined);
});

test('Luồng quét giữ effort ở cả hai dạng turn_context giống luồng chính', async t => {
  const root = path.resolve('.cache'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'effort-tổng-hợp-'));
  const scanner = new Scanner({}), pool = new ScanWorkers({}, 1);
  t.after(async () => { scanner.stop(); await pool.stop(); assert.ok(dir.startsWith(root + path.sep)); await rm(dir, { recursive: true }); });
  for (const [i, payload] of [
    { effort: 'high' }, { collaboration_mode: { settings: { reasoning_effort: 'medium' } } },
  ].entries()) {
    const file = path.join(dir, `rollout-${i}.jsonl`);
    const row = JSON.stringify({ type: 'turn_context', timestamp: '2026-01-01T00:00:00Z', payload: { model: 'gpt-6.1-sol', ...payload } }) + '\n';
    await writeFile(file, row);
    const entry = scanner.makeFile(file, 'codex'); await scanner.readAppend(entry, Buffer.byteLength(row));
    const read = await pool.read(scanner.makeFile(file, 'codex'), Buffer.byteLength(row));
    assert.deepEqual(read.entry, entry);
    assert.equal(read.entry.effort, i ? 'medium' : 'high');
  }
});

test('latestPerFamily chọn phiên bản mới nhất của mỗi họ model', () => {
  assert.deepEqual(
    latestPerFamily(['claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', '', 'claude-haiku-5-5']).sort(),
    ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  );
  assert.deepEqual(latestPerFamily(['claude-opus-5', 'claude-opus-5-5']), ['claude-opus-5-5'], '5.5 mới hơn 5');
  assert.deepEqual(latestPerFamily(['claude-opus-5-5-high', 'claude-opus-5-5']).length, 1, 'cùng họ và phiên bản thì chỉ một');
  assert.deepEqual(latestPerFamily([]), []);
  assert.deepEqual(latestPerFamily(undefined), []);
  // Model không nhận ra giữ nguyên, mỗi id lạ là một họ riêng.
  assert.deepEqual(latestPerFamily(['gpt-6.1-sol']), ['gpt-6.1-sol']);
});
