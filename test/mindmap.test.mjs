import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutMindmap, leafRadius, shortenLabel, labelRadius } from '../public/mindmap-layout.js';

const now = 1_793_577_600_000;
function samples(count, projects = 12) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tổng-hợp-${i}`, lane: ['Codex', 'Opus', 'Argon'][i % 3], kind: 'giao việc',
    projectKey: `dự-án-${Math.floor(i / 3) % projects}`, projectLabel: `Dự án tổng hợp ${Math.floor(i / 3) % projects}`,
    start: now - i * 60_000, end: i % 11 ? now - i * 60_000 + 1000 : null,
    running: i % 11 === 0, status: 'unknown',
  }));
}
export function collisions(nodes) {
  const pairs = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + 4 - 1e-7) pairs.push([a.id, b.id]);
  }
  return pairs;
}
for (const count of [6, 120, 500]) test(`Bố cục ${count} lần giao không chồng nút và các cung liền nhau`, () => {
  const runs = samples(count);
  const layout = layoutMindmap(runs, { now });
  assert.deepEqual(collisions(layout.nodes), []);
  for (let i = 0; i < layout.arcs.length; i++) {
    const arc = layout.arcs[i];
    assert.ok(arc.end - arc.start >= 70 * Math.PI / 180 - 1e-8);
    if (i) assert.equal(arc.start, layout.arcs[i - 1].end);
  }
  assert.ok(Math.abs(layout.arcs.at(-1).end - layout.arcs[0].start - Math.PI * 2) < 1e-8);
  const expanded = layout.nodes.filter(node => node.type === 'project' || node.type === 'lane').map(node => node.id);
  const full = layoutMindmap(runs, { now, expanded: [...expanded, ...runs.map(run => `project:${run.lane}:${run.projectKey}`)] });
  assert.equal(full.nodes.filter(node => node.type === 'run').length, count);
  assert.deepEqual(collisions(full.nodes), []);
});

test('Giới hạn tám dự án, mười lá; nút gộp mở được và thu gọn được', () => {
  const runs = samples(500);
  const layout = layoutMindmap(runs, { now });
  for (const lane of ['Codex', 'Opus', 'Argon']) {
    assert.equal(layout.nodes.filter(node => node.type === 'project' && node.lane === lane).length, 8);
    assert.ok(layout.nodes.some(node => node.id === `more:lane:${lane}` && node.label === '+4 dự án'));
  }
  for (const project of layout.nodes.filter(node => node.type === 'project')) {
    assert.equal(layout.nodes.filter(node => node.type === 'run' && node.parent === project.id).length, 10);
    assert.ok(layout.nodes.some(node => node.id === `more:${project.id}`));
    assert.ok(Array.from(project.label).length * 8 <= 126);
  }
  const expanded = layoutMindmap(runs, { now, expanded: ['lane:Codex', 'project:Codex:dự-án-0'] });
  assert.equal(expanded.nodes.filter(node => node.type === 'project' && node.lane === 'Codex').length, 12);
  assert.ok(expanded.nodes.filter(node => node.type === 'run' && node.parent === 'project:Codex:dự-án-0').length > 10);
  const collapsed = layoutMindmap(runs, { now, collapsed: ['lane:Codex', 'project:Opus:dự-án-0'] });
  assert.ok(!collapsed.nodes.some(node => node.parent === 'lane:Codex' || node.parent === 'project:Opus:dự-án-0'));
});

test('Thêm lần giao và tăng thời lượng giữ nguyên vị trí nút cũ, dữ liệu đầu vào không đổi', () => {
  const runs = samples(120), snapshot = structuredClone(runs);
  const first = layoutMindmap(runs, { now });
  const next = layoutMindmap([...runs, { ...runs[0], id: 'mới', start: now + 1000 }], { now: now + 86_400_000, previous: first });
  for (const node of next.nodes) {
    const old = first.nodes.find(item => item.id === node.id);
    if (old) assert.ok(Math.hypot(old.x - node.x, old.y - node.y) < .001);
  }
  assert.deepEqual(collisions(next.nodes), []);
  assert.deepEqual(runs, snapshot);
});

test('Làn trống, phiên Claude, end null và thang kích thước có giới hạn', () => {
  const empty = layoutMindmap([], { now });
  assert.equal(empty.nodes.length, 4);
  assert.equal(empty.count, 0);
  assert.ok(empty.nodes.filter(node => node.type === 'lane').every(node => node.count === 0));
  const layout = layoutMindmap([
    ...samples(1), { lane: 'Claude', sourceSession: 'phiên' }, { lane: 'Claude', sourceSession: 'phiên' },
  ], { now });
  assert.equal(layout.nodes[0].subtitle, 'Chưa rõ model x 2');
  assert.equal(leafRadius({ start: now, end: now }, now), 7);
  assert.equal(leafRadius({ start: now - 86_400_000, end: null }, now), 18);
  assert.equal(leafRadius({ start: now - 1e12, end: null }, now), 18);
  assert.ok(leafRadius({ start: now - 600_000, end: null }, now) > leafRadius({ start: now - 60_000, end: null }, now));
  assert.ok(shortenLabel('Nhãn dự án rất dài '.repeat(10)).endsWith('...'));
});

test('Cung làn chia theo căn bậc hai và cạnh dày có giới hạn', () => {
  const runs = samples(300).map((run, i) => ({ ...run, lane: i < 225 ? 'Codex' : 'Opus' }));
  const layout = layoutMindmap(runs, { now });
  const minimum = 70 * Math.PI / 180;
  const extra = layout.arcs.map(arc => arc.end - arc.start - minimum);
  assert.ok(Math.abs(extra[0] / extra[1] - Math.sqrt(225 / 75)) < 1e-8);
  assert.ok(Math.abs(extra[2]) < 1e-8);
  const edges = layout.edges.filter(edge => edge.from === 'root');
  assert.equal(edges[0].width, 10);
  assert.equal(edges[2].width, 2);
  assert.equal(edges[0].running, true);
});

test('Nhãn làn dài, model lá và nhiều dòng tóm tắt Claude không chồng nhau, kể cả khi cập nhật', () => {
  const runs = samples(120).map((run, i) => ({ ...run,
    model: ['gpt-6.1-sol', 'claude-sonnet-5-5-high', 'gemini-3.5-flash-lite'][i % 3], effort: i % 3 ? '' : 'high',
  }));
  const claude = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-5'];
  const first = layoutMindmap(runs, { now });
  const next = layoutMindmap([...runs, ...claude.map((model, i) => ({ lane: 'Claude', id: `claude-${i}`, model }))], { now, previous: first });
  for (const layout of [first, next]) {
    assert.deepEqual(collisions(layout.nodes.map(node => ({ ...node, r: node.reserve }))), []);
    assert.ok(layout.nodes.every(node => node.reserve >= labelRadius(node)));
  }
  assert.equal(next.nodes.find(node => node.id === 'lane:Opus').label, 'Antigravity Opus');
  assert.equal(next.nodes.find(node => node.id === 'lane:Argon').label, 'Gemini Argon');
  assert.equal(next.nodes[0].subtitleLines.length, 5);
});

test('Nút gốc (Claude) đang làm khi có đoạn Claude đang chạy dù chưa giao việc cho ai', () => {
  const idle = layoutMindmap([{ lane: 'Claude', id: 'xong', model: 'claude-sonnet-5-5', running: false, start: now - 9000, end: now - 5000 }], { now });
  assert.equal(idle.nodes.find(node => node.id === 'root').running, 0);
  assert.equal(idle.nodes.find(node => node.id === 'root').phase, 'nghỉ');
  const busy = layoutMindmap([{ lane: 'Claude', id: 'chạy', model: 'claude-sonnet-5-5', running: true, start: now - 9000, end: null }], { now });
  const root = busy.nodes.find(node => node.id === 'root');
  assert.equal(root.running, 1);
  assert.equal(root.phase, 'làm');
  assert.equal(root.delegating, false, 'Claude tự làm việc không phải là đang giao');
  // Run giao việc cho Codex đang chạy không được đếm trùng với đoạn Claude.
  const both = layoutMindmap([
    { lane: 'Claude', id: 'chạy', model: 'claude-sonnet-5-5', running: true, start: now - 9000, end: null },
    { lane: 'Codex', id: 'codex', kind: 'giao việc', running: true, projectKey: 'a', projectLabel: 'A', start: now - 60_000, end: null },
  ], { now });
  assert.equal(both.nodes.find(node => node.id === 'root').running, 2);
});

test('Nút gốc liệt kê cả model Claude đã dùng gần đây nhưng chưa có đoạn nào trong khung (số 0)', () => {
  const runs = [{ lane: 'Claude', id: 'a', model: 'claude-sonnet-5-5', sourceSession: 's', start: now - 9000, end: now - 5000 }];
  const withKnown = layoutMindmap(runs, { now, claudeModels: ['claude-sonnet-5-5', 'claude-opus-5-5', '', 'claude-opus-5-5'] });
  const lines = withKnown.nodes.find(node => node.id === 'root').subtitleLines;
  assert.deepEqual(lines, ['Sonnet 5.5 x 1', 'Opus 5.5 x 0']);
  const without = layoutMindmap(runs, { now });
  assert.deepEqual(without.nodes.find(node => node.id === 'root').subtitleLines, ['Sonnet 5.5 x 1']);
  // Model đã có đoạn trong khung không bị liệt kê hai lần.
  const dup = layoutMindmap(runs, { now, claudeModels: ['claude-sonnet-5-5'] });
  assert.deepEqual(dup.nodes.find(node => node.id === 'root').subtitleLines, ['Sonnet 5.5 x 1']);
});
