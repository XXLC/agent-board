import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { layoutMindmap, isBrowserFullscreen } from '../public/mindmap-layout.js';
import * as modelLabels from '../public/model-labels.js';
import * as activity from '../public/activity.js';
import * as counters from '../public/counters.js';
import { createWakeLock } from '../public/wake-lock.js';

const mindmapSource = (await readFile(new URL('../public/mindmap.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '');
const htmlSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

function createHarness(initialHash = '#so-do', navigator) {
  let clock = 1_793_577_600_000;
  class Clock extends Date { static now() { return clock; } }
  const ids = new Map(), windowEvents = new Map(), docEvents = new Map();
  class Node {
    constructor(tagName = 'DIV') {
      this.tagName = tagName;
      this.children = [];
      this.attributes = {};
      this.events = {};
      this.textContent = '';
      this.className = '';
      this.scrollLeft = 0;
      this.classList = {
        contains: name => this.className.split(/\s+/).filter(Boolean).includes(name),
        toggle: (name, enabled) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          const next = enabled === undefined ? !set.has(name) : Boolean(enabled);
          if (next) set.add(name); else set.delete(name);
          this.className = [...set].join(' ');
          this.attributes.class = this.className;
        },
      };
    }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key === 'class') this.className = String(value);
    }
    getAttribute(key) { return this.attributes[key]; }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }
    addEventListener(key, handler) { this.events[key] = handler; }
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 1280, height: 720 }; }
    setPointerCapture() {}
    closest(selector) {
      if (selector === '[role="button"]' && this.attributes.role === 'button') return this;
      return this.parent?.closest?.(selector) || null;
    }
    focus() { this.focused = true; }
  }
  for (const [, id] of htmlSource.matchAll(/id="([^"]+)"/g)) ids.set(id, new Node());
  if (ids.get('clear-detail')) ids.get('clear-detail').hidden = true;
  if (ids.get('map-legend-toggle')) ids.get('map-legend-toggle').hidden = true;
  if (ids.get('wake-lock-status')) ids.get('wake-lock-status').hidden = true;

  let mediaMatches = false;
  const mediaListeners = [];
  const mediaQuery = {
    get matches() { return mediaMatches; },
    addEventListener(type, fn) { if (type === 'change') mediaListeners.push(fn); },
  };

  let fsReject = false;
  const fsCalls = { stage: 0, docElement: 0, exit: 0 };
  const documentElement = new Node('HTML');
  documentElement.requestFullscreen = () => {
    fsCalls.docElement++;
    return Promise.resolve();
  };

  const stage = ids.get('map-stage');
  stage.requestFullscreen = () => {
    fsCalls.stage++;
    if (fsReject) return Promise.reject(new Error('Bị chặn'));
    document.fullscreenElement = stage;
    return Promise.resolve();
  };

  const document = {
    hidden: false,
    documentElement,
    fullscreenElement: null,
    activeElement: null,
    createElementNS: (_, tag) => new Node(tag),
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, new Node());
      return ids.get(id);
    },
    addEventListener: (event, handler) => docEvents.set(event, handler),
    exitFullscreen: () => {
      fsCalls.exit++;
      document.fullscreenElement = null;
      return Promise.resolve();
    },
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    screen: { width: 1920, height: 1080 },
    addEventListener: (event, handler) => windowEvents.set(event, handler),
    dispatchEvent() {},
    matchMedia: () => mediaQuery,
    scrollTo(x, y) { window.scrollX = x; window.scrollY = y; },
  };
  const location = { hash: initialHash };
  const context = vm.createContext({
    ...modelLabels, ...activity, ...counters, createWakeLock, navigator, document, window, location,
    Event: class {}, layoutMindmap, Date: Clock,
  });
  vm.runInContext(mindmapSource, context);
  const evaluate = code => vm.runInContext(code, context);
  return {
    ids, document, documentElement, window, windowEvents, docEvents, location,
    fsCalls, evaluate, Node,
    setFsReject(val) { fsReject = val; },
    setMediaFullscreen(val) {
      mediaMatches = val;
      for (const fn of mediaListeners) fn();
    },
    advance(ms) { clock += ms; },
  };
}

const sampleRun = {
  id: 'run-1', lane: 'Codex', kind: 'giao việc', projectKey: 'du-an-a', projectLabel: 'DuAn_A',
  start: 1_793_577_540_000, end: null, running: true, prompt: 'Lời nhắc tổng hợp', status: 'unknown',
};

test('Chỉ chế độ chỉ sơ đồ mới xin Wake Lock; F11, nút và toàn màn hình trình duyệt cùng nhả khi thoát', async () => {
  let requests = 0, releases = 0;
  const navigator = { wakeLock: { request() {
    requests++;
    return Promise.resolve({ addEventListener() {}, release() { releases++; return Promise.resolve(); } });
  } } };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const ui = createHarness('#so-do', navigator);
  ui.window.boardMindmap.update([sampleRun], () => {}, 'khóa');
  await settle(); assert.equal(requests, 0);
  assert.equal(ui.ids.get('wake-lock-status').hidden, true);
  ui.docEvents.get('keydown')({ key: 'F11', preventDefault() {} });
  await settle(); assert.equal(requests, 1);
  assert.equal(ui.ids.get('wake-lock-status').textContent, 'Giữ màn hình sáng: bật');
  assert.equal(ui.ids.get('wake-lock-status').hidden, false);
  assert.match(ui.ids.get('map-status').textContent, /Giữ màn hình sáng: bật/);
  ui.docEvents.get('keydown')({ key: 'F11', preventDefault() {} });
  await settle(); assert.equal(releases, 1); assert.equal(ui.ids.get('wake-lock-status').hidden, true);
  ui.ids.get('map-fullscreen').events.click(); await settle(); assert.equal(requests, 2);
  ui.ids.get('map-fullscreen').events.click(); await settle(); assert.equal(releases, 2);
  ui.setMediaFullscreen(true); await settle(); assert.equal(requests, 3);
  ui.setMediaFullscreen(false); await settle(); assert.equal(releases, 3);
});

test('Wake Lock không hỗ trợ và lỗi chính sách không làm hỏng chế độ chỉ sơ đồ', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = createHarness('#so-do');
  ui.window.boardMindmap.setMapOnly(true);
  assert.equal(ui.ids.get('wake-lock-status').textContent, 'Giữ màn hình sáng: không hỗ trợ');
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  ui.window.boardMindmap.setMapOnly(false);
  const blocked = createHarness('#so-do', { wakeLock: { request() { return Promise.reject(new Error('Chính sách chặn')); } } });
  blocked.window.boardMindmap.setMapOnly(true);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(blocked.ids.get('wake-lock-status').textContent, 'Giữ màn hình sáng: bị chặn');
  assert.match(blocked.ids.get('wake-lock-status').title, /tối đa ba lần/);
  assert.equal(blocked.documentElement.classList.contains('map-only'), true);
  blocked.window.boardMindmap.setMapOnly(false);
});

test('isBrowserFullscreen kiểm tra kích thước khớp, lệch 2 px, cửa sổ nhỏ hơn và display-mode fullscreen', () => {
  assert.equal(isBrowserFullscreen, modelLabels.isBrowserFullscreen);
  assert.equal(isBrowserFullscreen({ innerWidth: 1920, innerHeight: 1080 }, { width: 1920, height: 1080 }, false), true);
  assert.equal(isBrowserFullscreen({ innerWidth: 1920, innerHeight: 1078 }, { width: 1920, height: 1080 }, false), true);
  assert.equal(isBrowserFullscreen({ innerWidth: 1918, innerHeight: 1082 }, { width: 1920, height: 1080 }, false), true);
  assert.equal(isBrowserFullscreen({ innerWidth: 1920, innerHeight: 1077 }, { width: 1920, height: 1080 }, false), false);
  assert.equal(isBrowserFullscreen({ innerWidth: 1280, innerHeight: 720 }, { width: 1920, height: 1080 }, false), false);
  assert.equal(isBrowserFullscreen({ innerWidth: 1280, innerHeight: 720 }, { width: 1920, height: 1080 }, true), true);
  assert.equal(isBrowserFullscreen(null, null, false), false);
});

test('F11 gọi preventDefault và requestFullscreen trên phần tử bao sơ đồ (không phải documentElement), bỏ qua phím bổ trợ và ô nhập', () => {
  const ui = createHarness('#so-do');
  ui.window.boardMindmap.update([sampleRun], () => {}, 'scope-1');
  const keydown = ui.docEvents.get('keydown');

  for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    let prevented = false;
    keydown({ key: 'F11', ...mod, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(ui.fsCalls.stage, 0);
  }

  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    let prevented = false;
    keydown({ key: 'F11', target: { tagName: tag }, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(ui.fsCalls.stage, 0);
  }
  let editablePrevented = false;
  keydown({ key: 'F11', target: { tagName: 'DIV', isContentEditable: true }, preventDefault() { editablePrevented = true; } });
  assert.equal(editablePrevented, false);

  let f11Prevented = false;
  keydown({ key: 'F11', target: { tagName: 'BODY' }, preventDefault() { f11Prevented = true; } });
  assert.equal(f11Prevented, true);
  assert.equal(ui.fsCalls.stage, 1);
  assert.equal(ui.fsCalls.docElement, 0, 'Không được gọi requestFullscreen trên documentElement');
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  assert.equal(ui.ids.get('map-stage').attributes.role, 'region');
  assert.equal(ui.ids.get('map-stage').attributes['aria-label'], 'Sơ đồ toàn màn hình');
  assert.equal(ui.ids.get('map-fullscreen').textContent, 'Thoát toàn màn hình');
  assert.equal(ui.ids.get('map-fullscreen').attributes['aria-pressed'], 'true');
  assert.match(ui.ids.get('map-status').textContent, /Đã vào chế độ chỉ sơ đồ/);

  // Bấm F11 lần nữa để thoát.
  keydown({ key: 'F11', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(ui.fsCalls.exit, 1);
  assert.equal(ui.documentElement.classList.contains('map-only'), false);
  assert.equal(ui.ids.get('map-fullscreen').textContent, 'Toàn màn hình');
  assert.equal(ui.ids.get('map-fullscreen').attributes['aria-pressed'], 'false');
  assert.match(ui.ids.get('map-status').textContent, /Đã thoát/);
});

test('Đang ở tab Dòng thời gian bấm F11 chuyển sang Sơ đồ và khôi phục tab cũ cùng vị trí cuộn khi thoát', () => {
  const ui = createHarness('#dong-thoi-gian');
  ui.window.boardMindmap.update([sampleRun], () => {}, 'scope-tab');
  ui.window.scrollX = 40;
  ui.window.scrollY = 180;
  ui.ids.get('chart-shell').scrollLeft = 320;
  assert.equal(ui.ids.get('mindmap-view').hidden, true);
  assert.equal(ui.ids.get('timeline-view').hidden, false);

  const keydown = ui.docEvents.get('keydown');
  keydown({ key: 'F11', preventDefault() {} });
  assert.equal(ui.location.hash, '#so-do');
  assert.equal(ui.ids.get('mindmap-view').hidden, false);
  assert.equal(ui.ids.get('timeline-view').hidden, true);
  assert.equal(ui.documentElement.classList.contains('map-only'), true);

  // Giả lập cuộn bị lệch trong lúc toàn màn hình rồi bấm F11 thoát.
  ui.window.scrollY = 0;
  ui.ids.get('chart-shell').scrollLeft = 0;
  keydown({ key: 'F11', preventDefault() {} });
  assert.equal(ui.location.hash, '#dong-thoi-gian');
  assert.equal(ui.ids.get('mindmap-view').hidden, true);
  assert.equal(ui.ids.get('timeline-view').hidden, false);
  assert.equal(ui.window.scrollY, 180);
  assert.equal(ui.ids.get('chart-shell').scrollLeft, 320);
});

test('fullscreenchange đồng bộ lớp map-only, nhãn nút và trạng thái chú giải thu gọn', () => {
  const ui = createHarness('#so-do');
  ui.window.boardMindmap.update([sampleRun], () => {}, 'scope-sync');
  const fsChange = ui.docEvents.get('fullscreenchange');

  ui.document.fullscreenElement = ui.ids.get('map-stage');
  fsChange();
  assert.equal(ui.fsCalls.stage, 0, 'fullscreenchange không được gọi lại requestFullscreen gây vòng lặp');
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  assert.equal(ui.ids.get('map-fullscreen').textContent, 'Thoát toàn màn hình');
  assert.equal(ui.ids.get('map-legend-toggle').hidden, false);
  assert.equal(ui.ids.get('mindmap-legend').hidden, true, 'chú giải thu gọn mặc định trong chế độ chỉ sơ đồ');

  ui.ids.get('map-legend-toggle').events.click();
  assert.equal(ui.ids.get('mindmap-legend').hidden, false);
  assert.equal(ui.ids.get('map-legend-toggle').attributes['aria-pressed'], 'true');

  ui.document.fullscreenElement = null;
  fsChange();
  assert.equal(ui.documentElement.classList.contains('map-only'), false);
  assert.equal(ui.ids.get('map-fullscreen').textContent, 'Toàn màn hình');
  assert.equal(ui.ids.get('map-legend-toggle').hidden, true);
  assert.equal(ui.ids.get('mindmap-legend').hidden, false, 'thoát toàn màn hình chú giải hiện lại bình thường');
});

test('Esc hai bậc: lần một đóng lớp phủ chi tiết, lần hai mới thoát toàn màn hình', () => {
  const ui = createHarness('#so-do');
  const opened = [];
  ui.window.boardMindmap.update([sampleRun], run => opened.push(run.id), 'scope-esc');
  const keydown = ui.docEvents.get('keydown');

  keydown({ key: 'F11', preventDefault() {} });
  assert.equal(ui.documentElement.classList.contains('map-only'), true);

  // Bấm vào lá để mở chi tiết dạng lớp phủ.
  const leaf = ui.evaluate("nodeElements.get('run:run-1').group");
  leaf.events.click();
  assert.deepEqual(opened, ['run-1']);
  assert.equal(ui.ids.get('clear-detail').hidden, false);
  assert.equal(ui.ids.get('details').classList.contains('open'), true);

  // Esc lần 1: chỉ đóng chi tiết, vẫn ở chế độ toàn màn hình.
  let esc1Prevented = false;
  keydown({ key: 'Escape', preventDefault() { esc1Prevented = true; } });
  assert.equal(esc1Prevented, true);
  assert.equal(ui.ids.get('clear-detail').hidden, true);
  assert.equal(ui.ids.get('details').classList.contains('open'), false);
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  assert.equal(ui.fsCalls.exit, 0);

  // Esc lần 2: thoát toàn màn hình.
  let esc2Prevented = false;
  keydown({ key: 'Escape', preventDefault() { esc2Prevented = true; } });
  assert.equal(esc2Prevented, true);
  assert.equal(ui.documentElement.classList.contains('map-only'), false);
  assert.equal(ui.fsCalls.exit, 1);
});

test('requestFullscreen bị từ chối vẫn áp dụng bố cục map-only bằng CSS và hiện thông báo không chặn', async () => {
  const ui = createHarness('#so-do');
  ui.window.boardMindmap.update([sampleRun], () => {}, 'scope-reject');
  ui.setFsReject(true);

  ui.ids.get('map-fullscreen').events.click();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ui.fsCalls.stage, 1);
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  assert.match(ui.ids.get('map-status').textContent, /Trình duyệt chặn toàn màn hình/);
  assert.equal(ui.ids.get('map-status').classList.contains('map-status-toast'), true);

  // Thoát bằng nút vẫn hoạt động.
  ui.ids.get('map-fullscreen').events.click();
  assert.equal(ui.documentElement.classList.contains('map-only'), false);
});

test('Phát hiện toàn màn hình mức trình duyệt qua resize/matchMedia và không bật chồng với Fullscreen API', () => {
  const ui = createHarness('#so-do');
  ui.window.boardMindmap.update([sampleRun], () => {}, 'scope-browser-fs');
  const onResize = ui.windowEvents.get('resize');

  // Cửa sổ khớp màn hình (sai số 2 px) -> bật map-only mà không gọi requestFullscreen.
  ui.window.innerWidth = 1920;
  ui.window.innerHeight = 1079;
  onResize();
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  assert.equal(ui.fsCalls.stage, 0);

  // Thu nhỏ cửa sổ về bình thường -> tự thoát map-only.
  ui.window.innerWidth = 1280;
  ui.window.innerHeight = 720;
  onResize();
  assert.equal(ui.documentElement.classList.contains('map-only'), false);

  // Bật qua matchMedia('(display-mode: fullscreen)').
  ui.setMediaFullscreen(true);
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  ui.setMediaFullscreen(false);
  assert.equal(ui.documentElement.classList.contains('map-only'), false);

  // Khi đang dùng Fullscreen API, sự kiện resize với kích thước màn hình rồi thu nhỏ không được tự tắt chế độ API trước khi fullscreenchange.
  ui.docEvents.get('keydown')({ key: 'F11', preventDefault() {} });
  assert.equal(ui.documentElement.classList.contains('map-only'), true);
  ui.window.innerWidth = 1920;
  ui.window.innerHeight = 1080;
  onResize();
  ui.window.innerWidth = 1280;
  ui.window.innerHeight = 720;
  onResize();
  assert.equal(ui.documentElement.classList.contains('map-only'), true, 'Đang ở Fullscreen API thì resize không được tự ý tắt map-only');
});

test('Giữ viewBox, pan/zoom, trạng thái mở rộng khi vào/ra toàn màn hình và SSE không dựng lại nút', () => {
  const ui = createHarness('#so-do');
  ui.window.boardMindmap.update([sampleRun], () => {}, 'scope-keep');
  const leafGroup = ui.evaluate("nodeElements.get('run:run-1').group");
  const laneGroup = ui.evaluate("nodeElements.get('lane:Codex').group");

  // Zoom thủ công và thu gọn một làn khác.
  ui.ids.get('map-zoom-in').events.click();
  const zoomedViewBox = ui.ids.get('mindmap').attributes.viewBox;
  const opusLane = ui.evaluate("nodeElements.get('lane:Opus').group");
  opusLane.events.click();
  assert.equal(opusLane.attributes['aria-expanded'], 'false');

  // Vào toàn màn hình: giữ nguyên viewBox đã zoom và trạng thái thu gọn.
  ui.docEvents.get('keydown')({ key: 'F11', preventDefault() {} });
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, zoomedViewBox);
  assert.equal(opusLane.attributes['aria-expanded'], 'false');

  // SSE cập nhật trong chế độ toàn màn hình: không dựng lại nút, không mất viewBox.
  ui.window.boardMindmap.update([{ ...sampleRun, running: false, status: 'ok', end: 1_793_577_590_000 }], () => {}, 'scope-keep');
  assert.equal(ui.evaluate("nodeElements.get('run:run-1').group"), leafGroup);
  assert.equal(ui.evaluate("nodeElements.get('lane:Codex').group"), laneGroup);
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, zoomedViewBox);

  // Thoát toàn màn hình: vẫn giữ nguyên viewBox và trạng thái thu gọn.
  ui.docEvents.get('keydown')({ key: 'F11', preventDefault() {} });
  assert.equal(ui.ids.get('mindmap').attributes.viewBox, zoomedViewBox);
  assert.equal(opusLane.attributes['aria-expanded'], 'false');
});

test('Đường nối giao chéo: ưu tiên nút đích cùng làn, fallback làn khác, thẻ "→ nhãn" khi nút đích ẩn', () => {
  const ui = createHarness('#so-do');
  const runs = [
    {
      ...sampleRun, id: 'cheo-cung-lan', lane: 'Codex', running: false, status: 'ok', end: sampleRun.start + 5000,
      projectKey: 'du-an-a', projectLabel: 'DuAn_A',
      crossProject: true, workProjectKey: 'du-an-b', workProjectLabel: 'DuAn_B',
    },
    {
      ...sampleRun, id: 'muc-tieu-cung-lan', lane: 'Codex', running: false, status: 'ok', end: sampleRun.start + 5000,
      projectKey: 'du-an-b', projectLabel: 'DuAn_B', crossProject: false,
    },
    {
      ...sampleRun, id: 'muc-tieu-lan-khac', lane: 'Opus', running: false, status: 'ok', end: sampleRun.start + 5000,
      projectKey: 'du-an-b', projectLabel: 'DuAn_B', crossProject: false,
    },
    {
      ...sampleRun, id: 'cheo-lan-khac', lane: 'Codex', running: false, status: 'ok', end: sampleRun.start + 5000,
      projectKey: 'du-an-a', projectLabel: 'DuAn_A',
      crossProject: true, workProjectKey: 'du-an-c', workProjectLabel: 'DuAn_C',
    },
    {
      ...sampleRun, id: 'muc-tieu-c-opus', lane: 'Opus', running: false, status: 'ok', end: sampleRun.start + 5000,
      projectKey: 'du-an-c', projectLabel: 'DuAn_C', crossProject: false,
    },
    {
      ...sampleRun, id: 'cheo-an', lane: 'Argon', running: false, status: 'ok', end: sampleRun.start + 5000,
      projectKey: 'du-an-a', projectLabel: 'DuAn_A',
      crossProject: true, workProjectKey: 'du-an-ngoai', workProjectLabel: 'DuAn_Ngoai', workProjectOutsideClaude: true,
    },
  ];
  ui.window.boardMindmap.update(runs, () => {}, 'scope-cross');

  // 1. Bấm lá chéo có dự án đích ở cả cùng làn (Codex) và làn khác (Opus) -> ưu tiên cùng làn Codex.
  const leafSameLane = ui.evaluate("nodeElements.get('run:cheo-cung-lan').group");
  leafSameLane.events.click();
  const linkSame = ui.evaluate("crossElements.get('run:cheo-cung-lan')");
  assert.ok(linkSame);
  assert.equal(linkSame.group.attributes.display, 'inline');
  assert.equal(linkSame.group.attributes['data-target'], 'project:Codex:du-an-b');
  assert.equal(linkSame.group.attributes['data-mode'], 'node');
  assert.equal(linkSame.tag.attributes.display, 'none');
  assert.match(linkSame.path.attributes.d, /^M .* Q .* .*$/);
  assert.equal(linkSame.title.textContent, 'giao chéo: DuAn_A → DuAn_B');
  assert.match(leafSameLane.attributes['aria-label'], /đang hiện đường nối sang dự án DuAn_B/);

  // 2. Chọn lá chéo mà dự án đích chỉ có ở làn khác (Opus) -> đường cũ ẩn, đường mới nối sang làn Opus.
  const leafOtherLane = ui.evaluate("nodeElements.get('run:cheo-lan-khac').group");
  leafOtherLane.events.click();
  assert.equal(linkSame.group.attributes.display, 'none', 'Chọn lá khác thì đường cũ phải ẩn');
  assert.doesNotMatch(leafSameLane.attributes['aria-label'], /đang hiện đường nối/);
  const linkOther = ui.evaluate("crossElements.get('run:cheo-lan-khac')");
  assert.equal(linkOther.group.attributes.display, 'inline');
  assert.equal(linkOther.group.attributes['data-target'], 'project:Opus:du-an-c');
  assert.equal(linkOther.group.attributes['data-mode'], 'node');

  // 3. Nếu thu gọn làn Opus làm nút dự án đích DuAn_C biến mất -> chuyển sang thẻ nhỏ "→ DuAn_C" cạnh lá.
  ui.evaluate("nodeElements.get('lane:Opus').group").events.click();
  assert.equal(linkOther.group.attributes['data-target'], '');
  assert.equal(linkOther.group.attributes['data-mode'], 'tag');
  assert.equal(linkOther.tag.attributes.display, 'inline');
  assert.equal(linkOther.tagText.textContent, '→ DuAn_C');

  // 4. Chọn lá chéo có dự án đích không có trong sơ đồ -> hiện thẻ "→ DuAn_Ngoai (ngoài Claude)".
  const leafHiddenTarget = ui.evaluate("nodeElements.get('run:cheo-an').group");
  leafHiddenTarget.events.click();
  assert.equal(linkOther.group.attributes.display, 'none');
  const linkTag = ui.evaluate("crossElements.get('run:cheo-an')");
  assert.equal(linkTag.group.attributes.display, 'inline');
  assert.equal(linkTag.group.attributes['data-mode'], 'tag');
  assert.equal(linkTag.group.attributes['data-target'], '');
  assert.equal(linkTag.tag.attributes.display, 'inline');
  assert.equal(linkTag.tagText.textContent, '→ DuAn_Ngoai (ngoài Claude)');
  assert.equal(linkTag.tagTitle.textContent, 'giao chéo: DuAn_A → DuAn_Ngoai (ngoài Claude)');

  // 5. Bấm lại chính lá đó thì ẩn.
  leafHiddenTarget.events.click();
  assert.equal(linkTag.group.attributes.display, 'none');

  // 6. Bấm lại để hiện rồi bấm nền SVG thì ẩn.
  leafHiddenTarget.events.click();
  assert.equal(linkTag.group.attributes.display, 'inline');
  ui.ids.get('mindmap').events.click({ target: ui.ids.get('mindmap') });
  assert.equal(linkTag.group.attributes.display, 'none');

  // 7. Bấm lá không giao chéo -> không tạo đường nối.
  const normalLeaf = ui.evaluate("nodeElements.get('run:muc-tieu-cung-lan').group");
  normalLeaf.events.click();
  assert.equal(ui.evaluate("crossElements.has('run:muc-tieu-cung-lan')"), false);
});

test('Đường nối giao chéo: tự hiện khi đang chạy, tắt khi xong (trừ đang chọn), giữ tham chiếu qua SSE và cập nhật toạ độ khi sắp xếp lại', () => {
  const ui = createHarness('#so-do');
  const runningCross = {
    ...sampleRun, id: 'cheo-chay', lane: 'Codex', running: true,
    projectKey: 'du-an-a', projectLabel: 'DuAn_A',
    crossProject: true, workProjectKey: 'du-an-b', workProjectLabel: 'DuAn_B',
  };
  const targetRun = {
    ...sampleRun, id: 'dich-b', lane: 'Codex', running: false, status: 'ok', end: sampleRun.start + 5000,
    projectKey: 'du-an-b', projectLabel: 'DuAn_B', crossProject: false,
  };
  ui.window.boardMindmap.update([runningCross, targetRun], () => {}, 'scope-live-cross');

  // Tự động hiện khi đang chạy mà chưa cần bấm.
  const link = ui.evaluate("crossElements.get('run:cheo-chay')");
  assert.ok(link);
  assert.equal(link.group.attributes.display, 'inline');
  assert.match(link.group.attributes.class, /running.*activity-working/);
  assert.match(link.path.attributes.class, /map-flow/);

  // Vừa đang chạy vừa bấm chọn -> vẫn chỉ đúng 1 đường nối (cùng phần tử).
  const leafGroup = ui.evaluate("nodeElements.get('run:cheo-chay').group");
  leafGroup.events.click();
  assert.equal(ui.evaluate('crossElements.size'), 1);
  assert.equal(ui.evaluate("crossElements.get('run:cheo-chay')"), link);
  assert.match(link.group.attributes.class, /selected/);

  // Run xong nhưng đang được chọn -> vẫn hiện nhưng tắt hiệu ứng chạy.
  const finishedCross = { ...runningCross, running: false, status: 'ok', end: sampleRun.start + 20_000 };
  ui.window.boardMindmap.update([finishedCross, targetRun], () => {}, 'scope-live-cross');
  assert.equal(ui.evaluate("crossElements.get('run:cheo-chay')"), link, 'SSE không được dựng lại phần tử đường nối');
  assert.equal(link.group.attributes.display, 'inline');
  assert.doesNotMatch(link.group.attributes.class, /running/);
  assert.doesNotMatch(link.path.attributes.class, /map-flow/);

  // Bỏ chọn rồi run chạy lại -> xong khi không chọn thì tự ẩn.
  leafGroup.events.click();
  assert.equal(link.group.attributes.display, 'none');
  ui.window.boardMindmap.update([runningCross, targetRun], () => {}, 'scope-live-cross');
  assert.equal(link.group.attributes.display, 'inline');
  ui.window.boardMindmap.update([finishedCross, targetRun], () => {}, 'scope-live-cross');
  assert.equal(link.group.attributes.display, 'none');

  // Chọn lại và kiểm tra toạ độ cập nhật khi nút di chuyển / sắp xếp lại.
  leafGroup.events.click();
  const initialPath = link.path.attributes.d;
  // Dịch vị trí nút dự án đích trong layout cũ rồi gọi sắp xếp lại với thêm dữ liệu để đổi góc cung.
  const extraRuns = Array.from({ length: 12 }, (_, i) => ({
    ...targetRun, id: `phu-${i}`, lane: 'Opus', projectKey: `p-${i}`, projectLabel: `P_${i}`,
  }));
  ui.window.boardMindmap.update([finishedCross, targetRun, ...extraRuns], () => {}, 'scope-live-cross');
  ui.ids.get('map-reorder').events.click();
  assert.equal(ui.evaluate("crossElements.get('run:cheo-chay')"), link);
  assert.notEqual(link.path.attributes.d, initialPath, 'Toạ độ đường nối phải cập nhật sau khi sắp xếp lại');
});

test('HTML và CSS có vùng #map-counters rỗng, mục chú giải đường cong đứt mới và quy tắc giảm chuyển động tĩnh', () => {
  assert.match(htmlSource, /<div id="map-counters" class="map-counters"><\/div>/);
  assert.match(cssSource, /#map-counters:empty\s*\{\s*display:none\s*\}/);
  assert.match(htmlSource, /id="mindmap-legend-cross-link"[\s\S]*?map-cross-path[\s\S]*?Nét cong đứt = lần giao chéo sang dự án khác/);
  const reduced = cssSource.slice(cssSource.lastIndexOf('@media(prefers-reduced-motion:reduce)'));
  assert.match(reduced, /\.map-cross-link \.map-cross-path/);
  assert.match(reduced, /stroke-dasharray:8 6/);
  assert.match(reduced, /\.map-cross-link \.map-cross-arrow/);
});
