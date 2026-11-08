import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { layoutMindmap, nodeTextRows, compensatedFont, rowVisible } from '../public/mindmap-layout.js';
import * as modelLabels from '../public/model-labels.js';
import * as activity from '../public/activity.js';
import * as counters from '../public/counters.js';
import { createWakeLock } from '../public/wake-lock.js';

const source = (await readFile(new URL('../public/mindmap.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '');
function board(box = { width: 390, height: 460 }) {
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const ids = new Map(), windowEvents = new Map();
  class Node {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = {}; this.events = {}; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(key, handler) { this.events[key] = handler; }
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, ...box }; }
    setPointerCapture() {}
    closest() { return null; }
    focus() { this.focused = true; }
  }
  const document = {
    addEventListener() {},
    createElementNS: (_, tagName) => new Node(tagName),
    getElementById(id) { if (!ids.has(id)) ids.set(id, new Node()); return ids.get(id); },
  };
  const window = {
    addEventListener: (event, handler) => windowEvents.set(event, handler), dispatchEvent() {},
  };
  const location = { hash: '#so-do' };
  const context = vm.createContext({ ...modelLabels, ...activity, ...counters, createWakeLock, document, window, location,
    Event: class {}, layoutMindmap, nodeTextRows, compensatedFont, rowVisible, Date: Clock });
  vm.runInContext(source, context);
  const evaluate = code => vm.runInContext(code, context);
  return { ids, window, windowEvents, location, evaluate, advance(ms) { clock += ms; } };
}
const sample = {
  id: 'tổng-hợp', lane: 'Codex', kind: 'giao việc', projectKey: 'dự-án', projectLabel: 'Dự án',
  start: Date.now() - 60_000, end: null, running: true, prompt: 'Lời nhắc tổng hợp', status: 'unknown',
};

test('Phóng, thu, kéo, căn lõi, xem tất cả và đổi khung chỉ sửa thuộc tính; chữ phụ ẩn rồi hiện lại', () => {
  const box = { width: 1159, height: 760 }, ui = board(box);
  const runs = Array.from({ length: 120 }, (_, i) => ({ ...sample, id: `tổng hợp ${i}`,
    lane: ['Codex', 'Opus', 'Argon'][i % 3], projectKey: `dự án ${Math.floor(i / 3) % 8}`,
    projectLabel: 'Dự án tổng hợp', start: ui.evaluate('Date.now()') - 60_000,
  }));
  ui.window.boardMindmap.update(runs, () => {}, 'đọc chữ');
  const items = ui.evaluate('[...nodeElements.values()]');
  const snapshots = items.map(item => ({ item, transform: item.group.attributes.transform, r: item.circle.attributes.r,
    children: [...item.group.children], rows: item.textRows.map(({ element }) => [element, element.attributes.y]),
  }));
  const lane = items.find(item => item.node.id === 'lane:Codex');
  const originalStyle = lane.label.attributes.style;
  const svg = ui.ids.get('mindmap');
  const core = svg.attributes.viewBox;
  // Cấm mọi đường dựng chữ và tính bố cục sau khi đã vẽ.
  ui.evaluate("draw = updateNodeText = layoutMindmap = () => { throw new Error('Không được dựng lại sơ đồ'); };");
  for (const item of items) for (const { element } of item.textRows) {
    const text = element.textContent;
    Object.defineProperty(element, 'textContent', { get: () => text, set() { throw new Error('Chỉ được đổi thuộc tính'); } });
  }
  ui.ids.get('map-zoom-out').events.click();
  assert.notEqual(lane.label.attributes.style, originalStyle);
  assert.equal(lane.counterLabel.attributes.display, 'none');
  ui.ids.get('map-zoom-in').events.click();
  svg.events.wheel({ preventDefault() {}, deltaY: 1, clientX: 200, clientY: 200 });
  svg.events.pointerdown({ clientX: 100, clientY: 100, pointerId: 1 });
  svg.events.pointermove({ clientX: 140, clientY: 120 });
  svg.events.pointerup();
  ui.ids.get('map-show-all').events.click();
  assert.equal(svg.attributes.viewBox, ui.evaluate('layout.bounds.join(" ")'));
  ui.ids.get('map-center').events.click();
  assert.equal(svg.attributes.viewBox, core);
  const title = lane.title.textContent, aria = lane.group.attributes['aria-label'];
  box.width = 3000; box.height = 2000;
  ui.windowEvents.get('resize')();
  assert.equal(lane.counterLabel.attributes.display, 'inline');
  assert.equal(lane.title.textContent, title); assert.equal(lane.group.attributes['aria-label'], aria);
  assert.equal(svg.attributes.viewBox, core);
  for (const snapshot of snapshots) {
    const { item, transform, r, children, rows } = snapshot;
    assert.equal(ui.evaluate(`nodeElements.get(${JSON.stringify(item.node.id)})`), item);
    assert.equal(item.group.attributes.transform, transform); assert.equal(item.circle.attributes.r, r);
    assert.deepEqual(item.group.children, children);
    for (const [element, y] of rows) assert.equal(element.attributes.y, y);
    assert.notEqual(item.label.attributes.display, 'none');
  }
});

test('Tên dự án và model bị rút gọn vẫn đầy đủ trong tooltip và nhãn trợ năng khi thu nhỏ', () => {
  const ui = board();
  const models = Array.from({ length: 20 }, (_, i) => `model-tổng-hợp-${i}`);
  const label = 'Dự án tổng hợp có tên rất dài '.repeat(20);
  ui.window.boardMindmap.update([{ ...sample, projectLabel: label }], () => {}, 'đủ thông tin', [], models);
  ui.ids.get('map-show-all').events.click();
  const root = ui.evaluate("nodeElements.get('root')");
  const project = ui.evaluate("nodeElements.get('project:Codex:dự-án')");
  assert.equal(root.subtitle.children.length, 4);
  assert.equal(root.subtitle.children[3].textContent, '+17 model');
  assert.ok(project.label.textContent.endsWith('...'));
  for (const text of [root.title.textContent, root.group.attributes['aria-label']]) assert.ok(text.includes(models[19]));
  for (const text of [project.title.textContent, project.group.attributes['aria-label']]) {
    assert.ok(text.includes(label)); assert.ok(text.includes('1 lần giao'));
  }
});

function assertNoPhase(item) {
  assert.equal(item.phaseLabel, undefined, 'Không được dựng phần tử nhãn pha');
  const inspect = node => {
    assert.doesNotMatch(node.attributes.class || '', /\bmap-phase\b/);
    if (node.tagName === 'title') return;
    assert.doesNotMatch(node.textContent, /đang (?:làm|giao)/i, 'Chữ nhìn thấy trong bóng không được có nhãn pha');
    for (const child of node.children) inspect(child);
  };
  inspect(item.group);
}

test('Phụ đề làn, gốc Claude và tooltip lá có token đúng khoảng, SSE chỉ đổi chữ và giữ bố cục', () => {
  const ui = board(), now = ui.evaluate('Date.now()');
  const tokens = { input: 10, cacheRead: 90, cacheWrite: 0, output: 100, reasoning: 30, total: 200 };
  const run = { ...sample, start: now - 3_600_000, tokens };
  const claude = { ...run, id: 'gốc', lane: 'Claude', tokens: { ...tokens, total: 400 } };
  ui.window.boardMindmap.update([run], () => {}, 'token', [claude], [], { from: now - 600_000, to: now });
  const leaf = ui.evaluate("nodeElements.get('run:tổng-hợp')"), lane = ui.evaluate("nodeElements.get('lane:Codex')");
  const root = ui.evaluate("nodeElements.get('root')");
  assert.match(lane.counterLabel.textContent, /10 phút · 200 token/);
  assert.match(root.counterLabel.textContent, /10 phút · 400 token/);
  assert.match(leaf.title.textContent, /200 token.*Vào: 10 token.*Suy luận.*30 token.*Tổng: 200 token/);
  assert.match(leaf.group.attributes['aria-label'], /200 token/);
  const all = ui.evaluate('[...nodeElements.values()].map(item => [item.group, item.group.attributes.transform])');
  const view = ui.ids.get('mindmap').attributes.viewBox;
  const radius = lane.circle.attributes.r;
  ui.window.boardMindmap.update([{ ...run, tokens: { ...tokens, total: 52_000_000 } }], () => {}, 'token', [claude]);
  assert.equal(ui.evaluate("nodeElements.get('run:tổng-hợp')"), leaf);
  assert.match(lane.counterLabel.textContent, /52,0 triệu token/);
  for (const [group, position] of all) assert.equal(group.attributes.transform, position);
  assert.equal(lane.circle.attributes.r, radius);
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, view);
});

test('Nhịp sơ đồ chỉ đổi textContent, không dựng hay bố cục; aria đổi thô 30 giây và dừng ở tab ẩn', () => {
  const ui = board();
  const run = { ...sample, start: ui.evaluate('Date.now()') - 70_000 };
  ui.window.boardMindmap.update([run], () => {}, 'sống');
  const lane = ui.evaluate("nodeElements.get('lane:Codex')"), childRefs = [...lane.group.children];
  const aria = lane.group.attributes['aria-label'], position = lane.group.attributes.transform;
  const view = ui.ids.get('mindmap').attributes.viewBox;
  ui.evaluate("draw = () => { throw new Error('Không được vẽ lại'); }; layoutMindmap = () => { throw new Error('Không được tính bố cục'); };");
  ui.advance(1000); ui.window.boardMindmap.tick(ui.evaluate('Date.now()'));
  assert.equal(lane.elapsedLabel.textContent, '1 phút 11 giây');
  assert.equal(lane.group.attributes['aria-label'], aria);
  assert.deepEqual(lane.group.children, childRefs);
  assert.equal(lane.group.attributes.transform, position); assert.equal(ui.ids.get('mindmap').attributes.viewBox, view);
  ui.advance(29_000); ui.window.boardMindmap.tick(ui.evaluate('Date.now()'));
  assert.notEqual(lane.group.attributes['aria-label'], aria);
  const text = lane.elapsedLabel.textContent;
  ui.evaluate('document.hidden = true'); ui.advance(1000); ui.window.boardMindmap.tick(ui.evaluate('Date.now()'));
  assert.equal(lane.elapsedLabel.textContent, text);
  ui.evaluate('document.hidden = false; active = false'); ui.advance(1000); ui.window.boardMindmap.tick(ui.evaluate('Date.now()'));
  assert.equal(lane.elapsedLabel.textContent, text);
});

test('Đồng hồ bóng chỉ hiện thời lượng khi vẽ và tick, đúng các ranh giới rồi trống khi nghỉ', () => {
  const ui = board(), now = ui.evaluate('Date.now()');
  const cases = [[0, '0 giây'], [42_000, '42 giây'], [59_999, '59 giây'], [60_000, '1 phút 0 giây'],
    [425_000, '7 phút 5 giây'], [3_599_999, '59 phút 59 giây'], [3_600_000, '1 giờ 0 phút'],
    [3_780_000, '1 giờ 3 phút'], [100 * 3_600_000 - 1, '99 giờ 59 phút']];
  let items;
  for (const [ms, expected] of cases) {
    const run = { ...sample, start: now - ms };
    const claude = { ...run, lane: 'Claude', id: 'gốc', model: 'claude-sonnet-5-5' };
    ui.window.boardMindmap.update([run], () => {}, 'đồng-hồ', [claude]);
    items = [ui.evaluate("nodeElements.get('root')"), ui.evaluate("nodeElements.get('lane:Codex')")];
    for (const item of items) {
      assert.equal(item.elapsedLabel.textContent, expected, 'Lúc vẽ không được có tiền tố');
      assertNoPhase(item);
      // Đổi chữ trước nhịp để chứng minh tick thực sự cập nhật cùng phần tử.
      item.elapsedLabel.textContent = '';
    }
    ui.window.boardMindmap.tick(now);
    for (const item of items) assert.equal(item.elapsedLabel.textContent, expected, 'Lúc tick không được có tiền tố');
  }
  ui.window.boardMindmap.update([{ ...sample, running: false, end: now }], () => {}, 'đồng-hồ');
  ui.window.boardMindmap.tick(now + 1000);
  for (const item of items) {
    assert.equal(item.elapsedLabel.textContent, '');
    assertNoPhase(item);
  }
});

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
  assert.ok(ui.evaluate("nodeElements.get('project:Codex:(không rõ)').label.textContent").endsWith('...'));
  assert.match(ui.evaluate("nodeElements.get('project:Codex:(không rõ)').title.textContent"), /Không rõ dự án \(2\)/);
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
  const root = ui.evaluate("nodeElements.get('root')");
  const edge = ui.evaluate("edgeElements.get('root>lane:Codex')");
  const packet = edge.particles.children[0], halo = leaf.halos[0];
  const position = leaf.group.attributes.transform;
  const zoomed = ui.ids.get('mindmap').attributes.viewBox;
  assert.match(edge.group.attributes.class, /activity-delegating/);
  assert.equal(edge.particles.children.length, 3);
  assert.equal(edge.line.attributes['stroke-width'], '3');
  assert.equal(leaf.halos.length, 2); assert.equal(lane.halos.length, 2);
  for (const item of [leaf, lane, root]) {
    assert.equal(item.halos.length, 2);
    assert.match(item.group.attributes.class, /activity-working.*activity-delegating/);
    assert.match(item.group.attributes['aria-label'], /đang giao/);
    assert.match(item.title.textContent, /đang giao/);
    assertNoPhase(item);
  }
  assert.match(leaf.title.textContent, /vừa gửi 12 giây trước/);
  assert.equal(ui.evaluate("[...edgeElements.values()].filter(item => item.particles).length"), 1);
  for (const id of ['lane:Codex>project:Codex:dự-án', 'project:Codex:dự-án>run:tổng-hợp']) {
    assert.match(ui.evaluate(`edgeElements.get('${id}').group.attributes.class`), /activity-working/);
    assert.equal(ui.evaluate(`edgeElements.get('${id}').line.attributes['stroke-width']`), '2');
  }
  const waveClass = root.group.attributes.class;
  update(run); assert.equal(root.group.attributes.class, waveClass);
  ui.advance(34000); update(run);
  assert.doesNotMatch(edge.group.attributes.class, /activity-delegating/);
  assert.equal(edge.particles.children[0], packet);
  assert.equal(leaf.halos[0], halo);
  assert.match(leaf.group.attributes.class, /activity-working/);
  assert.doesNotMatch(leaf.group.attributes.class, /activity-delegating/);
  assert.match(leaf.group.attributes['aria-label'], /đang làm/);
  for (const item of [leaf, lane, root]) {
    assert.match(item.group.attributes['aria-label'], /đang làm/);
    assert.match(item.title.textContent, /đang làm/);
    assertNoPhase(item);
  }
  update({ ...run, running: false, end: run.start + 46000, status: 'ok' });
  assert.doesNotMatch(edge.group.attributes.class, /activity-working|activity-delegating/);
  assert.doesNotMatch(leaf.group.attributes.class, /activity-working|activity-delegating/);
  assertNoPhase(leaf);
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

test('Bóng Claude có halo, chỉ nêu pha trong trợ năng khi đang chạy, tắt khi xong', () => {
  const ui = board();
  const now = ui.evaluate('Date.now()');
  const running = { lane: 'Claude', id: 'claude-chạy', kind: 'hoạt động', model: 'claude-sonnet-5-5', sourceSession: 's', running: true, start: now - 300_000, end: null };
  ui.window.boardMindmap.update([], () => {}, 'gốc-chạy', [running], ['claude-sonnet-5-5', 'claude-opus-5-5']);
  const root = ui.evaluate("nodeElements.get('root')");
  assert.match(root.group.attributes.class, /activity-working/);
  assert.equal(root.halos?.length, 2, 'nút gốc phải có hai vòng halo khi Claude đang chạy');
  assertNoPhase(root);
  assert.match(root.title.textContent, /đang làm/);
  assert.match(root.group.attributes['aria-label'], /đang làm/);
  assert.match(root.group.attributes.class, /^((?!root-wave).)*$/, 'không có lần giao mới nên không phát gợn sóng');
  // Danh sách model đã dùng có Opus 5.5 dù khung chưa có đoạn Opus.
  assert.match(ui.evaluate("nodeElements.get('root').group.attributes['aria-label']"), /Sonnet 5\.5 x 1.*Opus 5\.5 x 0/);
  // Claude xong: tắt hiệu ứng.
  ui.window.boardMindmap.update([], () => {}, 'gốc-chạy', [{ ...running, running: false, end: now - 1000 }], ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.doesNotMatch(root.group.attributes.class, /activity-working/);
  assertNoPhase(root);
  assert.equal(root.elapsedLabel.textContent, '');
});

test('Đồng hồ nút gốc nằm dưới mọi dòng phụ đề và bộ đếm, không có nhãn pha', () => {
  const ui = board();
  const now = ui.evaluate('Date.now()');
  const running = { lane: 'Claude', id: 'claude-chạy', kind: 'hoạt động', model: 'claude-sonnet-5-5', sourceSession: 's', running: true, start: now - 300_000, end: null };
  const lineY = (models) => {
    ui.window.boardMindmap.update([], () => {}, `nhãn-${models.length}`, [running], models);
    const root = ui.evaluate("nodeElements.get('root')");
    const lines = root.subtitle.children.length;
    assertNoPhase(root);
    return { lines, lastY: Number(root.subtitle.children.at(-1).attributes.y), elapsedY: Number(root.elapsedLabel.attributes.y) };
  };
  // Khối chữ căn giữa; đồng hồ phải nằm sau cả dòng bộ đếm.
  const one = lineY([]);
  assert.equal(one.lines, 1); assert.ok(Math.abs(one.elapsedY - one.lastY - 39.28) < 1e-8);
  const two = lineY(['claude-opus-5-5']);
  assert.equal(two.lines, 2);
  assert.ok(Math.abs(two.elapsedY - two.lastY - 39.28) < 1e-8, 'Đồng hồ đè lên dòng phụ đề cuối');
  const three = lineY(['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(three.lines, 3);
  assert.ok(Math.abs(three.elapsedY - three.lastY - 39.28) < 1e-8);
  assert.ok(three.elapsedY > two.elapsedY && two.elapsedY > one.elapsedY);
});

test('DOM xếp mọi dòng đúng hàm thuần, giữ vòng tròn và phần tử qua SSE, nghỉ và đồng hồ 9 sang 10 phút', () => {
  const ui = board(), now = ui.evaluate('Date.now()');
  const run = { ...sample, start: now - 9 * 60_000, tokens: { total: 22_600_000 } };
  const claude = { ...run, lane: 'Claude', id: 'gốc', model: 'claude-sonnet-5-5' };
  const update = (value, root) => ui.window.boardMindmap.update([value], () => {}, 'xếp-chữ', [root], ['claude-opus-5-5']);
  update(run, claude);
  const root = ui.evaluate("nodeElements.get('root')"), lane = ui.evaluate("nodeElements.get('lane:Codex')");
  const project = ui.evaluate("nodeElements.get('project:Codex:dự-án')");
  const compareRows = item => {
    const rows = nodeTextRows(item.node, { elapsedText: item.elapsedLabel.textContent });
    const elements = { label: item.label, counter: item.counterLabel, elapsed: item.elapsedLabel };
    let subtitle = 0;
    for (const row of rows) {
      const element = row.kind === 'subtitle' ? item.subtitle.children[subtitle++] : elements[row.kind];
      assert.equal(element.textContent, row.text);
      assert.equal(Number(element.attributes.y), row.y, `Sai tọa độ ${item.node.id}, ${row.kind}`);
      const fontSize = Number(element.attributes.style.split(':')[1].replace('px', ''));
      assert.ok(Math.abs(Number(element.attributes.textLength) - row.width * fontSize / row.fontSize) < 1e-8);
    }
    const subtitleRow = rows.filter(row => row.kind === 'subtitle').at(-1);
    if (subtitleRow) assert.ok(subtitleRow.y < Number(item.counterLabel.attributes.y));
    if (item.node.type !== 'project' && item.node.running) {
      assert.ok(Number(item.counterLabel.attributes.y) < Number(item.elapsedLabel.attributes.y));
    }
  };
  for (const item of [root, lane, project]) compareRows(item);
  const before = [root, lane, project].map(item => ({
    item, radius: item.circle.attributes.r, position: item.group.attributes.transform, children: [...item.group.children],
    subtitles: [...item.subtitle.children],
  }));
  ui.ids.get('map-zoom-in').events.click();
  const view = ui.ids.get('mindmap').attributes.viewBox;
  ui.advance(60_000); ui.window.boardMindmap.tick(ui.evaluate('Date.now()'));
  assert.equal(lane.elapsedLabel.textContent, '10 phút 0 giây');
  update({ ...run, tokens: { total: 179_600_000 } }, claude);
  update({ ...run, running: false, end: now }, { ...claude, running: false, end: now });
  for (const { item, radius, position, children, subtitles } of before) {
    assert.equal(ui.evaluate(`nodeElements.get('${item.node.id}')`), item);
    assert.equal(item.circle.attributes.r, radius);
    assert.equal(item.group.attributes.transform, position);
    assert.deepEqual(item.group.children, children);
    assert.deepEqual(item.subtitle.children, subtitles);
    compareRows(item);
  }
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, view);
  assertNoPhase(lane); assert.equal(lane.elapsedLabel.textContent, '');
});

test('DOM bộ đếm dự án có hợp khoảng, độ phủ, token agy và cập nhật bốn khoảng thời gian', () => {
  const ui = board(), now = ui.evaluate('Date.now()'), hour = 3600_000;
  const runs = [
    { ...sample, id: 'dài', start: now - 20 * 24 * hour, end: now - hour, running: false, tokens: { total: 2_000_000 } },
    { ...sample, id: 'ngắn', start: now - 2 * hour, end: now, running: false, tokens: { total: 2_100_000 } },
    { ...sample, id: 'không token', start: now - hour, end: now, running: false, tokens: null },
    { ...sample, id: 'agy', lane: 'Opus', start: now - hour, end: now, running: false, tokens: null },
    { ...sample, id: 'thiếu giờ', projectKey: 'thiếu giờ', start: NaN, end: null, running: false },
  ];
  let previous;
  for (const hours of [6, 24, 7 * 24, 30 * 24]) {
    ui.window.boardMindmap.update(runs, () => {}, 'dự án', [], [], { from: now - hours * hour, to: now });
    const project = ui.evaluate("nodeElements.get('project:Codex:dự-án')");
    assert.equal(project.counterLabel.textContent, `${Math.min(hours, 20 * 24)} giờ · 4,1 triệu token`);
    for (const text of [project.title.textContent, project.group.attributes['aria-label']]) {
      assert.match(text, /thời gian chạy .*token 4,1 triệu \(2\/3 lần giao có số liệu\)/);
    }
    const agy = ui.evaluate("nodeElements.get('project:Opus:dự-án')");
    assert.equal(agy.counterLabel.textContent, '1 giờ');
    for (const text of [agy.title.textContent, agy.group.attributes['aria-label']]) {
      assert.match(text, /chưa đọc được token.*0\/1 lần giao có số liệu.*chưa có lần gọi model nào hoàn tất để tính token/);
    }
    assert.equal(ui.evaluate("nodeElements.get('project:Codex:thiếu giờ').counterLabel.textContent"), '');
    if (previous) assert.equal(project, previous);
    previous = project;
  }
});
