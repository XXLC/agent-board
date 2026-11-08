import { layoutMindmap, nodeTextRows, compensatedFont, rowVisible } from './mindmap-layout.js';
import { LANE_LABELS, crossProjectActiveText, crossProjectLeafText, crossProjectLinkText, crossProjectNodeText } from './model-labels.js';
import { isBrowserFullscreen, modelNote, modelText, workProjectDisplay } from './model-labels.js';
import { activityPhase, activityText } from './activity.js';
import { formatDuration, formatTokens, tokenBreakdown } from './counters.js';
import { createWakeLock } from './wake-lock.js';

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
function toggleClass(el, name, enabled) {
  if (!el) return;
  if (el.classList?.toggle) { el.classList.toggle(name, enabled); return; }
  const set = new Set(String(el.className || el.attributes?.class || '').split(/\s+/).filter(Boolean));
  if (enabled) set.add(name); else set.delete(name);
  const next = [...set].join(' ');
  el.className = next; el.setAttribute?.('class', next);
}
function hasClass(el, name) {
  if (!el) return false;
  if (el.classList?.contains) return el.classList.contains(name);
  return String(el.className || el.attributes?.class || '').split(/\s+/).includes(name);
}
const defs = shape('defs');
for (const lane of ['Codex', 'Opus', 'Argon']) {
  const pattern = shape('pattern', { id: `quota-${lane}`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' });
  pattern.append(shape('rect', { width: 8, height: 8, fill: 'var(--raised)' }));
  pattern.append(shape('path', { d: 'M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6', stroke: laneColor(lane), 'stroke-width': 3 }));
  defs.append(pattern);
}
const edgeLayer = shape('g', { class: 'map-edges', 'aria-hidden': 'true' });
const crossLayer = shape('g', { class: 'map-cross-links', 'aria-hidden': 'true', 'pointer-events': 'none' });
const nodeLayer = shape('g', { class: 'map-nodes' });
svg.append(defs, edgeLayer, crossLayer, nodeLayer);
const nodeElements = new Map(), edgeElements = new Map(), crossElements = new Map();
let layout, currentRuns = [], claudeModels = [], filteredCount = 0, showDetails, scope, view, active = false, drag;
let userAdjustedView = false, selectedCrossRunId = null;
let mapOnly = false, mapOnlySource = null, savedTabHash = null, savedScroll = null, legendOpen = false, browserFsDismissed = false;
let restoredDetails = null, restoredConnection = null;
const expanded = new Set(), collapsed = new Set();
const seenDelegations = new Set();
let wave = 0, edgeSequence = 0;
let counterRange = {};
let lastTickAria = -Infinity;
const wakeTitles = {
  'bật': 'Đang chặn tắt màn hình và trình bảo vệ màn hình do không hoạt động.',
  'đang chờ': 'Đang xin quyền giữ màn hình sáng.',
  'đang chờ (tab ẩn)': 'Sẽ xin lại khóa khi tab hiện và vẫn ở chế độ chỉ sơ đồ.',
  'bị chặn': 'Không giữ được màn hình sáng; tối đa ba lần xin với thời gian chờ tăng dần. Thoát rồi vào lại để thử lại.',
  'không hỗ trợ': 'Trình duyệt không có Screen Wake Lock API.',
  'tắt': 'Chỉ giữ màn hình sáng trong chế độ chỉ sơ đồ.',
};
const wakeLock = createWakeLock({ navigator: globalThis.navigator, document, onChange(value) {
  const label = $('wake-lock-status');
  const message = `Giữ màn hình sáng: ${value}`;
  if (label) { label.textContent = message; label.title = wakeTitles[value]; }
  if (mapOnly) announceMapStatus(message);
} });
if ($('clear-detail') && $('clear-detail').hidden === undefined) $('clear-detail').hidden = true;

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
  updateTextScale();
}
function center(all = false) {
  if (!layout) return;
  userAdjustedView = false;
  view = [...(all ? layout.bounds : layout.coreBounds)];
  setView();
}
function updateTextScale() {
  if (!view) return;
  const box = svg.getBoundingClientRect();
  const scale = Math.min(box.width / view[2], box.height / view[3]);
  if (!(scale > 0)) return;
  // Tỉ lệ của khung "Căn giữa" theo kích thước vùng vẽ hiện tại (không lưu trạng thái).
  const core = layout?.coreBounds;
  const fitScale = core ? Math.min(box.width / core[2], box.height / core[3]) : Infinity;
  for (const item of nodeElements.values()) {
    for (const { row, element } of item.textRows || []) {
      const fontSize = compensatedFont(row, item.node.r, scale, item.node.type);
      element.setAttribute('style', `font-size:${fontSize}px`);
      if (item.node.type === 'run' || item.node.type === 'more') continue;
      element.setAttribute('display', rowVisible(row, fontSize, scale, fitScale) ? 'inline' : 'none');
      element.setAttribute('textLength', row.width * fontSize / row.fontSize);
    }
  }
}
function zoom(factor, anchorX = .5, anchorY = .5) {
  if (!view || !layout) return;
  userAdjustedView = true;
  const width = Math.min(layout.bounds[2] * 4, Math.max(160, view[2] * factor));
  const ratio = width / view[2];
  view = [view[0] + view[2] * anchorX * (1 - ratio), view[1] + view[3] * anchorY * (1 - ratio), width, view[3] * ratio];
  setView();
}
function activate(node) {
  if (node.type === 'more') expanded.add(node.target);
  else if (node.type === 'lane' || node.type === 'project') {
    if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
  } else if (node.type === 'run') {
    selectedCrossRunId = node.run?.crossProject
      ? (selectedCrossRunId === node.run.id ? null : node.run.id)
      : null;
  }
  const run = node.type === 'more' ? null : node.run || node.runs?.[0]
    || (node.type === 'root' ? currentRuns.find(run => run.lane === 'Claude') : null);
  if (run) {
    if ($('clear-detail')) $('clear-detail').hidden = false;
    toggleClass($('details'), 'open', true);
    showDetails?.(run, true);
  }
  if (node.type !== 'run' && node.type !== 'root') {
    draw();
    // Nút gộp biến mất sau khi mở; chuyển tiêu điểm về nút cha còn tồn tại.
    if (node.type === 'more') nodeElements.get(node.target)?.group.focus();
  } else if (node.type === 'run') {
    updateCrossLinks();
  }
}
function description(node, now = Date.now()) {
  if (node.type === 'run') {
    const run = node.run;
    const status = run.running ? activityText(run, now) : statuses[run.status] || 'chưa rõ';
    const activeCross = run.crossProject && selectedCrossRunId === run.id ? `, ${crossProjectActiveText(run)}` : '';
    return `${LANE_LABELS[run.lane]}, ${modelText(run, true)}, ${run.projectLabel}, ${status}${run.endEstimated ? ', giờ kết thúc ước lượng' : ''}`
      + (modelNote(run) ? `, ${modelNote(run)}` : '')
      + (run.tokens ? `, ${formatTokens(run.tokens.total)} token, ${tokenBreakdown(run.tokens)}` : '')
      + (run.crossProject ? `, ${crossProjectLeafText(run)}${activeCross}` : '')
      + `, ${Array.from(run.prompt || '').slice(0, 200).join('')}`
      + (run.promptSource ? `, nguồn lời nhắc: ${run.promptSource}` : '')
      + (run.unknownReason ? `, không rõ dự án vì ${run.unknownReason}` : '');
  }
  if (node.type === 'more') return `${node.label}, bấm để mở rộng`;
  const action = node.type === 'root' ? 'điều phối' : collapsed.has(node.id) ? 'bấm để mở rộng' : 'bấm để thu gọn';
  return `${node.fullLabel || node.label}, ${node.subtitle || ''}`
    + (node.counterDescription ? `, ${node.counterDescription}` : '')
    + (node.crossCount ? `, ${crossProjectNodeText(node.crossCount)}` : '')
    + (node.unknownReasons ? `, ${node.unknownReasons}` : '')
    + `${node.running ? `, đang ${node.phase}` : ''}, ${action}`;
}
function findTargetProjectNode(leafNode) {
  const targetKey = leafNode.run?.workProjectKey;
  if (!targetKey || !layout?.nodes) return null;
  return layout.nodes.find(n => n.type === 'project' && n.projectKey === targetKey && n.lane === leafNode.lane)
    || layout.nodes.find(n => n.type === 'project' && n.projectKey === targetKey)
    || null;
}
function arrowPath(cx, cy, x2, y2) {
  const tx = x2 - cx, ty = y2 - cy, len = Math.hypot(tx, ty) || 1;
  const ux = tx / len, uy = ty / len, nx = -uy, ny = ux;
  const bx = x2 - ux * 8, by = y2 - uy * 8;
  return `M ${bx + nx * 4} ${by + ny * 4} L ${x2} ${y2} L ${bx - nx * 4} ${by - ny * 4} Z`;
}
function updateCrossLinks(now = Date.now()) {
  if (!layout) return;
  const presentCrossIds = new Set();
  for (const node of layout.nodes) {
    if (node.type !== 'run' || !node.run?.crossProject) continue;
    presentCrossIds.add(node.id);
    const item = nodeElements.get(node.id);
    if (item) {
      const desc = description(node, now);
      item.group.setAttribute('aria-label', desc);
      item.group.setAttribute('aria-pressed', String(selectedCrossRunId === node.run.id));
      item.title.textContent = desc;
    }
    const isSelected = selectedCrossRunId === node.run.id;
    const isRunning = Boolean(node.run.running);
    if (!isSelected && !isRunning) {
      const old = crossElements.get(node.id);
      if (old) old.group.setAttribute('display', 'none');
      continue;
    }
    let link = crossElements.get(node.id);
    if (!link) {
      const group = shape('g', { class: 'map-cross-link' });
      const title = shape('title');
      const path = shape('path', { class: 'map-cross-path', fill: 'none' });
      const arrow = shape('path', { class: 'map-cross-arrow' });
      const tag = shape('g', { class: 'map-cross-tag', display: 'none' });
      const tagTitle = shape('title');
      const tagRect = shape('rect', { rx: 6, ry: 6, height: 22, y: -11 });
      const tagText = shape('text', { 'text-anchor': 'middle', y: 4 });
      tag.append(tagTitle, tagRect, tagText);
      group.append(title, path, arrow, tag);
      crossLayer.append(group);
      link = { group, title, path, arrow, tag, tagTitle, tagRect, tagText };
      crossElements.set(node.id, link);
    }
    const delegating = isRunning && activityPhase(node.run, now) === 'giao';
    link.group.setAttribute('display', 'inline');
    link.group.setAttribute('class', `map-cross-link${isRunning ? ' running activity-working' : ''}${delegating ? ' activity-delegating' : ''}${isSelected ? ' selected' : ''}`);
    link.group.setAttribute('style', `--lane:${laneColor(node.lane)};--activity-color:color-mix(in srgb,${laneColor(node.lane)} 80%,var(--text))`);
    link.path.setAttribute('class', `map-cross-path${isRunning ? ' map-flow' : ''}`);
    const linkTitle = crossProjectLinkText(node.run);
    link.title.textContent = linkTitle;
    link.tagTitle.textContent = linkTitle;
    const target = findTargetProjectNode(node);
    if (target) {
      const dx = target.x - node.x, dy = target.y - node.y, dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist, nx = -uy, ny = ux;
      const x1 = node.x + ux * (node.r + 4), y1 = node.y + uy * (node.r + 4);
      const x2 = target.x - ux * (target.r + 6), y2 = target.y - uy * (target.r + 6);
      const bend = Math.min(80, Math.max(24, dist * .18));
      const cx = (x1 + x2) / 2 + nx * bend, cy = (y1 + y2) / 2 + ny * bend;
      link.path.setAttribute('d', `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
      link.arrow.setAttribute('d', arrowPath(cx, cy, x2, y2));
      link.tag.setAttribute('display', 'none');
      link.group.setAttribute('data-target', target.id);
      link.group.setAttribute('data-mode', 'node');
    } else {
      const rad = Math.hypot(node.x, node.y) || 1;
      const ux = node.x / rad, uy = node.y / rad, nx = -uy, ny = ux;
      const x1 = node.x + ux * (node.r + 4), y1 = node.y + uy * (node.r + 4);
      const x2 = x1 + ux * 42 + nx * 12, y2 = y1 + uy * 42 + ny * 12;
      const cx = (x1 + x2) / 2 + nx * 14, cy = (y1 + y2) / 2 + ny * 14;
      link.path.setAttribute('d', `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
      link.arrow.setAttribute('d', arrowPath(cx, cy, x2, y2));
      const text = `→ ${workProjectDisplay(node.run) || node.run.workProjectLabel || node.run.workProjectKey || 'Không rõ dự án'}`;
      link.tagText.textContent = text;
      const width = Math.max(56, Array.from(text).length * 7 + 16);
      link.tagRect.setAttribute('x', -width / 2);
      link.tagRect.setAttribute('width', width);
      link.tag.setAttribute('transform', `translate(${x2 + ux * (width / 2 + 6)} ${y2 + uy * 14})`);
      link.tag.setAttribute('display', 'inline');
      link.group.setAttribute('data-target', '');
      link.group.setAttribute('data-mode', 'tag');
    }
  }
  for (const [id, item] of crossElements) {
    if (!presentCrossIds.has(id)) item.group.setAttribute('display', 'none');
  }
}
function updateNodeText(item, elapsedText = '') {
  const rows = nodeTextRows(item.node, { elapsedText });
  const subtitles = rows.filter(row => row.kind === 'subtitle');
  while (item.subtitle.children.length > subtitles.length) item.subtitle.children[item.subtitle.children.length - 1].remove();
  const elements = { label: item.label, counter: item.counterLabel, elapsed: item.elapsedLabel };
  for (const element of Object.values(elements)) element.textContent = '';
  let index = 0;
  item.textRows = [];
  for (const row of rows) {
    let element = elements[row.kind];
    if (row.kind === 'subtitle') {
      if (!item.subtitle.children[index]) item.subtitle.append(shape('tspan', { x: 0, dy: 0 }));
      element = item.subtitle.children[index++];
      if (index === 1) item.subtitle.setAttribute('y', row.y);
    }
    element.textContent = row.text;
    element.setAttribute('y', row.y);
    element.setAttribute('style', `font-size:${row.fontSize}px`);
    item.textRows.push({ row, element });
    // Cố định độ rộng hiển thị theo cùng ước lượng dùng để tính dây cung.
    if (item.node.type !== 'run' && item.node.type !== 'more') {
      element.setAttribute('textLength', row.textLength ?? row.width);
      element.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }
}
function draw(reset = false) {
  const now = Date.now();
  layout = layoutMindmap(currentRuns, { previous: reset ? undefined : layout, expanded, collapsed, now, claudeModels, range: counterRange });
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
      const label = shape('text', { 'text-anchor': 'middle' });
      const subtitle = shape('text', { 'text-anchor': 'middle', class: 'map-subtitle' });
      const mark = shape('text', { 'text-anchor': 'middle', y: 5, class: 'map-error-mark' });
      const crossMark = shape('path', { class: 'map-cross-mark', 'aria-hidden': 'true' });
      const counterLabel = shape('text', { 'text-anchor': 'middle', class: 'map-subtitle map-counter' });
      const elapsedLabel = shape('text', { 'text-anchor': 'middle', class: 'map-subtitle map-elapsed' });
      const badge = shape('g', { class: 'map-running-badge', 'aria-hidden': 'true' });
      badge.append(shape('rect', { x: -58, y: -12, width: 116, height: 24, rx: 12 }),
        shape('circle', { cx: -46, r: 3, class: 'map-badge-dot' }),
        shape('text', { 'text-anchor': 'middle', x: 5, y: 4 }));
      group.append(title, circle, crossMark, label, subtitle, counterLabel, elapsedLabel, mark, badge);
      item = { group, circle, crossMark, title, label, subtitle, counterLabel, elapsedLabel, mark, badge, node };
      group.addEventListener('click', () => activate(item.node));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item.node); }
      });
      group.addEventListener('pointerenter', () => { if (item.node.run && !mapOnly) showDetails(item.node.run); });
      group.addEventListener('focus', () => { if (item.node.run && !mapOnly) showDetails(item.node.run); });
      nodeElements.set(node.id, item); nodeLayer.append(group);
    }
    item.node = node;
    const own = node.type === 'root' || node.type === 'lane'
      ? currentRuns.filter(run => run.lane === (node.type === 'root' ? 'Claude' : node.lane)) : node.runs || [];
    item.runningStart = ['root', 'lane'].includes(node.type)
      ? Math.min(...own.filter(run => run.running).map(run => run.start)) : Infinity;
    const status = node.run?.running ? 'running' : node.run?.status || '';
    const estimated = node.run?.endEstimated ? ' estimated' : '';
    const working = node.running > 0;
    const isCross = node.type === 'run' && Boolean(node.run?.crossProject);
    const isSelectedCross = isCross && selectedCrossRunId === node.run.id;
    const waveClass = node.type === 'root' && node.delegating && wave ? ` root-wave-${wave}` : '';
    const nodeClass = `map-node map-${node.type} ${status}${estimated}${isCross ? ' cross-project' : ''}`
      + `${isSelectedCross ? ' cross-selected' : ''}${working ? ' activity-working' : ''}${node.delegating ? ' activity-delegating' : ''}${waveClass}`;
    item.group.setAttribute('class', nodeClass);
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
    item.group.setAttribute('transform', `translate(${node.x} ${node.y})`);
    item.group.setAttribute('aria-label', description(node, now));
    if (node.type === 'project' || node.type === 'lane') item.group.setAttribute('aria-expanded', !collapsed.has(node.id));
    item.group.setAttribute('opacity', node.type === 'lane' && !node.count ? .45 : 1);
    item.circle.setAttribute('r', node.r);
    item.circle.setAttribute('stroke', laneColor(node.lane));
    const fill = node.type === 'run' && status !== 'unknown' && status !== 'error' ? laneColor(node.lane) : 'var(--surface)';
    item.circle.setAttribute('fill', status === 'quota' ? `url(#quota-${node.lane})` : fill);
    item.title.textContent = description(node, now);
    if (node.type === 'run') item.label.setAttribute('class', 'map-run-label');
    const elapsedText = Number.isFinite(item.runningStart) ? formatDuration(Math.max(0, now - item.runningStart)) : '';
    updateNodeText(item, elapsedText);
    item.mark.textContent = status === 'error' ? 'X' : '';
  }
  updateCrossLinks(now);
  tick(now, true);
  $('mindmap-empty').hidden = layout.count > 0;
  if (!view || (reset && !userAdjustedView)) center();
  else updateTextScale();
  if (active) $('run-count').textContent = `${layout.count} lần giao, ${layout.grouped} lần giao đang gộp`;
}
// Nhịp chung do app.js gọi; chỉ đổi chữ, không gọi draw, không tính lại bố cục.
function tick(now, forceAria = false) {
  if (!active || document.hidden) return;
  const accessible = forceAria || now - lastTickAria >= 30_000;
  if (accessible) lastTickAria = now;
  for (const item of nodeElements.values()) {
    const elapsed = Math.max(0, now - item.runningStart);
    const text = Number.isFinite(item.runningStart) ? formatDuration(elapsed) : '';
    // Chỉ thay chữ đồng hồ trong ô đã dự trữ; không dựng lại nút hay đổi tọa độ dòng.
    const row = nodeTextRows(item.node, { elapsedText: text }).find(row => row.kind === 'elapsed');
    item.elapsedLabel.textContent = row?.text || '';
    if (row) {
      const entry = item.textRows.find(entry => entry.row.kind === 'elapsed');
      if (entry) entry.row = row;
      item.elapsedLabel.setAttribute('textLength', row.width);
      item.elapsedLabel.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    if (accessible) {
      const desc = description(item.node, now) + (text ? `, ${text}` : '');
      item.group.setAttribute('aria-label', desc);
      item.title.textContent = desc;
    }
  }
}
function selectTab() {
  active = location.hash === '#so-do' || location.hash === 'so-do';
  $('timeline-view').hidden = active;
  $('mindmap-view').hidden = !active;
  $('tab-timeline').setAttribute('aria-selected', !active);
  $('tab-mindmap').setAttribute('aria-selected', active);
  for (const id of ['zoom-in', 'zoom-out', 'focus-activity']) $(id).hidden = active;
  $('timeline-title').textContent = active ? 'Sơ đồ' : 'Dòng thời gian';
  if (active && (layout || currentRuns.length)) draw(!layout);
  if (!active) $('run-count').textContent = `${filteredCount} thanh hoạt động`;
}
const mapView = $('mindmap-view');
const mapStage = $('map-stage');
function fullscreenTarget() {
  if (typeof mapStage?.requestFullscreen === 'function') return mapStage;
  if (typeof mapView?.requestFullscreen === 'function') return mapView;
  return mapStage || mapView;
}
function announceMapStatus(message, visibleWarning = false) {
  const statusEl = $('map-status');
  if (!statusEl) return;
  statusEl.textContent = message;
  toggleClass(statusEl, 'sr-only', !visibleWarning);
  toggleClass(statusEl, 'map-status-toast', visibleWarning);
}
function syncFullscreenControls() {
  const fsBtn = $('map-fullscreen');
  if (fsBtn) {
    fsBtn.textContent = mapOnly ? 'Thoát toàn màn hình' : 'Toàn màn hình';
    fsBtn.setAttribute('aria-pressed', String(mapOnly));
    fsBtn.setAttribute('title', mapOnly ? 'Thoát toàn màn hình (F11)' : 'Toàn màn hình chỉ sơ đồ (F11)');
    fsBtn.setAttribute('aria-label', mapOnly ? 'Thoát toàn màn hình' : 'Toàn màn hình');
  }
  const legendBtn = $('map-legend-toggle');
  if (legendBtn) {
    legendBtn.hidden = !mapOnly;
    legendBtn.setAttribute('aria-pressed', String(Boolean(mapOnly && legendOpen)));
  }
  const legendEl = $('mindmap-legend');
  if (legendEl) {
    legendEl.hidden = mapOnly ? !legendOpen : false;
    toggleClass(legendEl, 'legend-overlay', Boolean(mapOnly && legendOpen));
  }
  const label = mapOnly ? 'Sơ đồ toàn màn hình' : 'Sơ đồ điều phối';
  if (mapStage) {
    mapStage.setAttribute('role', 'region');
    mapStage.setAttribute('aria-label', label);
  }
  if (mapView) {
    mapView.setAttribute('role', mapOnly ? 'region' : 'tabpanel');
    mapView.setAttribute('aria-label', label);
  }
}
function relocateOverlays(intoStage) {
  const host = mapStage || mapView;
  if (typeof host?.appendChild !== 'function') return;
  const details = $('details');
  const conn = document.querySelector?.('.connection');
  if (intoStage) {
    if (details?.parentNode && details.parentNode !== host && typeof details.parentNode.insertBefore === 'function') {
      restoredDetails = { parent: details.parentNode, next: details.nextSibling };
      host.appendChild(details);
    }
    if (conn?.parentNode && conn.parentNode !== host && typeof conn.parentNode.insertBefore === 'function') {
      restoredConnection = { parent: conn.parentNode, next: conn.nextSibling };
      host.appendChild(conn);
    }
  } else {
    if (restoredDetails && details) {
      restoredDetails.parent.insertBefore(details, restoredDetails.next);
      restoredDetails = null;
    }
    if (restoredConnection && conn) {
      restoredConnection.parent.insertBefore(conn, restoredConnection.next);
      restoredConnection = null;
    }
  }
}
function isDetailOpen() {
  const clearBtn = $('clear-detail');
  return Boolean((clearBtn && clearBtn.hidden === false) || hasClass($('details'), 'open'));
}
function closeDetails() {
  const clearBtn = $('clear-detail');
  if (clearBtn) {
    const handler = clearBtn.listeners?.click || clearBtn.events?.click;
    if (typeof clearBtn.click === 'function') clearBtn.click();
    else if (typeof handler === 'function') handler();
    clearBtn.hidden = true;
  }
  toggleClass($('details'), 'open', false);
  if ($('detail-title')) $('detail-title').textContent = 'Chọn một thanh hoạt động';
  if ($('detail-hint')) $('detail-hint').hidden = false;
  $('detail-fields')?.replaceChildren?.();
}
function refreshViewportOnModeChange() {
  if (!layout && currentRuns.length) draw(false);
  if (!layout) return;
  if (!userAdjustedView || !view) center();
  else setView();
  updateCrossLinks();
}
function setMapOnly(enabled, source = 'api', statusText = '') {
  const next = Boolean(enabled);
  if (next === mapOnly) {
    if (next && source) mapOnlySource = source;
    syncFullscreenControls();
    if (statusText) announceMapStatus(statusText, statusText.includes('chặn'));
    return;
  }
  if (next) {
    savedTabHash = !active ? (location.hash || '#dong-thoi-gian') : null;
    savedScroll = { x: window.scrollX || 0, y: window.scrollY || 0, chart: $('chart-shell')?.scrollLeft || 0 };
    if (!active) {
      location.hash = '#so-do';
      selectTab();
    }
    mapOnly = true;
    mapOnlySource = source || 'api';
    legendOpen = false;
    toggleClass(document.documentElement, 'map-only', true);
    toggleClass($('details'), 'open', isDetailOpen());
    relocateOverlays(true);
    syncFullscreenControls();
    announceMapStatus(statusText || 'Đã vào chế độ chỉ sơ đồ', Boolean(statusText && statusText.includes('chặn')));
    refreshViewportOnModeChange();
  } else {
    mapOnly = false;
    mapOnlySource = null;
    legendOpen = false;
    toggleClass(document.documentElement, 'map-only', false);
    relocateOverlays(false);
    syncFullscreenControls();
    announceMapStatus('Đã thoát chế độ chỉ sơ đồ', false);
    if (savedTabHash !== null) {
      const restore = savedTabHash;
      savedTabHash = null;
      location.hash = restore;
      selectTab();
    } else {
      refreshViewportOnModeChange();
    }
    if (savedScroll) {
      if ($('chart-shell')) $('chart-shell').scrollLeft = savedScroll.chart;
      window.scrollTo?.(savedScroll.x, savedScroll.y);
      savedScroll = null;
    }
  }
  const wakeLabel = $('wake-lock-status');
  if (wakeLabel) {
    wakeLabel.hidden = !mapOnly;
    wakeLabel.textContent = `Giữ màn hình sáng: ${wakeLock.state}`;
    wakeLabel.title = wakeTitles[wakeLock.state];
  }
  wakeLock.set(mapOnly);
  if (mapOnly && wakeLock.state === 'không hỗ trợ') announceMapStatus('Đã vào chế độ chỉ sơ đồ. Giữ màn hình sáng: không hỗ trợ');
}
function enterFullscreen() {
  setMapOnly(true, 'api');
  const target = fullscreenTarget();
  if (typeof target?.requestFullscreen === 'function') {
    try {
      const promise = target.requestFullscreen();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {
          mapOnlySource = 'fallback';
          toggleClass(document.documentElement, 'map-only', true);
          announceMapStatus('Trình duyệt chặn toàn màn hình', true);
        });
      }
    } catch {
      mapOnlySource = 'fallback';
      toggleClass(document.documentElement, 'map-only', true);
      announceMapStatus('Trình duyệt chặn toàn màn hình', true);
    }
  } else {
    mapOnlySource = 'fallback';
  }
}
function exitFullscreenMode() {
  if (mapOnlySource === 'browser') browserFsDismissed = true;
  const fsEl = document.fullscreenElement;
  setMapOnly(false);
  if (fsEl && typeof document.exitFullscreen === 'function') {
    try {
      const promise = document.exitFullscreen();
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch {}
  }
}
function toggleFullscreen() {
  if (mapOnly) exitFullscreenMode();
  else enterFullscreen();
}
function isEditableTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable);
}
const mediaQuery = window.matchMedia?.('(display-mode: fullscreen)');
function checkBrowserFullscreen() {
  if (document.fullscreenElement || mapOnlySource === 'api' || mapOnlySource === 'fallback') {
    if (mapOnly) refreshViewportOnModeChange();
    return;
  }
  const detected = isBrowserFullscreen(window, window.screen, Boolean(mediaQuery?.matches));
  if (!detected) {
    browserFsDismissed = false;
    if (mapOnly && mapOnlySource === 'browser') setMapOnly(false);
  } else if (!mapOnly && !browserFsDismissed) {
    setMapOnly(true, 'browser');
  }
}
document.addEventListener?.('keydown', event => {
  if (event.key === 'F11') {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (isEditableTarget(event.target || document.activeElement)) return;
    event.preventDefault?.();
    toggleFullscreen();
  } else if (event.key === 'Escape' && mapOnly) {
    event.preventDefault?.();
    if (isDetailOpen()) closeDetails();
    else exitFullscreenMode();
  }
});
document.addEventListener?.('fullscreenchange', () => {
  const fsEl = document.fullscreenElement;
  if (fsEl && (fsEl === mapStage || fsEl === mapView)) {
    setMapOnly(true, 'api');
  } else if (!fsEl && mapOnly && mapOnlySource === 'api') {
    setMapOnly(false);
  }
});
mediaQuery?.addEventListener?.('change', checkBrowserFullscreen);
window.addEventListener('resize', () => { checkBrowserFullscreen(); updateTextScale(); });
if (typeof ResizeObserver === 'function') new ResizeObserver(updateTextScale).observe(svg);
$('tab-timeline').addEventListener('click', () => { location.hash = 'dong-thoi-gian'; });
$('tab-mindmap').addEventListener('click', () => { location.hash = 'so-do'; });
window.addEventListener('hashchange', selectTab);
$('map-zoom-in').addEventListener('click', () => zoom(.75));
$('map-zoom-out').addEventListener('click', () => zoom(1 / .75));
$('map-center').addEventListener('click', () => center());
$('map-show-all')?.addEventListener('click', () => center(true));
$('map-reorder').addEventListener('click', () => draw(true));
$('map-fullscreen')?.addEventListener('click', toggleFullscreen);
$('map-legend-toggle')?.addEventListener('click', () => {
  if (!mapOnly) return;
  legendOpen = !legendOpen;
  syncFullscreenControls();
});
svg.addEventListener('wheel', event => {
  event.preventDefault();
  const box = svg.getBoundingClientRect();
  zoom(event.deltaY > 0 ? 1.12 : 1 / 1.12, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
}, { passive: false });
svg.addEventListener('click', event => {
  if (event.target?.closest?.('[role="button"]')) return;
  if (selectedCrossRunId !== null) {
    selectedCrossRunId = null;
    updateCrossLinks();
  }
});
svg.addEventListener('pointerdown', event => {
  if (event.target?.closest?.('[role="button"]')) return;
  if (selectedCrossRunId !== null) {
    selectedCrossRunId = null;
    updateCrossLinks();
  }
  if (!view) return;
  drag = { x: event.clientX, y: event.clientY, view: [...view] };
  svg.setPointerCapture(event.pointerId);
});
svg.addEventListener('pointermove', event => {
  if (!drag) return;
  userAdjustedView = true;
  const box = svg.getBoundingClientRect();
  const scale = Math.max(drag.view[2] / box.width, drag.view[3] / box.height);
  view = [drag.view[0] - (event.clientX - drag.x) * scale, drag.view[1] - (event.clientY - drag.y) * scale, ...drag.view.slice(2)];
  setView();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(event, () => { drag = null; });
window.boardMindmap = {
  tick,
  setMapOnly,
  isMapOnly: () => mapOnly,
  update(runs, detail, key, claudeRuns = [], knownClaudeModels = [], range = {}) {
    counterRange = range;
    filteredCount = runs.length; claudeModels = knownClaudeModels;
    const ids = new Set(runs.map(run => run.id));
    currentRuns = [...runs, ...claudeRuns.filter(run => !ids.has(run.id))]; showDetails = detail;
    const reset = scope !== key;
    if (reset) { layout = undefined; expanded.clear(); collapsed.clear(); userAdjustedView = false; }
    scope = key;
    // Tab Sơ đồ đang ẩn thì không tính bố cục và vẽ mỗi giây (đắt, không ai thấy); vẽ ngay khi chuyển sang tab này.
    if (!active) { $('run-count').textContent = `${filteredCount} thanh hoạt động`; return; }
    draw(reset);
  },
};
syncFullscreenControls();
selectTab();
window.dispatchEvent(new Event('mindmap-ready'));
