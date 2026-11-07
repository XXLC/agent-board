import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { layoutMindmap } from '../public/mindmap-layout.js';
import * as modelLabels from '../public/model-labels.js';
import * as activity from '../public/activity.js';

const source = (await readFile(new URL('../public/mindmap.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '');
function board() {
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const ids = new Map(), windowEvents = new Map();
  class Node {
    constructor() { this.children = []; this.attributes = {}; this.events = {}; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(key, handler) { this.events[key] = handler; }
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 390, height: 460 }; }
    setPointerCapture() {}
    closest() { return null; }
    focus() { this.focused = true; }
  }
  const document = {
    createElementNS: () => new Node(),
    getElementById(id) { if (!ids.has(id)) ids.set(id, new Node()); return ids.get(id); },
  };
  const window = {
    addEventListener: (event, handler) => windowEvents.set(event, handler), dispatchEvent() {},
  };
  const location = { hash: '#so-do' };
  const context = vm.createContext({ ...modelLabels, ...activity, document, window, location, Event: class {}, layoutMindmap, Date: Clock });
  vm.runInContext(source, context);
  const evaluate = code => vm.runInContext(code, context);
  return { ids, window, windowEvents, location, evaluate, advance(ms) { clock += ms; } };
}
const sample = {
  id: 'tổng-hợp', lane: 'Codex', kind: 'giao việc', projectKey: 'dự-án', projectLabel: 'Dự án',
  start: Date.now() - 60_000, end: null, running: true, prompt: 'Lời nhắc tổng hợp', status: 'unknown',
};

test('Cập nhật trực tiếp giữ DOM, viewBox, vị trí và trạng thái thu gọn; bàn phím mở chi tiết', () => {
  const ui = board(), details = [];
  ui.window.boardMindmap.update([sample], run => details.push(run.id), 'khung');
  const group = ui.evaluate("nodeElements.get('run:tổng-hợp').group");
  const position = group.attributes.transform;
  ui.ids.get('map-zoom-in').events.click();
  const zoomed = ui.ids.get('mindmap').attributes.viewBox;
  ui.window.boardMindmap.update([{ ...sample, running: false, status: 'error', end: Date.now() }], run => details.push(run.id), 'khung');
  assert.equal(ui.evaluate("nodeElements.get('run:tổng-hợp').group"), group);
  assert.equal(group.attributes.transform, position);
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, zoomed);
  assert.ok(group.attributes.class.includes('error'));
  assert.equal(ui.evaluate("nodeElements.get('run:tổng-hợp').mark.textContent"), 'X');
  let prevented = false;
  group.events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(details, ['tổng-hợp']);
  const lane = ui.evaluate("nodeElements.get('lane:Codex').group");
  lane.events.click();
  ui.window.boardMindmap.update([sample], () => {}, 'khung');
  assert.equal(lane.attributes['aria-expanded'], 'false');
  assert.equal(ui.evaluate("nodeElements.has('run:tổng-hợp')"), false);
  lane.events.click();
  assert.equal(ui.evaluate("nodeElements.has('run:tổng-hợp')"), true);
});

test('Hash đổi tab, cảm ứng kéo nền, zoom và căn giữa bằng nút', () => {
  const ui = board();
  ui.window.boardMindmap.update([sample], () => {}, 'khung');
  assert.equal(ui.ids.get('timeline-view').hidden, true);
  ui.ids.get('tab-timeline').events.click();
  assert.equal(ui.location.hash, 'dong-thoi-gian');
  ui.location.hash = '#dong-thoi-gian'; ui.windowEvents.get('hashchange')();
  assert.equal(ui.ids.get('mindmap-view').hidden, true);
  const svg = ui.ids.get('mindmap'), initial = svg.attributes.viewBox;
  svg.events.pointerdown({ target: svg, pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
  svg.events.pointermove({ clientX: 50, clientY: 60 });
  assert.notEqual(svg.attributes.viewBox, initial);
  svg.events.pointerup();
  ui.ids.get('map-center').events.click();
  assert.equal(svg.attributes.viewBox, initial);
  assert.ok(ui.evaluate("[...nodeElements.values()].every(item => item.group.attributes.tabindex === '0' && item.title.textContent)"));
});

test('Nút chưa rõ dự án đếm số lần, tooltip tổng hợp lý do và giữ lời nhắc giải thích', () => {
  const ui = board();
  const runs = [1, 2].map(i => ({ ...sample, id: `tổng-hợp-${i}`, projectKey: '(không rõ)', projectLabel: 'Không rõ dự án',
    unknownReason: 'Codex: không ghi thư mục làm việc', promptSource: 'không có', prompt: 'Lời nhắc truyền qua stdin, không còn trong lệnh' }));
  ui.window.boardMindmap.update(runs, () => {}, 'khung');
  assert.equal(ui.evaluate("nodeElements.get('project:Codex:(không rõ)').label.textContent"), 'Không rõ dự án (2)');
  assert.match(ui.evaluate("nodeElements.get('project:Codex:(không rõ)').title.textContent"), /Codex: không ghi thư mục làm việc: 2/);
  const tooltip = ui.evaluate("nodeElements.get('run:tổng-hợp-1').title.textContent");
  assert.match(tooltip, /Lời nhắc truyền qua stdin, không còn trong lệnh/);
  assert.match(tooltip, /nguồn lời nhắc: không có/);
});

test('Mindmap dùng tên làn chung, tóm tắt model Claude và ghi model, effort trên lá cùng tooltip', () => {
  const ui = board();
  ui.window.boardMindmap.update([
    { ...sample, model: 'gpt-6.1-sol', effort: 'high', modelSource: 'rollout' },
    { ...sample, id: 'flash', lane: 'Argon', model: 'gemini-3.5-flash-lite' },
    { ...sample, id: 'sonnet', lane: 'Opus', model: 'claude-sonnet-5-5-high' },
  ], () => {}, 'model', [
    { ...sample, id: 'claude-sonnet', lane: 'Claude', model: 'claude-sonnet-5-5' },
    { ...sample, id: 'claude-opus', lane: 'Claude', model: 'claude-opus-5-5' },
  ]);
  assert.equal(ui.evaluate("nodeElements.get('root').label.textContent"), modelLabels.LANE_LABELS.Claude);
  for (const lane of ['Codex', 'Opus', 'Argon']) {
    assert.equal(ui.evaluate(`nodeElements.get('lane:${lane}').label.textContent`), modelLabels.LANE_LABELS[lane]);
    assert.ok(ui.evaluate(`nodeElements.get('lane:${lane}').title.textContent`).includes(modelLabels.LANE_LABELS[lane]));
  }
  assert.match(ui.evaluate("nodeElements.get('root').title.textContent"), /Sonnet 5.5 x 1/);
  assert.match(ui.evaluate("nodeElements.get('root').title.textContent"), /Opus 5.5 x 1/);
  assert.equal(ui.evaluate("nodeElements.get('root').subtitle.children.length"), 2);
  assert.equal(ui.evaluate("nodeElements.get('run:tổng-hợp').label.textContent"), 'gpt-6.1-sol');
  assert.equal(ui.evaluate("nodeElements.get('run:tổng-hợp').subtitle.children[0].textContent"), 'high');
  assert.match(ui.evaluate("nodeElements.get('run:tổng-hợp').title.textContent"), /gpt-6.1-sol · high/);
  for (const id of ['flash', 'sonnet']) assert.match(ui.evaluate(`nodeElements.get('run:${id}').title.textContent`), /model khác tên làn/);
});

test('Giao chuyển sang làm rồi xong giữ phần tử, vị trí, halo và dừng hạt đúng cạnh', () => {
  const ui = board();
  const run = { ...sample, start: ui.evaluate('Date.now()') - 12000 };
  const update = value => ui.window.boardMindmap.update([value], () => {}, 'giai-đoạn');
  update(run);
  const leaf = ui.evaluate("nodeElements.get('run:tổng-hợp')");
  const lane = ui.evaluate("nodeElements.get('lane:Codex')");
  const edge = ui.evaluate("edgeElements.get('root>lane:Codex')");
  const packet = edge.particles.children[0], halo = leaf.halos[0];
  const position = leaf.group.attributes.transform;
  const zoomed = ui.ids.get('mindmap').attributes.viewBox;
  assert.match(edge.group.attributes.class, /activity-delegating/);
  assert.equal(edge.particles.children.length, 3);
  assert.equal(edge.line.attributes['stroke-width'], '3');
  assert.equal(leaf.halos.length, 2); assert.equal(lane.halos.length, 2);
  for (const item of [leaf, lane]) {
    assert.match(item.group.attributes.class, /activity-working.*activity-delegating/);
    assert.match(item.group.attributes['aria-label'], /đang giao/);
    assert.equal(item.phaseLabel.textContent, 'đang giao');
  }
  assert.match(leaf.title.textContent, /vừa gửi 12 giây trước/);
  assert.equal(ui.evaluate("[...edgeElements.values()].filter(item => item.particles).length"), 1);
  for (const id of ['lane:Codex>project:Codex:dự-án', 'project:Codex:dự-án>run:tổng-hợp']) {
    assert.match(ui.evaluate(`edgeElements.get('${id}').group.attributes.class`), /activity-working/);
    assert.equal(ui.evaluate(`edgeElements.get('${id}').line.attributes['stroke-width']`), '2');
  }
  const root = ui.evaluate("nodeElements.get('root')");
  const waveClass = root.group.attributes.class;
  update(run); assert.equal(root.group.attributes.class, waveClass);
  ui.advance(34000); update(run);
  assert.doesNotMatch(edge.group.attributes.class, /activity-delegating/);
  assert.equal(edge.particles.children[0], packet);
  assert.equal(leaf.halos[0], halo);
  assert.match(leaf.group.attributes.class, /activity-working/);
  assert.doesNotMatch(leaf.group.attributes.class, /activity-delegating/);
  assert.match(leaf.group.attributes['aria-label'], /đang làm/);
  assert.equal(leaf.phaseLabel.textContent, 'đang làm');
  update({ ...run, running: false, end: run.start + 46000, status: 'ok' });
  assert.doesNotMatch(edge.group.attributes.class, /activity-working|activity-delegating/);
  assert.doesNotMatch(leaf.group.attributes.class, /activity-working|activity-delegating/);
  assert.equal(leaf.phaseLabel.textContent, '');
  assert.equal(lane.badge.attributes.display, 'none');
  assert.equal(edge.line.attributes['stroke-width'], '1.2');
  assert.equal(ui.evaluate("nodeElements.get('run:tổng-hợp')"), leaf);
  assert.equal(leaf.group.attributes.transform, position);
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, zoomed);
});

test('Nhiều run cùng làn có một cặp halo, số đang chạy và hạt chỉ ở làn đang giao', () => {
  const ui = board();
  const now = ui.evaluate('Date.now()');
  const runs = [{ ...sample, start: now - 1000 }, { ...sample, id: 'thứ-hai', start: now - 80000 },
    { ...sample, id: 'làn-khác', lane: 'Argon', start: now - 90000 }];
  ui.window.boardMindmap.update(runs, () => {}, 'nhiều-run');
  const lane = ui.evaluate("nodeElements.get('lane:Codex')");
  assert.equal(lane.halos.length, 2);
  assert.equal(lane.badge.children[2].textContent, '2 đang chạy');
  assert.equal(ui.evaluate("edgeElements.get('root>lane:Argon').particles"), undefined);
  assert.match(ui.evaluate("edgeElements.get('root>lane:Argon').group.attributes.class"), /activity-working/);
  assert.doesNotMatch(ui.evaluate("edgeElements.get('root>lane:Argon').group.attributes.class"), /activity-delegating/);
  ui.window.boardMindmap.update(runs, () => {}, 'nhiều-run');
  assert.equal(lane.halos.length, 2);
  assert.equal(ui.evaluate("edgeElements.get('root>lane:Codex').particles.children.length"), 3);
});

test('Gợn sóng ở nút gốc chỉ có khi còn lần giao mới, không phát lại khi chỉ còn đang làm', () => {
  const ui = board();
  const run = { ...sample, start: ui.evaluate('Date.now()') - 12000 };
  const update = value => ui.window.boardMindmap.update([value], () => {}, 'gợn-sóng');
  update(run);
  const root = ui.evaluate("nodeElements.get('root')");
  assert.match(root.group.attributes.class, /root-wave-[12]/);
  // Qua mốc 45 giây: vẫn đang chạy nhưng đã sang "làm", gợn sóng phải tắt.
  ui.advance(34000); update(run);
  assert.doesNotMatch(root.group.attributes.class, /root-wave-/);
  // Cập nhật lại nhiều lần (đổi bộ lọc, SSE) không được kích hoạt lại sóng.
  update(run); update(run);
  assert.doesNotMatch(root.group.attributes.class, /root-wave-/);
  // Một lần giao mới thật sự thì sóng xuất hiện lại.
  update({ ...run, id: 'lần-giao-mới', start: ui.evaluate('Date.now()') - 1000 });
  assert.match(root.group.attributes.class, /root-wave-[12]/);
});

test('Tab Sơ đồ ẩn không tính bố cục mỗi giây, chuyển sang tab thì vẽ ngay dữ liệu mới nhất', () => {
  const ui = board();
  ui.location.hash = '#dong-thoi-gian'; ui.windowEvents.get('hashchange')();
  const run = { ...sample, start: ui.evaluate('Date.now()') - 12000 };
  const update = value => ui.window.boardMindmap.update([value], () => {}, 'tab-ẩn');
  const before = ui.evaluate('nodeElements.size');
  update(run); update(run); update({ ...run, prompt: 'bản mới nhất' });
  assert.equal(ui.evaluate('nodeElements.size'), before, 'tab ẩn không được dựng nút');
  assert.equal(ui.ids.get('run-count').textContent, '1 thanh hoạt động');
  ui.location.hash = '#so-do'; ui.windowEvents.get('hashchange')();
  assert.ok(ui.evaluate('nodeElements.size') > before, 'chuyển sang tab Sơ đồ phải vẽ ngay');
  assert.match(ui.evaluate("nodeElements.get('run:tổng-hợp').title.textContent"), /bản mới nhất/);
});

test('Sơ đồ hiển thị dấu giao chéo trên lá, số lần giao chéo trên nút dự án và giữ nguyên nút khi SSE cập nhật', () => {
  const ui = board();
  const runs = [
    {
      ...sample, id: 'lá-chéo', projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A',
      crossProject: true, workProjectKey: 'd--Workspace-DuAn-B', workProjectLabel: 'DuAn_B',
      workProjectPath: 'D:/Workspace/DuAn_B', workProjectOutsideClaude: false,
    },
    {
      ...sample, id: 'lá-cùng', projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A',
      crossProject: false,
    },
  ];
  ui.window.boardMindmap.update(runs, () => {}, 'chéo');
  const crossLeaf = ui.evaluate("nodeElements.get('run:lá-chéo')");
  const sameLeaf = ui.evaluate("nodeElements.get('run:lá-cùng')");
  const projectNode = ui.evaluate("nodeElements.get('project:Codex:d--Workspace-DuAn-A')");
  const crossTransform = crossLeaf.group.attributes.transform;
  const projectTransform = projectNode.group.attributes.transform;

  assert.match(crossLeaf.group.attributes.class, /cross-project/);
  assert.equal(crossLeaf.crossMark.attributes.display, 'inline');
  assert.ok(crossLeaf.crossMark.attributes.d);
  assert.match(crossLeaf.title.textContent, /giao chéo: làm việc ở dự án DuAn_B/);
  assert.match(crossLeaf.group.attributes['aria-label'], /giao chéo: làm việc ở dự án DuAn_B/);

  assert.doesNotMatch(sameLeaf.group.attributes.class, /cross-project/);
  assert.equal(sameLeaf.crossMark.attributes.display, 'none');
  assert.doesNotMatch(sameLeaf.title.textContent, /giao chéo:/);

  assert.match(projectNode.title.textContent, /1 lần giao chéo sang dự án khác/);
  assert.match(projectNode.group.attributes['aria-label'], /1 lần giao chéo sang dự án khác/);

  ui.window.boardMindmap.update(runs.map(run => ({ ...run, running: false, status: 'ok', end: run.start + 50000 })), () => {}, 'chéo');
  assert.equal(ui.evaluate("nodeElements.get('run:lá-chéo')"), crossLeaf);
  assert.equal(ui.evaluate("nodeElements.get('project:Codex:d--Workspace-DuAn-A')"), projectNode);
  assert.equal(crossLeaf.group.attributes.transform, crossTransform);
  assert.equal(projectNode.group.attributes.transform, projectTransform);
});
