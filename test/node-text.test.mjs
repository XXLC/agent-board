import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutMindmap, nodeTextRows, nodeRadius, textWidth, NODE_FONTS } from '../public/mindmap-layout.js';
import { formatDuration } from '../public/counters.js';

const now = 1_793_577_600_000;
const hour = 3600_000;
const run = (id, extra = {}) => ({
  id, lane: 'Codex', kind: 'giao việc', projectKey: 'dự-án', projectLabel: 'Dự án tổng hợp',
  start: now - 3 * hour, end: now - hour, running: false, tokens: { total: 2_000_000 }, ...extra,
});

function assertInside(rows, radius) {
  for (const row of rows) {
    const edge = Math.max(Math.abs(row.top), Math.abs(row.bottom));
    assert.ok(edge + 6 <= radius + 1e-8, `Dòng ${row.kind} vượt lề dọc của bán kính ${radius}`);
    const chord = Math.sqrt(radius ** 2 - edge ** 2);
    assert.ok(row.width / 2 + 6 <= chord + 1e-8, `Dòng ${row.kind} vượt dây cung của bán kính ${radius}`);
  }
}

test('Gốc, làn và lá không có dòng chữ pha kể cả khi dự trữ, đang giao hoặc đang làm', () => {
  for (const type of ['root', 'lane', 'run']) for (const phase of ['giao', 'làm']) for (const reserve of [false, true]) {
    const rows = nodeTextRows({ type, label: 'Nhãn tổng hợp', subtitle: 'Phụ đề tổng hợp', r: 18,
      running: 1, phase, elapsedText: '42 giây' }, { reserve });
    assert.ok(rows.every(row => row.kind !== 'phase'));
    assert.ok(rows.every(row => !/đang (?:làm|giao)/i.test(row.text)));
    if (type === 'run') assert.deepEqual(rows.map(row => row.kind), ['label', 'subtitle']);
  }
});

test('Bán kính gốc và làn chỉ dự trữ một dòng sống, đủ mọi định dạng đồng hồ dưới 100 giờ', () => {
  const durations = [0, 42_000, 59_999, 60_000, 425_000, 3_599_999, 3_600_000, 3_780_000, 100 * hour - 1];
  for (const type of ['root', 'lane']) {
    const node = { type, label: 'Nhãn tổng hợp', subtitle: 'Phụ đề tổng hợp', counterText: '1 giờ · 2,0 triệu token' };
    const reserved = nodeTextRows(node, { reserve: true });
    const withoutLive = nodeTextRows(node, { reserve: true, includeLive: false });
    assert.equal(reserved.length - withoutLive.length, 1, 'Chỉ dự trữ một dòng sống');
    assert.equal(reserved.at(-1).kind, 'elapsed');
    const width = Math.max(...durations.map(ms => textWidth(formatDuration(ms), type === 'root' ? 18 : 15)));
    assert.equal(reserved.at(-1).width, width, 'Không dự trữ thêm tiền tố hay chữ pha');
    const radius = nodeRadius(reserved, 64);
    const idle = nodeTextRows({ ...node, running: 0, elapsedText: '42 giây' });
    assert.equal(idle.length, reserved.length);
    assert.equal(idle.at(-1).text, '', 'Khi nghỉ giữ ô đồng hồ trống');
    assertInside(idle, radius);
    for (const ms of [...durations, 1e15]) {
      const running = { ...node, running: 1, elapsedText: formatDuration(ms) };
      const rows = nodeTextRows(running);
      assert.equal(rows.at(-1).text, formatDuration(ms));
      assertInside(rows, radius);
      assert.equal(nodeRadius(nodeTextRows(running, { reserve: true }), 64), radius);
    }
  }
});

for (const type of ['root', 'lane']) {
  for (let count = 1; count <= (type === 'root' ? 7 : 5); count++) {
    for (const counterText of ['', '3 giờ · 179,6 triệu token']) {
      test(`Khối chữ ${type === 'root' ? 'gốc' : 'làn'}, ${count} phụ đề, ${counterText ? 'có' : 'không có'} bộ đếm vừa lề 6`, () => {
        const node = { type, label: type === 'root' ? 'Claude Code' : 'Codex',
          subtitleLines: Array.from({ length: count }, (_, i) => `Model tổng hợp ${i + 1} x 12`),
          counterText, running: 1, phase: 'làm', elapsedText: '10 phút 0 giây' };
        const base = type === 'root' ? 70 : 64;
        const reserved = nodeTextRows(node, { reserve: true });
        const radius = nodeRadius(reserved, base);
        const rows = nodeTextRows(node);
        assertInside(reserved, radius);
        assertInside(rows, radius);
        const limit = type === 'root' ? 3 : 1;
        const shown = count > limit ? limit + 1 : count;
        assert.equal(rows.length, shown + 3);
        assert.deepEqual(rows.map(row => row.kind), ['label', ...Array(shown).fill('subtitle'), 'counter', 'elapsed']);
        assert.ok(Math.abs(rows[0].top + rows.at(-1).bottom) < 1e-8, 'Khối chữ hiển thị phải căn giữa');
        for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i].top - rows[i - 1].bottom - 3) < 1e-8);
        if (radius > base) assert.ok(reserved.some(row => {
          const edge = Math.max(Math.abs(row.top), Math.abs(row.bottom));
          return Math.hypot(row.width / 2 + 6, edge) > radius - 1e-6 || edge + 6 > radius - 1e-6;
        }), 'Bán kính phải là số nhỏ nhất theo các hộp đã dự trữ');
      });
    }
  }
}

test('Bán kính ổn định từ nghỉ sang giao, làm, đổi đồng hồ và số liệu; khối chữ luôn căn giữa', () => {
  for (const type of ['root', 'lane']) {
    const node = { type, label: 'Nút tổng hợp', subtitleLines: ['12 lần giao, 2 chạy'], counterText: '1 giờ · 23,0 triệu token' };
    const variants = [
      { running: 0, elapsedText: '' },
      { running: 1, phase: 'giao', elapsedText: '9 phút 0 giây' },
      { running: 1, phase: 'làm', elapsedText: '10 phút 0 giây' },
      { running: 1, phase: 'làm', elapsedText: '99 giờ 59 phút', counterText: '30 giờ · 999,9 triệu token' },
      { running: 1, phase: 'làm', elapsedText: '59 phút 59 giây', subtitleLines: ['999 lần giao, 999 chạy'] },
    ].map(value => ({ ...node, ...value }));
    const reserved = value => nodeTextRows(value, { reserve: true });
    const radii = variants.map(value => nodeRadius(reserved(value), type === 'root' ? 70 : 64));
    assert.ok(radii.every(radius => radius === radii[0]));
    const positions = value => nodeTextRows(value).map(({ kind, y }) => [kind, y]);
    for (const value of variants) {
      const rows = nodeTextRows(value);
      assert.ok(Math.abs(rows[0].top + rows.at(-1).bottom) < 1e-8);
      assertInside(rows, radii[0]);
    }
    assert.deepEqual(positions(variants[0]), positions(variants[1]));
    assert.deepEqual(positions(variants[1]), positions(variants[2]));
    assert.ok(nodeRadius(reserved({ ...node, subtitleLines: ['Một', 'Hai'] }), 70) > radii[0]);
  }
});

test('Nút gốc và làn dùng cỡ chữ riêng theo thứ bậc và cỡ chữ phụ theo thứ bậc', () => {
  for (let count = 1; count <= 3; count++) {
    const node = { label: 'Nhãn tổng hợp', subtitleLines: Array(count).fill('Phụ đề tổng hợp'),
      counterText: '1 giờ · 23,0 triệu token', running: 1, phase: 'làm', elapsedText: '11 phút 0 giây' };
    for (const type of ['root', 'lane']) {
      const rows = nodeTextRows({ ...node, type });
      assert.equal(rows[0].fontSize, NODE_FONTS[type]);
      assert.equal(rows[0].width, Math.min(textWidth(node.label, NODE_FONTS[type]), type === 'lane' ? 210 : Infinity));
      assert.ok(rows.slice(1).every(row => row.fontSize === (type === 'root' ? 18 : 15)));
    }
  }
});

test('Bán kính thực chứa ca gốc nhiều model và làn từng bị tràn sau khi bớt một dòng pha', () => {
  const layout = layoutMindmap([run('làn', { running: true, end: null }), run('gốc', {
    lane: 'Claude', model: 'claude-sonnet-5-5', running: true, end: null,
  })], { now, claudeModels: ['claude-opus-5-5'] });
  for (const id of ['root', 'lane:Codex']) {
    const node = layout.nodes.find(node => node.id === id);
    const rows = nodeTextRows(node, { elapsedText: id === 'root' ? '18 phút 0 giây' : '11 phút 0 giây' });
    assert.equal(rows.length, id === 'root' ? 5 : 4);
    assertInside(rows, node.r);
    assertInside(nodeTextRows(node, { reserve: true }), node.r);
    assert.ok(node.r > (id === 'root' ? 70 : 64));
  }
});

test('Dự án cộng token và hợp khoảng chồng nhau, cắt đúng khoảng đang chọn', () => {
  const runs = [run('một'), run('hai', { start: now - 2 * hour, end: now, tokens: { total: 2_100_000 } }),
    run('thiếu token', { start: now - 2 * hour, end: now - hour, tokens: null })];
  const project = range => layoutMindmap(runs, { now, range }).nodes.find(node => node.type === 'project');
  const full = project();
  assert.equal(full.busyMs, 3 * hour);
  assert.equal(full.tokens.total, 4_100_000);
  assert.equal(full.counterText, '3 giờ · 4,1 triệu token');
  assert.match(full.counterDescription, /thời gian chạy 3 giờ 0 phút, token 4,1 triệu \(2\/3 lần giao có số liệu\)/);
  assert.deepEqual(nodeTextRows(full).map(row => row.kind), ['label', 'counter']);
  assertInside(nodeTextRows(full), full.r);
  assert.equal(project({ from: now - hour, to: now }).counterText, '1 giờ · 4,1 triệu token');
});

test('Dự án agy chỉ có thời gian, ghi rõ thiếu token; không có thời gian hợp lệ thì bỏ dòng', () => {
  for (const lane of ['Opus', 'Argon']) {
    const project = layoutMindmap([run('agy', { lane, tokens: null })], { now }).nodes.find(node => node.type === 'project');
    assert.equal(project.counterText, '2 giờ');
    assert.match(project.counterDescription, /chưa đọc được token \(0\/1 lần giao có số liệu\), chưa có lần gọi model nào hoàn tất để tính token/);
    assertInside(nodeTextRows(project), project.r);
  }
  const project = layoutMindmap([run('thiếu thời gian', { start: NaN, end: null })], { now }).nodes.find(node => node.type === 'project');
  assert.equal(project.counterText, '');
  assert.ok(project.r >= 74 && project.r <= 90);
  assert.deepEqual(nodeTextRows(project).map(row => row.kind), ['label']);
});

test('Không rõ dự án rút gọn nhãn, giữ nhãn đầy đủ và vừa vòng tròn; nút gộp và lá không có bộ đếm', () => {
  const layout = layoutMindmap(Array.from({ length: 12 }, (_, i) => run(`không rõ ${i}`, { projectKey: '(không rõ)' })), { now });
  const project = layout.nodes.find(node => node.type === 'project');
  const rows = nodeTextRows(project);
  assert.equal(project.fullLabel, 'Không rõ dự án (12)');
  assert.ok(rows[0].text.endsWith('...'));
  assert.ok(rows[0].width <= 156);
  assertInside(rows, project.r);
  const many = layoutMindmap(Array.from({ length: 12 }, (_, i) => run(`dự án ${i}`, { projectKey: `dự án ${i}` })), { now });
  assert.ok(many.nodes.some(node => node.type === 'more' && node.label.includes('dự án')));
  for (const node of [...layout.nodes, ...many.nodes].filter(node => ['more', 'run'].includes(node.type))) {
    assert.ok(!nodeTextRows(node).some(row => row.kind === 'counter'));
  }
});

test('500 lần giao có bộ đếm dự án và bảy model vẫn không chồng nút khi mặc định và mở hết', () => {
  const runs = Array.from({ length: 500 }, (_, i) => run(`mẫu ${i}`, {
    lane: ['Codex', 'Opus', 'Argon'][i % 3], projectKey: `dự án ${Math.floor(i / 3) % 12}`,
    tokens: i % 3 ? null : { total: 22_600_000 },
  }));
  const options = { now, claudeModels: Array.from({ length: 7 }, (_, i) => `model-tổng-hợp-${i}`) };
  const first = layoutMindmap(runs, options);
  const expanded = [...first.nodes.filter(node => node.type === 'lane').map(node => node.id),
    ...runs.map(run => `project:${run.lane}:${run.projectKey}`)];
  const full = layoutMindmap(runs, { ...options, expanded });
  assert.equal(full.nodes.filter(node => node.type === 'run').length, 500);
  for (const layout of [first, full]) {
    for (const node of layout.nodes.filter(node => ['root', 'lane', 'project'].includes(node.type))) assertInside(nodeTextRows(node), node.r);
    for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i], b = layout.nodes[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.reserve + b.reserve + 4 - 1e-7, `Chồng nút ${a.id}, ${b.id}`);
    }
  }
});
