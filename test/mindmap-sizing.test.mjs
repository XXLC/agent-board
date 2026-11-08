import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as sizing from '../public/mindmap-layout.js';

const now = 1_793_577_600_000;
const hour = 3600_000;
function samples(count, seed = 17) {
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: count }, (_, i) => ({
    id: `tổng hợp ${i}`, lane: ['Codex', 'Opus', 'Argon'][Math.floor(random() * 3)], kind: 'giao việc',
    projectKey: `dự án ${Math.floor(random() * 16)}`,
    projectLabel: 'Dự án tổng hợp có tên cực dài '.repeat(1 + Math.floor(random() * 70)),
    model: `model-tổng-hợp-${i}`, start: now - random() * 40 * 24 * hour,
    end: i % 3 ? now : null, running: i % 3 === 0, tokens: { total: Number.MAX_SAFE_INTEGER },
  }));
}

function hierarchy(layout) {
  const radii = type => layout.nodes.filter(node => node.type === type).map(node => node.r);
  const root = radii('root')[0], lanes = radii('lane'), projects = radii('project'), leaves = radii('run');
  assert.ok(root >= Math.max(...lanes) * 1.25);
  assert.ok(Math.min(...lanes) >= Math.max(...projects) * 1.2);
  assert.ok(Math.min(...projects) >= Math.max(...leaves) * 1.3);
  assert.ok(projects.every(radius => radius <= 90));
}

function inside(row, radius, fontSize = row.fontSize) {
  const edge = Math.max(Math.abs(row.y - fontSize), Math.abs(row.y + fontSize * .28));
  const width = row.width * fontSize / row.fontSize;
  assert.ok(edge + 6 <= radius + 1e-8, 'Chữ vượt lề dọc 6');
  assert.ok(Math.hypot(width / 2 + 6, edge) <= radius + 1e-8, 'Chữ vượt dây cung có lề 6');
}

test('Thuộc tính thứ bậc, trần và chữ vừa bóng với tên dài, nhiều model, số lớn, 1 đến 500 lần giao', () => {
  for (const [seed, count] of [1, 2, 6, 17, 49, 120, 241, 500].entries()) {
    const runs = samples(count, seed + 1);
    const options = { now, claudeModels: Array.from({ length: 80 }, (_, i) => `model-tổng-hợp-${i}`) };
    const expanded = ['lane:Codex', 'lane:Opus', 'lane:Argon', ...runs.map(run => `project:${run.lane}:${run.projectKey}`)];
    for (const open of [[], expanded]) {
      const layout = sizing.layoutMindmap(runs, { ...options, expanded: open });
      hierarchy(layout);
      if (open.length) assert.equal(layout.nodes.filter(node => node.type === 'run').length, count);
      for (const node of layout.nodes.filter(node => sizing.NODE_RADII[node.type])) {
        for (const reserve of [true, false]) for (const row of sizing.nodeTextRows(node, { reserve, elapsedText: '999999 giờ 59 phút' })) {
          inside(row, node.r);
        }
      }
      for (let i = 0; i < layout.nodes.length; i++) for (const b of layout.nodes.slice(i + 1)) {
        const a = layout.nodes[i];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.reserve + b.reserve + 4 - 1e-7, `Chồng nút ${a.id}, ${b.id}`);
      }
    }
  }
});

function cap(api) {
  const huge = [{ width: 2000, top: -25, bottom: 25 }];
  assert.equal(api.boundedNodeRadius(huge, 'project'), 90, 'Trần dự án phải chặn nội dung dài');
}
test('Trần dự án chặn nội dung vượt dự trữ', () => cap(sizing));

function compensation(api) {
  const node = { type: 'project', label: 'Dự án mẫu', counterText: '999999 giờ · 999999 tỷ token', r: 82.2 };
  const rows = api.nodeTextRows(node);
  for (const scale of [.18, .265, .73, 1, 2]) {
    for (const row of rows) {
      const font = api.compensatedFont(row, node.r, scale, node.type);
      assert.ok(font >= row.fontSize - 1e-8);
      assert.ok(font <= row.maxFontSize);
      if (row.kind === 'label') {
        assert.ok(font <= Math.max(15, 10 / scale));
        if (scale >= .73) assert.equal(font, 15);
        else assert.ok(font > 15);
      } else assert.equal(font, 12);
      inside(row, node.r, font);
    }
  }
}
test('Bù cỡ chữ tại 0,18; 0,265; 0,73; 1; 2 và chặn theo dây cung, chiều cao', () => compensation(sizing));

function visibility(api) {
  assert.equal(api.SUBTITLE_MIN_SCREEN_PX, 8);
  for (const kind of ['subtitle', 'counter', 'elapsed']) {
    assert.equal(api.rowVisible({ kind }, 12, 7.999 / 12), false);
    assert.equal(api.rowVisible({ kind }, 12, 8 / 12), true);
    assert.equal(api.rowVisible({ kind }, 12, 2), true);
  }
  assert.equal(api.rowVisible({ kind: 'label' }, 15, .0001), true);
}
test('Ẩn dòng phụ dưới 8 px, hiện từ 8 px và không bao giờ ẩn tiêu đề', () => visibility(sizing));

function defaultView(api) {
  const fit = .45;
  for (const kind of ['subtitle', 'counter', 'elapsed']) {
    // Ở khung "Căn giữa" (mặc định) và phóng to hơn: luôn hiện dù chữ chỉ 5,4 px.
    assert.equal(api.rowVisible({ kind }, 12, fit, fit), true);
    assert.equal(api.rowVisible({ kind }, 12, fit * 2, fit), true);
    // Chỉ khi thu nhỏ hơn mặc định (và chữ dưới 8 px) mới ẩn.
    assert.equal(api.rowVisible({ kind }, 12, fit * .8, fit), false);
    assert.equal(api.rowVisible({ kind }, 12, fit * .5, fit), false);
  }
  assert.equal(api.rowVisible({ kind: 'label' }, 15, .01, fit), true);
}
test('Ở khung Căn giữa vẫn thấy dòng phụ, chỉ thu nhỏ hơn mặc định mới ẩn', () => defaultView(sizing));

test('Khung lõi và bù chữ đạt ngưỡng dự kiến trên vùng 1159 x 760 ở bốn khoảng', () => {
  for (const [hours, count] of [[6, 6], [24, 120], [168, 500], [720, 500]]) {
    const runs = samples(count);
    const layout = sizing.layoutMindmap(runs, { now, range: { from: now - hours * hour, to: now } });
    const scale = Math.min(1159 / layout.coreBounds[2], 760 / layout.coreBounds[3]);
    for (const node of layout.nodes.filter(node => sizing.NODE_RADII[node.type])) {
      const row = sizing.nodeTextRows(node)[0];
      const font = sizing.compensatedFont(row, node.r, scale, node.type);
      const threshold = node.type === 'project' ? hours <= 24 ? 10 : 8 : hours <= 24 ? 12 : 10;
      assert.ok(font * scale >= threshold - 1e-8, `${hours} giờ, ${node.id}: ${font * scale} px`);
      const [x, y, w, h] = layout.coreBounds;
      assert.ok(node.x - node.r >= x && node.x + node.r <= x + w);
      assert.ok(node.y - node.r >= y && node.y + node.r <= y + h);
    }
    assert.ok(layout.bounds[2] >= layout.coreBounds[2]);
  }
});

test('Làn lệch tải ở 24 giờ vẫn đủ 12 px cho gốc, làn và 10 px cho dự án', () => {
  for (let busy = 0; busy < 3; busy++) {
    const runs = samples(500).map((run, i) => ({ ...run,
      lane: ['Codex', 'Opus', 'Argon'][i < 484 ? busy : i % 3], projectKey: `dự án ${i % 8}`,
    }));
    const layout = sizing.layoutMindmap(runs, { now });
    const scale = Math.min(1159 / layout.coreBounds[2], 760 / layout.coreBounds[3]);
    for (const node of layout.nodes.filter(node => sizing.NODE_RADII[node.type])) {
      const row = sizing.nodeTextRows(node)[0];
      const px = sizing.compensatedFont(row, node.r, scale, node.type) * scale;
      assert.ok(px >= (node.type === 'project' ? 10 : 12) - 1e-8, `${node.id}: ${px} px`);
    }
  }
});

test('Ba đột biến bị kiểm thử mới bắt: bỏ trần, bỏ chặn cỡ chữ, hạ ngưỡng ẩn', async () => {
  const source = await readFile(new URL('../public/mindmap-layout.js', import.meta.url), 'utf8');
  const mutations = [
    ['return Math.min(limits.max, nodeRadius(rows, limits.min));', 'return nodeRadius(rows, limits.min);', cap],
    ['return Math.min(wanted, row.maxFontSize, widthCap);', 'return wanted;', compensation],
    ['fontSize * scale >= SUBTITLE_MIN_SCREEN_PX', 'fontSize * scale >= 7', visibility],
    ['|| scale >= fitScale * DEFAULT_VIEW_TOLERANCE', '|| false', defaultView],
  ];
  for (const [before, after, check] of mutations) {
    assert.ok(source.includes(before));
    const mutant = source.replace(before, after).replace(/from '(\.\/[^']+)'/g,
      (_, path) => `from '${new URL(path, new URL('../public/mindmap-layout.js', import.meta.url)).href}'`);
    const api = await import(`data:text/javascript;base64,${Buffer.from(mutant).toString('base64')}`);
    assert.throws(() => check(api), assert.AssertionError);
  }
});
