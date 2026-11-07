import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as modelLabels from '../public/model-labels.js';
import * as crossProject from '../public/model-labels.js';
import * as activity from '../public/activity.js';

const script = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

// DOM tối thiểu để kiểm tra hình học và tương tác, không mở trình duyệt.
function board(shellWidth = 1198, labelWidth = 100) {
  const ids = new Map();
  class Node {
    constructor() {
      this.children = []; this.style = { setProperty() {} }; this.dataset = {};
      this.attributes = {}; this.listeners = {}; this.className = ''; this.textContent = '';
      this.value = ''; this.scrollLeft = 0;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, enabled) => {
          const names = new Set(this.className.split(' ').filter(Boolean));
          if (enabled) names.add(name); else names.delete(name);
          this.className = [...names].join(' ');
        },
      };
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    get firstChild() { return this.children[0]; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelectorAll(selector) {
      return this.children.flatMap(node => [
        ...(node.classList.contains(selector.slice(1)) ? [node] : []), ...node.querySelectorAll(selector),
      ]);
    }
    getBoundingClientRect() {
      const area = parseFloat(ids.get('chart').style.width) - 104;
      const left = 104 + parseFloat(this.style.left) / 100 * area
        - (this.style.transform ? labelWidth : 0);
      return { left, right: left + labelWidth, width: labelWidth };
    }
  }
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) ids.set(id, new Node());
  ids.get('chart-shell').clientWidth = shellWidth;
  const rangeButtons = [6, 24, 168, 720].map(hours => {
    const node = new Node(); node.dataset.hours = String(hours); return node;
  });
  const document = {
    documentElement: new Node(), addEventListener() {},
    getElementById: id => ids.get(id), createElement: () => new Node(),
    querySelectorAll: selector => selector === '[data-hours]' ? rangeButtons : ids.get('chart').querySelectorAll(selector),
    activeElement: null,
  };
  const context = vm.createContext({ ...modelLabels, ...activity, document, Intl, Date,
    window: { addEventListener() {} }, EventSource: class { addEventListener() {} },
    fetch: () => new Promise(() => {}), setInterval() {},
  });
  vm.runInContext(script, context);
  return { ids, context, evaluate: code => vm.runInContext(code, context) };
}

test('Trục giờ không chồng nhãn ở cả bốn khoảng, tại khung 1280 và 390 px', () => {
  for (const width of [1198, 360]) for (const labelWidth of [70, 100, 130]) {
    const ui = board(width, labelWidth);
    assert.equal(ui.evaluate('hours'), 6);
    for (const hours of [6, 24, 168, 720]) {
      ui.evaluate(`hours = ${hours}; renderChart();`);
      const ticks = ui.ids.get('chart').children[0].children;
      assert.ok(ticks.length >= 2);
      for (let i = 1; i < ticks.length; i++) {
        assert.ok(ticks[i].getBoundingClientRect().left >= ticks[i - 1].getBoundingClientRect().right + 8);
      }
    }
  }
});

test('Thanh ngắn đủ 6 px, không in chữ; cắt mép trái và kết thúc null tại hiện tại', () => {
  const ui = board();
  ui.evaluate(`
    end = Date.now() + 3600_000;
    runs = [
      { id: 'tiếp-tục', lane: 'Argon', start: end - 10 * 3600_000, end: end - 3600_000, status: 'unknown', prompt: 'Lời nhắc tổng hợp' },
      { id: 'ngắn', lane: 'Opus', start: end - 60_000, end: end - 59_000, status: 'ok', prompt: 'Lời nhắc tổng hợp' },
      { id: 'mép-phải', lane: 'Opus', start: end, end, status: 'ok', prompt: 'Lời nhắc tổng hợp' },
      { id: 'đang-chạy', lane: 'Codex', start: Date.now() - 60_000, end: null, running: true, prompt: 'Lời nhắc tổng hợp' },
    ]; renderChart();
  `);
  const bars = ui.ids.get('chart').querySelectorAll('.run-bar');
  const areaWidth = parseFloat(ui.ids.get('chart').style.width) - 104;
  for (const bar of bars) {
    const left = parseFloat(bar.style.left) / 100 * areaWidth;
    const width = parseFloat(bar.style.width) / 100 * areaWidth;
    assert.ok(left >= 0 && left + width <= areaWidth + 1e-6);
    assert.ok(width >= 6 - 1e-6);
  }
  const continued = bars.find(bar => bar.dataset.id === 'tiếp-tục');
  assert.equal(parseFloat(continued.style.left), 0);
  assert.ok(continued.classList.contains('continued'));
  assert.match(continued.title, /Tiếp tục từ trước/);
  const narrow = bars.find(bar => bar.dataset.id === 'ngắn');
  assert.equal(narrow.textContent, ''); assert.ok(narrow.classList.contains('narrow'));
  const live = bars.find(bar => bar.dataset.id === 'đang-chạy');
  const right = parseFloat(live.style.left) + parseFloat(live.style.width);
  assert.ok(Math.abs(right - 100 * 5 / 6) < .01);
});

test('Phóng to vùng hoạt động ưu tiên thanh được chọn và thẻ dùng title đã che đầy đủ', () => {
  const ui = board();
  ui.evaluate(`
    hours = 24;
    runs = [{ id: 'tổng-hợp', lane: 'Opus', start: end - 600_000, end: end - 300_000 }];
    selected = runs[0];
  `);
  ui.ids.get('focus-activity').listeners.click();
  assert.ok(ui.evaluate('hours') < 1);
  ui.evaluate(`state = { lanes: [{ lane: 'Opus', state: 'Rảnh', prompt: 'Bản ngắn', promptTitle: 'Bản đầy đủ đã che', count24h: 1 }] }; renderCards();`);
  assert.equal(ui.evaluate("cardElements.get('Opus').prompt.title"), 'Bản đầy đủ đã che');
});

test('Bộ lọc đếm dự án chưa rõ, cập nhật lý do và nhóm ngoài Claude có hậu tố riêng', () => {
  const ui = board();
  ui.evaluate(`runs = [
    { projectKey: '(không rõ)', unknownReason: 'Codex: không ghi thư mục làm việc' },
    { projectKey: '(không rõ)', unknownReason: 'cwd không khớp thư mục nào' },
    { projectKey: 'ngoài-claude:d:/tổng-hợp', projectLabel: 'Tổng hợp', outsideClaude: true },
    { projectKey: 'Claude', projectLabel: 'Nội bộ' },
  ]; updateProjects();`);
  const options = ui.ids.get('project-filter').children;
  const unknown = options.find(option => option.value === '(không rõ)');
  assert.equal(unknown.textContent, 'Không rõ dự án (2)');
  assert.match(unknown.title, /Codex: không ghi thư mục làm việc: 1/);
  const outside = options.find(option => option.label === 'Ngoài Claude');
  assert.equal(outside.children[0].textContent, 'Tổng hợp (ngoài Claude)');
  assert.match(ui.ids.get('project-reasons').textContent, /Không rõ dự án \(2\)/);
  ui.evaluate(`runs[0].unknownReason = 'cwd không khớp thư mục nào'; updateProjects();`);
  assert.equal(ui.ids.get('project-filter').children.find(option => option.value === '(không rõ)').title,
    'cwd không khớp thư mục nào: 2');
});

test('Thẻ, thanh, chi tiết và chân trang hiện nguồn, lời giải thích và số chẩn đoán', () => {
  const ui = board();
  ui.evaluate(`
    const explanation = 'Lời nhắc truyền qua stdin, không còn trong lệnh';
    runs = [{ id: 'stdin', lane: 'Codex', kind: 'giao việc', prompt: explanation, promptSource: 'không có',
      projectKey: '(không rõ)', projectLabel: 'Không rõ dự án', unknownReason: 'Codex: không ghi thư mục làm việc',
      start: end - 600_000, end: end - 300_000 }];
    state = { lanes: [{ lane: 'Codex', state: 'Rảnh', prompt: explanation, promptTitle: explanation }],
      scan: { warnings: [], statistics: { codexPrompts: { lệnh: 1, rollout: 2, tệp: 3, 'không có': 4 },
        projects: { known: 6, total: 10, outsideClaude: 2 } } } };
    renderState(); renderChart(); showDetails(runs[0]);
  `);
  assert.match(ui.ids.get('scan-footer').textContent, /Codex: 6\/10 lần giao đọc được lời nhắc \(lệnh 1, rollout 2, tệp 3; không có 4\)/);
  assert.match(ui.ids.get('scan-footer').textContent, /Dự án: 6\/10 lần chạy xác định \(trong đó 2 ngoài thư mục project Claude\)/);
  assert.match(ui.evaluate("cardElements.get('Codex').prompt.textContent"), /Lời nhắc truyền qua stdin/);
  assert.match(ui.ids.get('chart').querySelectorAll('.run-bar')[0].title, /Lời nhắc truyền qua stdin/);
  const fields = ui.ids.get('detail-fields').children;
  assert.equal(fields.find(item => item.children[0].textContent === 'Nguồn lời nhắc').children[1].textContent, 'không có');
  assert.equal(fields.find(item => item.children[0].textContent === 'Dự án').children[1].textContent,
    'không rõ vì Codex: không ghi thư mục làm việc');
});

test('Tên làn dùng chung ở thẻ, bộ lọc, thanh, chi tiết và chú giải; Claude phân biệt bằng chữ và kiểu', () => {
  const ui = board();
  for (const [index, [lane, name]] of Object.entries(modelLabels.LANE_LABELS).entries()) {
    assert.equal(ui.ids.get('cards').children[index].children[0].children[0].textContent, name);
    assert.equal(ui.ids.get('lane-filter').children[index].value, lane);
    assert.equal(ui.ids.get('lane-filter').children[index].textContent, name);
  }
  ui.evaluate(`
    runs = [
      { id: 'sonnet', lane: 'Claude', model: 'claude-sonnet-5-5', kind: 'hoạt động', start: end - 3600_000, end: end - 1000_000 },
      { id: 'opus', lane: 'Claude', model: 'claude-opus-5-5', kind: 'hoạt động', start: end - 3600_000, end: end - 1000_000 },
    ];
    state = { lanes: [{ lane: 'Claude', knownModel: 'claude-sonnet-5-5', state: 'Rảnh', activity24h: 5,
      models24h: { 'claude-sonnet-5-5': 3, 'claude-opus-5-5': 2 } }] };
    renderCards(); renderChart(); showDetails(runs[1]);
  `);
  assert.equal(ui.evaluate("cardElements.get('Claude').model.textContent"), 'Sonnet 5.5');
  assert.equal(ui.evaluate("cardElements.get('Claude').modelSummary.textContent"), '24 giờ: Sonnet 5.5 x 3 đoạn · Opus 5.5 x 2 đoạn');
  const bars = ui.ids.get('chart').querySelectorAll('.run-bar');
  for (const [id, prefix, style] of [['sonnet', 'S 5.5:', 'claude-sonnet'], ['opus', 'O 5.5:', 'claude-opus']]) {
    const bar = bars.find(bar => bar.dataset.id === id);
    assert.ok(bar.textContent.startsWith(prefix)); assert.ok(bar.classList.contains(style));
    assert.match(bar.attributes['aria-label'], /Claude Code/);
  }
  assert.equal(ui.ids.get('detail-title').textContent, 'Claude Code · hoạt động');
  assert.equal(ui.ids.get('detail-fields').children.find(item => item.children[0].textContent === 'Model').children[1].textContent,
    'Opus 5.5 (claude-opus-5-5)');
  assert.equal(ui.ids.get('legend-opus').children.at(-1).textContent, 'Claude Code: Opus 5.5 (O 5.5)');
});

test('Thẻ Codex tách model đã biết và cấu hình; model chưa rõ có giải thích cùng nguồn', () => {
  const ui = board();
  ui.evaluate(`state = { lanes: [{ lane: 'Codex', state: 'Rảnh', model: 'Chưa rõ', knownModel: 'gpt-6.1-sol', effort: 'high' }],
    config: { codexDefault: { model: 'gpt-tổng-hợp', effort: 'low' } },
    scan: { warnings: [], statistics: { codexModels: { rollout: 2, lệnh: 1, 'chưa rõ': 4 } } } };
    renderState();
    showDetails({ lane: 'Codex', kind: 'giao việc', model: '', modelSource: 'chưa rõ', start: end - 1000, end });`);
  assert.equal(ui.evaluate("cardElements.get('Codex').model.textContent"), 'gpt-6.1-sol · high');
  assert.equal(ui.evaluate("cardElements.get('Codex').config.textContent"), 'Cấu hình hiện tại: gpt-tổng-hợp · low');
  assert.match(ui.ids.get('scan-footer').textContent, /Codex: model biết rõ 3\/7 lần giao \(rollout 2, lệnh 1; chưa rõ 4\)/);
  const fields = ui.ids.get('detail-fields').children;
  assert.equal(fields.find(item => item.children[0].textContent === 'Nguồn model').children[1].textContent, 'chưa rõ');
  assert.match(fields.find(item => item.children[0].textContent === 'Model').children[1].textContent, /lệnh không ghi -m, chưa ghép rollout/);
});

test('Làn agy hiện model đẹp và thô; cảnh báo Flash hoặc Sonnet khác tên làn', () => {
  const ui = board();
  ui.evaluate(`runs = [
    { id: 'flash', lane: 'Argon', model: 'gemini-3.5-flash-lite', kind: 'giao việc', start: end - 3000_000, end: end - 1000 },
    { id: 'sonnet', lane: 'Opus', model: 'claude-sonnet-5-5-high', kind: 'giao việc', start: end - 3000_000, end: end - 1000 },
  ]; state = { lanes: runs.map(run => ({ ...run, state: 'Rảnh', knownModel: run.model })) };
  renderCards(); renderChart(); showDetails(runs[0]);`);
  assert.equal(ui.evaluate("cardElements.get('Opus').model.textContent"), 'Sonnet 5.5 · high');
  assert.match(ui.evaluate("cardElements.get('Opus').model.title"), /Sonnet 5.5 · high \(claude-sonnet-5-5-high\)/);
  for (const bar of ui.ids.get('chart').querySelectorAll('.run-bar')) assert.match(bar.title, /model khác tên làn/);
  assert.equal(ui.ids.get('detail-fields').children.find(item => item.children[0].textContent === 'Ghi chú model').children[1].textContent, 'model khác tên làn');
});

test('Bộ lọc Model đếm tên đẹp trong khoảng và lọc chung dòng thời gian, mindmap và Claude bổ sung', () => {
  const ui = board();
  ui.evaluate(`
    window.boardMindmap = { update(filtered, detail, key, claude) { window.mapFiltered = filtered; window.mapClaude = claude; window.mapKey = key; } };
    runs = [
      { id: 'claude', lane: 'Claude', model: 'claude-opus-5-5', projectKey: 'dự-án', start: end - 1000, end },
      { id: 'agy', lane: 'Opus', model: 'claude-opus-5-5-high', projectKey: 'dự-án', start: end - 1000, end },
      { id: 'flash', lane: 'Argon', model: 'gemini-3.5-flash-lite', projectKey: 'dự-án', start: end - 1000, end },
      { id: 'ngoài-khoảng', lane: 'Claude', model: 'claude-sonnet-5-5', start: end - 50_000_000, end: end - 40_000_000 },
    ]; updateModels();
  `);
  const filter = ui.ids.get('model-filter');
  assert.deepEqual(filter.children.map(node => node.textContent), ['Tất cả model', 'Opus 5.5 (2)', 'Gemini 3.5 Flash Lite (1)']);
  filter.value = 'Opus 5.5'; filter.listeners.change();
  assert.deepEqual(ui.ids.get('chart').querySelectorAll('.run-bar').map(bar => bar.dataset.id).sort(), ['agy', 'claude']);
  assert.equal(ui.evaluate('window.mapFiltered.length'), 2); assert.equal(ui.evaluate('window.mapClaude.length'), 1);
  filter.value = 'Gemini 3.5 Flash Lite'; filter.listeners.change();
  assert.equal(ui.evaluate('window.mapFiltered[0].id'), 'flash'); assert.equal(ui.evaluate('window.mapClaude.length'), 0);
  assert.match(ui.evaluate('window.mapKey'), /Gemini 3.5 Flash Lite/);
  ui.evaluate(`runs = runs.filter(run => run.id === 'agy'); updateModels();`);
  assert.equal(filter.value, '');
});

test('Thanh, nhãn làn và thẻ nói rõ giao hay làm, có chấm tại bây giờ và chi tiết đồng bộ', () => {
  const ui = board();
  ui.evaluate(`hours = .05; end = Date.now(); runs = [
    { id: 'vừa-giao', lane: 'Codex', running: true, start: Date.now() - 44000, end: null, kind: 'giao việc' },
    { id: 'đang-làm', lane: 'Opus', running: true, start: Date.now() - 200000, end: null, kind: 'giao việc' },
    { id: 'đã-xong', lane: 'Argon', running: false, start: Date.now() - 210000, end: Date.now() - 10000, kind: 'giao việc', status: 'ok' },
  ]; state = { lanes: runs.map(run => ({ ...run, state: run.running ? 'Đang chạy' : 'Rảnh', activeCount: run.running ? 1 : 0 })) };
  renderCards(); renderChart();`);
  const bars = ui.ids.get('chart').querySelectorAll('.run-bar');
  for (const [id, phase] of [['vừa-giao', 'giao'], ['đang-làm', 'làm']]) {
    const bar = bars.find(node => node.dataset.id === id);
    assert.equal(bar.querySelectorAll('.activity-phase')[0].textContent, `đang ${phase}`);
    assert.equal(bar.querySelectorAll('.run-now-dot').length, 1);
    assert.match(bar.attributes['aria-label'], new RegExp(`đang ${phase}`));
    assert.match(bar.title, new RegExp(`Trạng thái: đang ${phase}`));
  }
  assert.equal(bars.find(node => node.dataset.id === 'đã-xong').querySelectorAll('.run-now-dot').length, 0);
  const labels = ui.ids.get('chart').querySelectorAll('.lane-label');
  assert.equal(labels.filter(label => label.classList.contains('activity-working')).length, 2);
  assert.equal(labels.filter(label => label.querySelectorAll('.activity-dot').length).length, 2);
  assert.match(ui.evaluate("cardElements.get('Codex').elapsed.textContent"), /Vừa giao 44 giây trước/);
  assert.equal(ui.evaluate("cardElements.get('Codex').badgePhase.textContent"), 'đang giao');
  assert.equal(ui.evaluate("cardElements.get('Opus').elapsed.textContent"), 'Đang làm: 3 phút 20 giây');
  assert.ok(ui.evaluate("cardElements.get('Codex').card.classList.contains('activity-working')"));
  ui.evaluate('showDetails(runs[0]);');
  assert.match(ui.ids.get('detail-fields').children.find(item => item.children[0].textContent === 'Trạng thái').children[1].textContent,
    /đang giao \(vừa gửi 44 giây trước\)/);
  ui.evaluate(`runs[0].start -= 2000; state.lanes[0].start = runs[0].start; renderCards(); renderChart();`);
  assert.equal(ui.ids.get('chart').querySelectorAll('.run-bar').find(node => node.dataset.id === 'vừa-giao').querySelectorAll('.activity-phase')[0].textContent, 'đang làm');
  assert.match(ui.evaluate("cardElements.get('Codex').elapsed.textContent"), /Đang làm: 46 giây/);
  assert.equal(ui.evaluate("cardElements.get('Codex').badgePhase.textContent"), 'đang làm');
});

test('Giao chéo dự án dùng chung hàm nhãn và hiển thị ở thẻ, chi tiết, thanh, chú giải, bộ lọc và chân trang', () => {
  const crossSample = {
    id: 'chéo-rộng', lane: 'Argon', model: 'gemini-4-argon-high', kind: 'giao việc',
    projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A', projectPath: 'D:/Workspace/DuAn_A',
    crossProject: true, workProjectKey: 'd--Workspace-DuAn-B', workProjectLabel: 'DuAn_B',
    workProjectPath: 'D:/Workspace/DuAn_B', workProjectOutsideClaude: false,
  };
  assert.equal(crossProject.crossProjectLabel(crossSample), 'Giao từ DuAn_A, làm việc ở DuAn_B');
  assert.equal(crossProject.crossProjectCardText(crossSample), 'DuAn_A → DuAn_B');
  assert.equal(crossProject.crossProjectCardTitle(crossSample), 'Giao từ DuAn_A, làm việc ở DuAn_B (D:\\Workspace\\DuAn_B)');
  assert.equal(
    crossProject.crossProjectDetailText({ ...crossSample, workProjectOutsideClaude: true }),
    'Phiên Claude ở dự án DuAn_A giao việc cho Gemini Argon · high làm việc ở dự án DuAn_B (ngoài Claude) (D:\\Workspace\\DuAn_B)',
  );
  assert.equal(crossProject.crossProjectBarText(crossSample), 'giao chéo sang dự án DuAn_B');
  assert.equal(crossProject.crossProjectLeafText(crossSample), 'giao chéo: làm việc ở dự án DuAn_B');
  assert.equal(crossProject.crossProjectNodeText(3), '3 lần giao chéo sang dự án khác');
  assert.equal(crossProject.crossProjectFooterText({ count: 5, total: 20 }), 'Giao chéo dự án: 5/20 lần giao');
  assert.match(html, /id="legend-cross"[\s\S]*?cross-project-mark[\s\S]*?Mũi tên nhỏ = giao chéo sang dự án khác/);
  assert.match(html, /id="mindmap-legend-cross"[\s\S]*?map-cross-mark[\s\S]*?Mũi tên nhỏ = giao chéo sang dự án khác/);

  const ui = board();
  ui.evaluate(`
    window.boardMindmap = { update(filtered, detail, key, claude) { window.mapFiltered = filtered; window.mapClaude = claude; window.mapKey = key; } };
    hours = 1; end = Date.now();
    runs = [
      {
        id: 'chéo-đang-chạy', lane: 'Argon', model: 'gemini-4-argon-high', kind: 'giao việc', running: true,
        start: end - 1800_000, end: null, prompt: 'Làm việc ở dự án B tổng hợp',
        projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A', projectPath: 'D:/Workspace/DuAn_A',
        crossProject: true, workProjectKey: 'd--Workspace-DuAn-B', workProjectLabel: 'DuAn_B',
        workProjectPath: 'D:/Workspace/DuAn_B', workProjectOutsideClaude: false,
      },
      {
        id: 'chéo-hẹp', lane: 'Opus', model: 'claude-opus-5-5-high', kind: 'giao việc', running: false, status: 'ok',
        start: end - 600_000, end: end - 595_000, prompt: 'Thanh hẹp giao chéo tổng hợp',
        projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A', projectPath: 'D:/Workspace/DuAn_A',
        crossProject: true, workProjectKey: 'ngoài-claude:d:/ngoài', workProjectLabel: 'DuAn_Ngoai',
        workProjectPath: 'D:/Ngoài', workProjectOutsideClaude: true,
      },
      {
        id: 'cùng-dự-án', lane: 'Codex', model: 'gpt-6.1-codex', kind: 'giao việc', running: false, status: 'ok',
        start: end - 1200_000, end: end - 600_000, prompt: 'Cùng dự án A tổng hợp',
        projectKey: 'd--Workspace-DuAn-A', projectLabel: 'DuAn_A', projectPath: 'D:/Workspace/DuAn_A',
        crossProject: false,
      },
    ];
    state = {
      lanes: [
        { ...runs[0], state: 'Đang chạy', activeCount: 1, knownModel: runs[0].model },
        { ...runs[2], state: 'Rảnh', activeCount: 0, knownModel: runs[2].model },
      ],
      scan: {
        initial: false, scannedFiles: 10, totalFiles: 10, durationMs: 100, warnings: [],
        statistics: {
          projects: { known: 3, total: 3, outsideClaude: 0 },
          crossProjects: { count: 2, total: 3 },
        },
      },
    };
    renderState(); renderChart(); showDetails(runs[0]);
  `);
  assert.equal(ui.evaluate("cardElements.get('Argon').project.textContent"), 'DuAn_A → DuAn_B');
  assert.equal(ui.evaluate("cardElements.get('Argon').project.title"), 'Giao từ DuAn_A, làm việc ở DuAn_B (D:\\Workspace\\DuAn_B)');
  assert.ok(ui.evaluate("cardElements.get('Argon').project.classList.contains('cross-project')"));
  assert.equal(ui.evaluate("cardElements.get('Codex').project.textContent"), 'DuAn_A');
  assert.equal(ui.evaluate("cardElements.get('Codex').project.classList.contains('cross-project')"), false);
  assert.match(ui.ids.get('scan-footer').textContent, /Giao chéo dự án: 2\/3 lần giao/);

  const detailFields = ui.ids.get('detail-fields').children;
  const crossField = detailFields.find(item => item.children[0].textContent === 'Giao chéo dự án');
  assert.ok(crossField);
  assert.match(crossField.children[1].textContent, /Phiên Claude ở dự án DuAn_A giao việc cho .* làm việc ở dự án DuAn_B \(D:\\Workspace\\DuAn_B\)/);
  assert.equal(detailFields.find(item => item.children[0].textContent === 'Dự án').children[1].textContent, 'DuAn_A');
  ui.evaluate('showDetails(runs[2]);');
  assert.equal(ui.ids.get('detail-fields').children.find(item => item.children[0].textContent === 'Giao chéo dự án'), undefined);

  const bars = ui.ids.get('chart').querySelectorAll('.run-bar');
  const runningCrossBar = bars.find(bar => bar.dataset.id === 'chéo-đang-chạy');
  assert.ok(runningCrossBar.classList.contains('cross-project'));
  assert.equal(runningCrossBar.querySelectorAll('.cross-project-mark').length, 1);
  assert.equal(runningCrossBar.querySelectorAll('.run-now-dot').length, 1);
  assert.equal(runningCrossBar.querySelectorAll('.activity-phase').length, 1);
  assert.match(runningCrossBar.title, /giao chéo sang dự án DuAn_B/);
  assert.match(runningCrossBar.attributes['aria-label'], /giao chéo sang dự án DuAn_B/);

  const narrowCrossBar = bars.find(bar => bar.dataset.id === 'chéo-hẹp');
  assert.ok(narrowCrossBar.classList.contains('narrow'));
  assert.ok(narrowCrossBar.classList.contains('cross-project'));
  assert.equal(narrowCrossBar.textContent, '');
  assert.equal(narrowCrossBar.querySelectorAll('.cross-project-mark').length, 1);
  assert.match(narrowCrossBar.title, /giao chéo sang dự án DuAn_Ngoai \(ngoài Claude\)/);

  const sameBar = bars.find(bar => bar.dataset.id === 'cùng-dự-án');
  assert.equal(sameBar.classList.contains('cross-project'), false);
  assert.equal(sameBar.querySelectorAll('.cross-project-mark').length, 0);

  const crossFilter = ui.ids.get('cross-filter');
  assert.deepEqual(crossFilter.children.map(node => node.textContent), ['Tất cả', 'Chỉ giao chéo', 'Không giao chéo']);
  crossFilter.value = 'cross'; crossFilter.listeners.change();
  assert.deepEqual(ui.ids.get('chart').querySelectorAll('.run-bar').map(bar => bar.dataset.id).sort(), ['chéo-hẹp', 'chéo-đang-chạy']);
  assert.equal(ui.evaluate('window.mapFiltered.length'), 2);
  assert.match(ui.evaluate('window.mapKey'), /:cross$/);
  crossFilter.value = 'same'; crossFilter.listeners.change();
  assert.deepEqual(ui.ids.get('chart').querySelectorAll('.run-bar').map(bar => bar.dataset.id), ['cùng-dự-án']);
  assert.equal(ui.evaluate('window.mapFiltered.length'), 1);
  assert.match(ui.evaluate('window.mapKey'), /:same$/);
});
