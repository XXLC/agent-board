import { layoutMindmap } from './mindmap-layout.js';
import { LANE_LABELS, crossProjectLeafText, crossProjectNodeText, modelNote, modelText } from './model-labels.js';
import { activityPhase, activityText } from './activity.js';

const $ = id => document.getElementById(id);
const svg = $('mindmap');
svg.setAttribute('aria-label', `Sơ đồ ${LANE_LABELS.Claude} điều phối các lần giao việc`);
const NS = 'http://www.w3.org/2000/svg';
const laneColor = lane => `var(--${(lane || 'Claude').toLowerCase()})`;
const statuses = { ok: 'thành công', error: 'lỗi', quota: 'hết quota', unknown: 'chưa rõ' };
function shape(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
const defs = shape('defs');
for (const lane of ['Codex', 'Opus', 'Argon']) {
  const pattern = shape('pattern', { id: `quota-${lane}`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' });
  pattern.append(shape('rect', { width: 8, height: 8, fill: 'var(--raised)' }));
  pattern.append(shape('path', { d: 'M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6', stroke: laneColor(lane), 'stroke-width': 3 }));
  defs.append(pattern);
}
const edgeLayer = shape('g', { class: 'map-edges', 'aria-hidden': 'true' });
const nodeLayer = shape('g', { class: 'map-nodes' });
svg.append(defs, edgeLayer, nodeLayer);
const nodeElements = new Map(), edgeElements = new Map();
let layout, currentRuns = [], claudeModels = [], filteredCount = 0, showDetails, scope, view, active = false, drag;
const expanded = new Set(), collapsed = new Set();
const seenDelegations = new Set();
let wave = 0, edgeSequence = 0;

function halos(item, radius, color) {
  if (!item.halos) {
    item.halos = [0, 1].map(index => shape('circle', { class: `map-halo halo-${index}`, fill: 'none', 'aria-hidden': 'true' }));
    item.group.append(...item.halos);
  }
  for (const halo of item.halos) {
    halo.setAttribute('r', radius + 4);
    halo.setAttribute('stroke', color);
  }
}

function particles(item) {
  if (item.particles) return;
  item.particles = shape('g', { class: 'map-particles' });
  for (let i = 0; i < 3; i++) item.particles.append(shape('circle', {
    r: 3, class: 'map-packet', style: `animation-delay:${-i * .6}s`,
  }));
  item.group.append(item.particles);
}

function setView() {
  if (view) svg.setAttribute('viewBox', view.join(' '));
}
function center() {
  view = [...layout.bounds];
  setView();
}
function zoom(factor, anchorX = .5, anchorY = .5) {
  if (!view) return;
  const width = Math.min(layout.bounds[2] * 4, Math.max(160, view[2] * factor));
  const ratio = width / view[2];
  view = [view[0] + view[2] * anchorX * (1 - ratio), view[1] + view[3] * anchorY * (1 - ratio), width, view[3] * ratio];
  setView();
}
function activate(node) {
  if (node.type === 'more') expanded.add(node.target);
  else if (node.type === 'lane' || node.type === 'project') {
    if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
  }
  const run = node.type === 'more' ? null : node.run || node.runs?.[0]
    || (node.type === 'root' ? currentRuns.find(run => run.lane === 'Claude') : null);
  if (run) showDetails(run, true);
  if (node.type !== 'run' && node.type !== 'root') {
    draw();
    // Nút gộp biến mất sau khi mở; chuyển tiêu điểm về nút cha còn tồn tại.
    if (node.type === 'more') nodeElements.get(node.target)?.group.focus();
  }
}
function description(node, now = Date.now()) {
  if (node.type === 'run') {
    const run = node.run;
    const status = run.running ? activityText(run, now) : statuses[run.status] || 'chưa rõ';
    return `${LANE_LABELS[run.lane]}, ${modelText(run, true)}, ${run.projectLabel}, ${status}${run.endEstimated ? ', giờ kết thúc ước lượng' : ''}`
      + (modelNote(run) ? `, ${modelNote(run)}` : '')
      + (run.crossProject ? `, ${crossProjectLeafText(run)}` : '')
      + `, ${Array.from(run.prompt || '').slice(0, 200).join('')}`
      + (run.promptSource ? `, nguồn lời nhắc: ${run.promptSource}` : '')
      + (run.unknownReason ? `, không rõ dự án vì ${run.unknownReason}` : '');
  }
  if (node.type === 'more') return `${node.label}, bấm để mở rộng`;
  const action = node.type === 'root' ? 'điều phối' : collapsed.has(node.id) ? 'bấm để mở rộng' : 'bấm để thu gọn';
  return `${node.fullLabel || node.label}, ${node.subtitle || ''}`
    + (node.crossCount ? `, ${crossProjectNodeText(node.crossCount)}` : '')
    + (node.unknownReasons ? `, ${node.unknownReasons}` : '')
    + `${node.running ? `, đang ${node.phase}` : ''}, ${action}`;
}
function draw(reset = false) {
  const now = Date.now();
  layout = layoutMindmap(currentRuns, { previous: reset ? undefined : layout, expanded, collapsed, now, claudeModels });
  const present = new Set(layout.nodes.map(node => node.id));
  for (const [id, item] of nodeElements) if (!present.has(id)) { item.group.remove(); nodeElements.delete(id); }
  const byId = new Map(layout.nodes.map(node => [node.id, node]));
  const fresh = currentRuns.filter(run => run.lane !== 'Claude' && activityPhase(run, now) === 'giao'
    && !seenDelegations.has(`${run.id}:${run.start}`));
  for (const run of fresh) seenDelegations.add(`${run.id}:${run.start}`);
  if (fresh.length) wave = wave === 1 ? 2 : 1;
  // Gợn sóng ở nút gốc chỉ có nghĩa khi còn lần giao mới; hết giao thì về 0 để không phát lại khi chỉ còn "đang làm".
  else if (!layout.nodes.some(node => node.type === 'root' && node.delegating)) wave = 0;
  const edgeIds = new Set();
  for (const edge of layout.edges) {
    edgeIds.add(edge.id);
    let item = edgeElements.get(edge.id);
    if (!item) {
      const clipId = `map-edge-clip-${++edgeSequence}`;
      const group = shape('g'), clip = shape('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
      const rect = shape('rect', { x: 0, y: -8, height: 16 }); clip.append(rect); defs.append(clip);
      const clipped = shape('g', { 'clip-path': `url(#${clipId})` }), line = shape('line', { y1: 0, y2: 0 });
      clipped.append(line);
      const arrow = shape('path', { class: 'map-arrow' }), endDot = shape('circle', { class: 'map-end-dot', r: 3 });
      group.append(clipped, arrow, endDot); edgeLayer.append(group);
      item = { group, line, rect, clip, arrow, endDot }; edgeElements.set(edge.id, item);
    }
    const from = byId.get(edge.from), to = byId.get(edge.to);
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const ux = (to.x - from.x) / distance, uy = (to.y - from.y) / distance;
    const length = Math.max(1, distance - from.r - to.r - 10);
    item.group.setAttribute('transform', `translate(${from.x + ux * (from.r + 5)} ${from.y + uy * (from.r + 5)}) rotate(${Math.atan2(uy, ux) * 180 / Math.PI})`);
    item.group.setAttribute('style', `--lane:${laneColor(edge.lane)};--travel:${length}px`);
    item.group.setAttribute('class', `map-edge${edge.running ? ' activity-working' : ''}${edge.delegating ? ' activity-delegating' : ''}`);
    item.line.setAttribute('x1', edge.running ? -20 : 0);
    item.line.setAttribute('x2', edge.running ? length + 20 : length);
    item.rect.setAttribute('width', length);
    item.line.setAttribute('stroke-width', edge.running ? (edge.from === 'root' ? 3 : 2) : 1.2);
    item.line.setAttribute('class', edge.running ? 'map-flow' : '');
    item.line.setAttribute('stroke', edge.running ? 'var(--activity-color)' : 'var(--line)');
    item.arrow.setAttribute('d', `M${length - 8} -4 L${length} 0 L${length - 8} 4 Z`);
    item.endDot.setAttribute('cx', Math.max(0, length - 14)); // lùi khỏi đỉnh mũi tên để chấm không đè lên mũi tên
    if (edge.delegating) particles(item);
  }
  for (const [id, item] of edgeElements) if (!edgeIds.has(id)) { item.group.remove(); item.clip.remove(); edgeElements.delete(id); }
  for (const node of layout.nodes) {
    let item = nodeElements.get(node.id);
    if (!item) {
      const group = shape('g', { tabindex: 0, role: 'button' });
      const circle = shape('circle'), title = shape('title');
      const label = shape('text', { 'text-anchor': 'middle', y: 4 });
      const subtitle = shape('text', { 'text-anchor': 'middle', y: 23, class: 'map-subtitle' });
      const mark = shape('text', { 'text-anchor': 'middle', y: 5, class: 'map-error-mark' });
      const crossMark = shape('path', { class: 'map-cross-mark', 'aria-hidden': 'true' });
      const phaseLabel = shape('text', { 'text-anchor': 'middle', class: 'map-subtitle map-phase' });
      const badge = shape('g', { class: 'map-running-badge', 'aria-hidden': 'true' });
      badge.append(shape('rect', { x: -58, y: -12, width: 116, height: 24, rx: 12 }),
        shape('circle', { cx: -46, r: 3, class: 'map-badge-dot' }),
        shape('text', { 'text-anchor': 'middle', x: 5, y: 4 }));
      group.append(title, circle, crossMark, label, subtitle, phaseLabel, mark, badge);
      item = { group, circle, crossMark, title, label, subtitle, phaseLabel, mark, badge, node };
      group.addEventListener('click', () => activate(item.node));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item.node); }
      });
      group.addEventListener('pointerenter', () => { if (item.node.run) showDetails(item.node.run); });
      group.addEventListener('focus', () => { if (item.node.run) showDetails(item.node.run); });
      nodeElements.set(node.id, item); nodeLayer.append(group);
    }
    item.node = node;
    const status = node.run?.running ? 'running' : node.run?.status || '';
    const estimated = node.run?.endEstimated ? ' estimated' : '';
    const working = node.running > 0;
    const isCross = node.type === 'run' && Boolean(node.run?.crossProject);
    item.group.setAttribute('class', `map-node map-${node.type} ${status}${estimated}${isCross ? ' cross-project' : ''}${working ? ' activity-working' : ''}${node.delegating ? ' activity-delegating' : ''}${node.type === 'root' && node.delegating && wave ? ` root-wave-${wave}` : ''}`);
    item.group.setAttribute('style', `--lane:${laneColor(node.lane)};--activity-color:color-mix(in srgb,${laneColor(node.lane)} 80%,var(--text))`);
    item.crossMark.setAttribute('display', isCross ? 'inline' : 'none');
    if (isCross) {
      const r = node.r;
      item.crossMark.setAttribute('d', `M${-r - 7} ${-r + 2} L${-r - 1} ${-r + 2} L${-r - 1} ${-r - 1} L${-r + 3} ${-r + 3.5} L${-r - 1} ${-r + 8} L${-r - 1} ${-r + 5} L${-r - 7} ${-r + 5} Z`);
    }
    if ((working && ['root', 'lane', 'run'].includes(node.type)) || (node.type === 'root' && node.delegating && wave)) halos(item, node.r, laneColor(node.lane));
    item.badge.setAttribute('transform', `translate(0 ${-node.r - 18})`);
    item.badge.setAttribute('display', node.type === 'lane' && working ? 'inline' : 'none');
    item.badge.children[2].textContent = `${node.running} đang chạy`;
    item.phaseLabel.textContent = working && ['root', 'lane', 'run'].includes(node.type) ? `đang ${node.phase}` : '';
    item.group.setAttribute('transform', `translate(${node.x} ${node.y})`);
    item.group.setAttribute('aria-label', description(node, now));
    if (node.type === 'project' || node.type === 'lane') item.group.setAttribute('aria-expanded', !collapsed.has(node.id));
    item.group.setAttribute('opacity', node.type === 'lane' && !node.count ? .45 : 1);
    item.circle.setAttribute('r', node.r);
    item.circle.setAttribute('stroke', laneColor(node.lane));
    const fill = node.type === 'run' && status !== 'unknown' && status !== 'error' ? laneColor(node.lane) : 'var(--surface)';
    item.circle.setAttribute('fill', status === 'quota' ? `url(#quota-${node.lane})` : fill);
    item.title.textContent = description(node, now);
    item.label.textContent = node.label || '';
    item.label.setAttribute('y', node.type === 'run' ? node.r + 14 : 4);
    if (node.type === 'run') item.label.setAttribute('class', 'map-run-label');
    if (node.type === 'project' && node.unknownReasons) {
      item.label.setAttribute('textLength', '126'); item.label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    const subtitleLines = node.subtitleLines || [node.subtitle || ''];
    while (item.subtitle.children.length > subtitleLines.length) item.subtitle.children[item.subtitle.children.length - 1].remove();
    subtitleLines.forEach((line, i) => {
      if (!item.subtitle.children[i]) item.subtitle.append(shape('tspan', { x: 0, dy: i ? 14 : 0 }));
      item.subtitle.children[i].textContent = line;
    });
    item.subtitle.setAttribute('y', node.type === 'run' ? node.r + 28 : 23);
    // Nhãn pha nằm ngay dưới dòng phụ đề cuối: nút một dòng giữ y = 40, nút gốc nhiều dòng (model Claude) được đẩy xuống để không đè chữ.
    item.phaseLabel.setAttribute('y', node.type === 'run' ? node.r + 42 : 23 + 14 * (subtitleLines.length - 1) + 17);
    item.mark.textContent = status === 'error' ? 'X' : '';
  }
  $('mindmap-empty').hidden = layout.count > 0;
  if (!view || reset) center();
  if (active) $('run-count').textContent = `${layout.count} lần giao, ${layout.grouped} lần giao đang gộp`;
}
function selectTab() {
  active = location.hash === '#so-do';
  $('timeline-view').hidden = active;
  $('mindmap-view').hidden = !active;
  $('tab-timeline').setAttribute('aria-selected', !active);
  $('tab-mindmap').setAttribute('aria-selected', active);
  for (const id of ['zoom-in', 'zoom-out', 'focus-activity']) $(id).hidden = active;
  $('timeline-title').textContent = active ? 'Sơ đồ' : 'Dòng thời gian';
  if (active && (layout || currentRuns.length)) draw(!layout);
  if (!active) $('run-count').textContent = `${filteredCount} thanh hoạt động`;
}
$('tab-timeline').addEventListener('click', () => { location.hash = 'dong-thoi-gian'; });
$('tab-mindmap').addEventListener('click', () => { location.hash = 'so-do'; });
window.addEventListener('hashchange', selectTab);
$('map-zoom-in').addEventListener('click', () => zoom(.75));
$('map-zoom-out').addEventListener('click', () => zoom(1 / .75));
$('map-center').addEventListener('click', center);
$('map-reorder').addEventListener('click', () => draw(true));
svg.addEventListener('wheel', event => {
  event.preventDefault();
  const box = svg.getBoundingClientRect();
  zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
}, { passive: false });
svg.addEventListener('pointerdown', event => {
  if (event.target.closest('[role="button"]') || !view) return;
  drag = { x: event.clientX, y: event.clientY, view: [...view] };
  svg.setPointerCapture(event.pointerId);
});
svg.addEventListener('pointermove', event => {
  if (!drag) return;
  const box = svg.getBoundingClientRect();
  const scale = Math.max(drag.view[2] / box.width, drag.view[3] / box.height);
  view = [drag.view[0] - (event.clientX - drag.x) * scale, drag.view[1] - (event.clientY - drag.y) * scale, ...drag.view.slice(2)];
  setView();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(event, () => { drag = null; });
window.boardMindmap = {
  update(runs, detail, key, claudeRuns = [], knownClaudeModels = []) {
    filteredCount = runs.length; claudeModels = knownClaudeModels;
    const ids = new Set(runs.map(run => run.id));
    currentRuns = [...runs, ...claudeRuns.filter(run => !ids.has(run.id))]; showDetails = detail;
    const reset = scope !== key;
    if (reset) { layout = undefined; expanded.clear(); collapsed.clear(); }
    scope = key;
    // Tab Sơ đồ đang ẩn thì không tính bố cục và vẽ mỗi giây (đắt, không ai thấy); vẽ ngay khi chuyển sang tab này.
    if (!active) { $('run-count').textContent = `${filteredCount} thanh hoạt động`; return; }
    draw(reset);
  },
};
selectTab();
window.dispatchEvent(new Event('mindmap-ready'));
