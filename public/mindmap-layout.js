import { LANE_LABELS, countModels, isBrowserFullscreen, modelLabel } from './model-labels.js';
import { activityPhase } from './activity.js';
import { nodeCounters } from './counters.js';

export { isBrowserFullscreen };
export const MINDMAP_LANES = ['Codex', 'Opus', 'Argon'];
const TAU = Math.PI * 2;
const recent = (a, b) => b.start - a.start || String(a.id).localeCompare(String(b.id));
export function leafRadius(run, now = Date.now()) {
  const seconds = Math.max(0, ((run.end ?? now) - run.start) / 1000);
  return 7 + 11 * Math.min(1, Math.log1p(seconds) / Math.log1p(86_400));
}
export function shortenLabel(label, width = 126) {
  const chars = Array.from(String(label || 'Không rõ dự án'));
  const limit = Math.floor(width / 8);
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit - 3).join('') + '...';
}

// Hộp chữ bảo thủ: tiêu đề 14px, phụ đề 10px; cùng kiểu chữ trong styles.css.
// Dự trữ 31 ký tự cho số liệu/phụ đề và cả hai dạng đồng hồ dài nhất dưới 100 giờ.
// Chữ dài hơn vùng dự trữ được co bằng textLength, không làm nhảy bán kính qua SSE.
export function nodeTextRows(node, { reserve = false, includeLive = true, elapsedText = node.elapsedText || '' } = {}) {
  const live = node.type === 'root' || node.type === 'lane';
  const rows = [];
  const add = (kind, text, reservedWidth = 0, maxWidth = Infinity) => {
    const title = kind === 'label';
    const measured = Array.from(text).length * (title ? node.type === 'run' ? 7 : 8 : 6);
    const width = reserve && reservedWidth ? reservedWidth : Math.min(measured, maxWidth);
    rows.push({ kind, text, width, ascent: title ? 14 : 10, descent: title ? 4 : 3,
      ...(measured > maxWidth ? { textLength: maxWidth } : {}) });
  };
  const unknown = node.type === 'project' && node.projectKey === '(không rõ)';
  add('label', node.label || '', 0, unknown ? 126 : Infinity);
  if (node.type !== 'more') {
    for (const line of node.subtitleLines || [node.subtitle || '']) {
      if (line || node.type === 'run') add('subtitle', line, live ? 186 : 0, live ? 186 : Infinity);
    }
    if (node.counterText || (live && reserve)) add('counter', node.counterText || '', 186, 186);
    if (includeLive && (live || node.type === 'run')) {
      if (node.running || (live && reserve)) add('phase', node.running ? `đang ${node.phase}` : '', 54, 54);
      if (live && (elapsedText || reserve)) add('elapsed', elapsedText, 144, 144);
    }
  }
  const height = rows.reduce((sum, row) => sum + row.ascent + row.descent, 0) + (rows.length - 1) * 3;
  let top = -height / 2;
  return rows.map((row, index) => {
    const y = node.type === 'run' ? node.r + 14 + index * 14 : top + row.ascent;
    top += row.ascent + row.descent + 3;
    return { ...row, y, top: y - row.ascent, bottom: y + row.descent };
  });
}

// Bán kính nhỏ nhất thỏa đồng thời dây cung ngang và lề dọc của mọi hộp chữ.
export function nodeRadius(rows, base) {
  return Math.max(base, ...rows.map(row => {
    const edge = Math.max(Math.abs(row.top), Math.abs(row.bottom));
    return Math.max(edge + 6, Math.hypot(row.width / 2 + 6, edge));
  }));
}

// Lá có chữ bên ngoài; các bóng còn lại đã chứa trọn khối chữ trong node.r.
export function labelRadius(node) {
  if (node.type !== 'run') return node.type === 'lane' ? node.r * 1.6 + 6 : node.r;
  const width = Math.max(Array.from(node.label || '').length * 7, Array.from(node.subtitle || '').length * 6);
  return Math.max(18, Math.hypot(width / 2 + 4, 18 + 42 + 8));
}

// Vị trí cũ là đầu vào tường minh để hàm thuần giữ chỗ qua các lượt cập nhật.
export function layoutMindmap(runs, options = {}) {
  const now = options.now ?? Date.now();
  const previous = options.previous;
  const old = new Map((previous?.nodes || []).map(node => [node.id, node]));
  const expanded = new Set(options.expanded || []), collapsed = new Set(options.collapsed || []);
  const work = runs.filter(run => MINDMAP_LANES.includes(run.lane)
    && run.kind !== 'tương tác' && run.kind !== 'hoạt động');
  const weights = MINDMAP_LANES.map(lane => Math.sqrt(work.filter(run => run.lane === lane).length));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 3;
  let angle = -Math.PI / 2;
  const arcs = previous?.arcs || MINDMAP_LANES.map((lane, i) => {
    const span = 70 * Math.PI / 180 + (TAU - 210 * Math.PI / 180) * (weights[i] || (work.length ? 0 : 1)) / total;
    const arc = { lane, start: angle, end: angle + span };
    angle += span;
    return arc;
  });
  const nodes = [], edges = [];
  // Dự trữ bán kính tối đa của lá để thời lượng tăng không gây va chạm.
  const occupied = [...old.values()].map(node => ({ ...node, reserve: node.reserve || node.r }));
  const place = (node, arc, base, preferred) => {
    if (['root', 'lane', 'project'].includes(node.type)) {
      const counters = nodeCounters(node.runs || [], node.lane || 'Claude', now, options.range);
      Object.assign(node, counters);
      if (node.type === 'project' && !counters.busyMs) node.counterText = '';
      const rows = nodeTextRows(node, { reserve: true });
      // Khi nghỉ, bộ đếm xuống cuối khối chữ và cần dây cung rộng hơn tại vị trí đó.
      // Dự trữ cả hai khối căn giữa để ẩn/hiện dòng sống không đổi bán kính.
      if (node.type !== 'project') rows.push(...nodeTextRows(node, { reserve: true, includeLive: false }));
      node.r = nodeRadius(rows, node.r);
    }
    node.reserve = labelRadius(node);
    const saved = old.get(node.id);
    const oldIndex = occupied.findIndex(other => other.id === node.id);
    if (oldIndex >= 0) occupied.splice(oldIndex, 1);
    const fits = () => occupied.every(other => Math.hypot(node.x - other.x, node.y - other.y) >= node.reserve + other.reserve + 4 - 1e-7);
    if (saved) Object.assign(node, { x: saved.x, y: saved.y });
    if (node.type === 'root') Object.assign(node, { x: 0, y: 0 });
    else if (!saved || !fits()) {
      let step = 0;
      for (;;) {
        const radius = base + Math.floor(step / 9) * 44;
        const offset = step % 9;
        const theta = offset === 0 ? preferred : arc.start + (arc.end - arc.start) * offset / 9;
        node.x = Math.cos(theta) * radius;
        node.y = Math.sin(theta) * radius;
        if (fits()) break;
        step++;
      }
    }
    nodes.push(node);
    occupied.push(node);
    if (node.parent) edges.push({ id: `${node.parent}>${node.id}`, from: node.parent, to: node.id });
    return node;
  };
  const claudeRuns = runs.filter(run => run.lane === 'Claude');
  const sessions = new Set(claudeRuns.map(run => run.sourceSession)).size;
  // Liệt kê cả model Claude đã dùng gần đây nhưng chưa có đoạn nào trong khung đang xem (số đếm 0).
  const counted = countModels(claudeRuns), listed = new Set(counted.map(item => item.name));
  for (const raw of options.claudeModels || []) {
    const name = raw ? modelLabel(raw).name : '';
    if (name && !listed.has(name)) { counted.push({ name, count: 0 }); listed.add(name); }
  }
  const modelLines = counted.map(({ name, count }) => `${name} x ${count}`);
  const subtitleLines = modelLines.length ? modelLines : [`${sessions} phiên hoạt động`];
  place({ id: 'root', type: 'root', label: LANE_LABELS.Claude,
    subtitle: subtitleLines.join(' · '), subtitleLines, runs: claudeRuns, r: 70 }, null);
  let grouped = 0;
  for (const arc of arcs) {
    const own = work.filter(run => run.lane === arc.lane).sort(recent);
    const middle = (arc.start + arc.end) / 2;
    const laneId = `lane:${arc.lane}`;
    const lane = place({
      id: laneId, parent: 'root', type: 'lane', lane: arc.lane, label: LANE_LABELS[arc.lane], r: 64,
      count: own.length, running: own.filter(run => run.running).length,
      subtitle: `${own.length} lần giao, ${own.filter(run => run.running).length} chạy`, runs: own,
    }, arc, 230, middle);
    edges.at(-1).width = Math.min(10, Math.max(2, Math.sqrt(own.length)));
    edges.at(-1).running = lane.running > 0;
    if (collapsed.has(laneId)) continue;
    const groups = new Map();
    for (const run of own) {
      const key = run.projectKey || '(không rõ)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(run);
    }
    const all = [...groups];
    const visible = expanded.has(laneId) ? all : all.slice(0, 8);
    const extra = all.length - visible.length;
    const slots = visible.length + (extra ? 1 : 0);
    visible.forEach(([key, projectRuns], index) => {
      const part = {
        start: arc.start + (arc.end - arc.start) * index / slots,
        end: arc.start + (arc.end - arc.start) * (index + 1) / slots,
      };
      const theta = (part.start + part.end) / 2;
      const id = `project:${arc.lane}:${key}`;
      const unknown = key === '(không rõ)';
      const fullLabel = unknown ? `Không rõ dự án (${projectRuns.length})` : projectRuns[0].projectLabel;
      const reasons = new Map();
      if (unknown) for (const run of projectRuns) reasons.set(run.unknownReason || 'cwd không khớp thư mục nào',
        (reasons.get(run.unknownReason || 'cwd không khớp thư mục nào') || 0) + 1);
      place({
        id, parent: laneId, type: 'project', lane: arc.lane, projectKey: key, r: 74,
        label: unknown ? fullLabel : shortenLabel(fullLabel), fullLabel,
        unknownReasons: [...reasons].map(([reason, count]) => `${reason}: ${count}`).join('; '),
        crossCount: projectRuns.filter(run => run.crossProject).length,
        subtitle: `${projectRuns.length} lần giao`, runs: projectRuns,
      }, part, 450, theta);
      if (collapsed.has(id)) return;
      const leaves = expanded.has(id) ? projectRuns : projectRuns.slice(0, 10);
      leaves.forEach((run, i) => {
        const leafAngle = part.start + (part.end - part.start) * (i % 9 + 1) / 10;
        const label = modelLabel(run.model);
        place({ id: `run:${run.id}`, parent: id, type: 'run', lane: arc.lane, run, r: leafRadius(run, now),
          crossProject: Boolean(run.crossProject),
          label: label.name, subtitle: run.effort || label.effort },
          part, 620 + Math.floor(i / 9) * 44, leafAngle);
      });
      const hidden = projectRuns.length - leaves.length;
      if (hidden) {
        grouped += hidden;
        place({ id: `more:${id}`, parent: id, target: id, type: 'more', label: `+${hidden} lần giao`, r: 58 }, part, 690, theta);
      }
    });
    if (extra) {
      grouped += all.slice(visible.length).reduce((sum, [, group]) => sum + group.length, 0);
      place({ id: `more:${laneId}`, parent: laneId, target: laneId, type: 'more', label: `+${extra} dự án`, r: 58 },
        arc, 450, arc.end - (arc.end - arc.start) / slots / 2);
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    const own = node.type === 'root' ? work : node.run ? [node.run] : node.runs || [];
    // Nút gốc là chính Claude: đang làm khi có đoạn Claude đang chạy, kể cả khi chưa giao việc cho ai.
    node.running = own.filter(run => run.running).length + (node.type === 'root' ? claudeRuns.filter(run => run.running).length : 0);
    node.delegating = own.some(run => activityPhase(run, now) === 'giao');
    node.phase = node.delegating ? 'giao' : node.running ? 'làm' : 'nghỉ';
  }
  for (const edge of edges) {
    const target = byId.get(edge.to);
    edge.running = target.running > 0;
    edge.delegating = edge.from === 'root' && target.delegating;
    edge.lane = target.lane;
  }
  const extent = Math.max(350, ...nodes.map(node => Math.max(Math.abs(node.x), Math.abs(node.y)) + node.reserve + 30));
  return { nodes, edges, arcs, grouped, count: work.length, bounds: [-extent, -extent, extent * 2, extent * 2] };
}
