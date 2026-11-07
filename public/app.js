'use strict';
import { LANE_LABELS, countModels, latestPerFamily, modelLabel, modelNote, modelPrefix, modelSummary, modelText } from './model-labels.js';
import { CROSS_FILTER_OPTIONS, crossProjectBarText, crossProjectCardText, crossProjectCardTitle, crossProjectDetailText, crossProjectFooterText, matchesCrossFilter } from './model-labels.js';
import { activityPhase, activityText, watchActivityVisibility } from './activity.js';
const $ = id => document.getElementById(id);
watchActivityVisibility(document);
const lanes = Object.keys(LANE_LABELS);
const colors = { Claude: 'var(--claude)', Codex: 'var(--codex)', Opus: 'var(--opus)', Argon: 'var(--argon)' };
const local = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const tickFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
let hours = 6, end = Date.now(), following = true, zoom = 1, runs = [], state, selected = null, pinned = false;
const claudeLane = () => state?.lanes?.find(lane => lane.lane === 'Claude');
let requestNumber = 0, fetchQueued = false, fetching = false, lastRangeKey = '';
const cardElements = new Map();
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} giây` : seconds < 3600
    ? `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`
    : `${Math.floor(seconds / 3600)} giờ ${Math.floor(seconds % 3600 / 60)} phút`;
}
function format(value) { return value == null ? 'Chưa rõ' : local.format(value); }
for (const lane of lanes) {
  const option = element('option', '', LANE_LABELS[lane]); option.value = lane; $('lane-filter').append(option);
}
if ($('cross-filter')) {
  $('cross-filter').replaceChildren();
  for (const { value, label } of CROSS_FILTER_OPTIONS) {
    const option = element('option', '', label); option.value = value; $('cross-filter').append(option);
  }
}
for (const [id, raw] of [['legend-sonnet', 'claude-sonnet-5-5'], ['legend-opus', 'claude-opus-5-5']]) {
  $(id).append(element('span', '', `${LANE_LABELS.Claude}: ${modelLabel(raw).name} (${modelPrefix(raw)})`));
}
for (const lane of lanes) {
  const card = element('article', 'card'); card.style.setProperty('--lane', colors[lane]);
  const head = element('div', 'card-head'), title = element('h2', '', LANE_LABELS[lane]), badge = element('span', 'badge');
  const badgeText = element('span', '', 'Đang nạp'), badgePhase = element('span', 'badge-phase');
  badge.append(badgeText, badgePhase); head.append(title, badge);
  const model = element('p', 'model'), prompt = element('p', 'task', 'Đang đọc nguồn dữ liệu'), project = element('p', 'project');
  const modelSummary = element('p', 'model-summary'), config = element('p', 'model-summary');
  const foot = element('div', 'card-foot'), elapsed = element('span'), count = element('span'); foot.append(elapsed, count); card.append(head, model, modelSummary, config, prompt, project, foot); $('cards').append(card);
  cardElements.set(lane, { card, badge, badgeText, badgePhase, model, modelSummary, config, prompt, project, elapsed, count });
}
function renderCards() {
  if (!state) return;
  for (const lane of state.lanes) {
    const card = cardElements.get(lane.lane); if (!card) continue;
    card.badgeText.textContent = lane.state + (lane.activeCount > 1 ? ` (${lane.activeCount})` : '');
    card.badgePhase.textContent = lane.running ? `đang ${activityPhase(lane)}` : '';
    card.badge.className = `badge${lane.running ? ' active' : lane.state === 'Lỗi gần nhất' ? ' failure' : ''}`;
    card.card.classList.toggle('activity-working', Boolean(lane.running));
    card.badge.setAttribute('aria-label', lane.running ? `Đang chạy, ${activityText(lane)}` : lane.state);
    const raw = lane.knownModel ?? (lane.model === 'Chưa rõ' ? '' : lane.model);
    const model = { lane: lane.lane, model: raw, effort: lane.effort };
    card.model.textContent = modelText(model);
    card.model.title = modelText(model, true) + (modelNote(model) ? ` · ${modelNote(model)}` : '');
    // Liệt kê cả model hiện hành (phiên bản mới nhất mỗi họ) đã dùng trong 7 ngày nhưng chưa có đoạn nào trong 24 giờ (số 0), ví dụ Opus 5.5.
    const claudeModelCounts = { ...Object.fromEntries(latestPerFamily(Object.keys(lane.models7d || {})).map(model => [model, 0])), ...(lane.models24h || {}) };
    card.modelSummary.textContent = lane.lane === 'Claude' ? '24 giờ: ' + (modelSummary(
      Object.entries(claudeModelCounts).filter(([model]) => model).map(([model, count]) => ({ model, count })), 'đoạn') || 'Chưa có đoạn hoạt động') : '';
    const codexDefault = state.config?.codexDefault;
    card.config.textContent = lane.lane === 'Codex' && codexDefault ? `Cấu hình hiện tại: ${modelText(codexDefault)}` : '';
    card.prompt.textContent = lane.prompt || 'Chưa có lời nhắc từ nguồn';
    card.prompt.title = lane.promptTitle || card.prompt.textContent;
    card.project.textContent = lane.crossProject ? crossProjectCardText(lane) : lane.projectLabel;
    card.project.title = lane.crossProject ? crossProjectCardTitle(lane) : (lane.unknownReason || lane.projectLabel);
    card.project.classList.toggle('cross-project', Boolean(lane.crossProject));
    const elapsed = duration((lane.running ? Date.now() : lane.end || lane.start) - lane.start);
    card.elapsed.textContent = lane.start ? lane.running
      ? activityPhase(lane) === 'giao' ? `Vừa giao ${elapsed} trước` : `Đang làm: ${elapsed}`
      : `Lần gần nhất: ${elapsed}` : 'Chưa có hoạt động';
    card.count.textContent = lane.lane === 'Claude' ? `${lane.activity24h} đoạn / 24 giờ` : `${lane.count24h} lần giao / 24 giờ`;
  }
}
function renderState() {
  renderCards();
  const scan = state.scan;
  $('scan-progress').hidden = !scan.initial;
  $('scan-label').textContent = `Đang quét lần đầu: ${scan.scannedFiles} / ${scan.totalFiles} tệp`;
  $('progress').value = scan.totalFiles ? scan.scannedFiles / scan.totalFiles * 100 : 0;
  $('scan-footer').textContent = `Quét gần nhất: ${scan.lastScan ? format(Date.parse(scan.lastScan)) : 'Đang quét lần đầu'}`
    + ` · ${scan.scannedFiles} tệp · ${duration(scan.durationMs)}`
    + (scan.initialDurationMs != null ? ` · Lần đầu ${(scan.initialDurationMs / 1000).toFixed(1)} giây` : '')
    + (scan.agy ? ` · agy: ${scan.agy.conversationsRead} hội thoại, ${scan.agy.merged} đã ghép` : '');
  const prompts = scan.statistics?.codexPrompts;
  if (prompts) {
    const available = prompts.lệnh + prompts.rollout + prompts.tệp;
    $('scan-footer').textContent += ` · Codex: ${available}/${available + prompts['không có']} lần giao đọc được lời nhắc`
      + ` (lệnh ${prompts.lệnh}, rollout ${prompts.rollout}, tệp ${prompts.tệp}; không có ${prompts['không có']})`;
  }
  const projects = scan.statistics?.projects;
  const models = scan.statistics?.codexModels;
  if (models) {
    const known = models.rollout + models.lệnh;
    $('scan-footer').textContent += ` · Codex: model biết rõ ${known}/${known + models['chưa rõ']} lần giao`
      + ` (rollout ${models.rollout}, lệnh ${models.lệnh}; chưa rõ ${models['chưa rõ']})`;
  }
  if (projects) $('scan-footer').textContent += ` · Dự án: ${projects.known}/${projects.total} lần chạy xác định`
    + ` (trong đó ${projects.outsideClaude} ngoài thư mục project Claude)`;
  const crossText = crossProjectFooterText(scan.statistics?.crossProjects || projects);
  if (crossText) $('scan-footer').textContent += ` · ${crossText}`;
  const warnings = [...scan.warnings];
  if (scan.statistics?.excludedAgyCommands) warnings.push(
    `${scan.statistics.excludedAgyCommands} lệnh có nhắc agy chưa được phân làn: `
    + 'có thể là lệnh kiểm tra cài đặt, nội dung tham chiếu hoặc cách gọi shell chưa hỗ trợ.'
  );
  $('warnings').textContent = warnings.join(' ');
}
function updateProjects() {
  const filter = $('project-filter'), value = filter.value;
  const unknown = runs.filter(run => run.projectKey === '(không rõ)');
  const reasons = new Map();
  for (const run of unknown) reasons.set(run.unknownReason, (reasons.get(run.unknownReason) || 0) + 1);
  const summary = [...reasons].map(([reason, count]) => `${reason || 'cwd không khớp thư mục nào'}: ${count}`).join('; ');
  $('project-reasons').textContent = unknown.length ? `Không rõ dự án (${unknown.length}): ${summary}` : '';
  const projects = [...new Map(runs.map(r => [r.projectKey, {
    label: r.projectKey === '(không rõ)' ? `Không rõ dự án (${unknown.length})`
      : r.projectLabel + (r.outsideClaude ? ' (ngoài Claude)' : ''), outside: Boolean(r.outsideClaude),
  }])).entries()].sort((a, b) => Number(a[1].outside) - Number(b[1].outside) || a[1].label.localeCompare(b[1].label, 'vi'));
  const key = JSON.stringify([projects, summary]);
  if (filter.dataset.key === key) return;
  filter.dataset.key = key;
  filter.replaceChildren(element('option', '', 'Tất cả dự án')); filter.firstChild.value = '';
  let outsideGroup;
  for (const [key, project] of projects) {
    if (project.outside && !outsideGroup) {
      outsideGroup = element('optgroup'); outsideGroup.label = 'Ngoài Claude'; filter.append(outsideGroup);
    }
    const option = element('option', '', project.label); option.value = key;
    if (key === '(không rõ)') option.title = summary;
    (project.outside ? outsideGroup : filter).append(option);
  }
  if (projects.some(([key]) => key === value)) filter.value = value;
}
function updateModels() {
  const filter = $('model-filter'), value = filter.value;
  const start = end - hours * 3600_000;
  const models = countModels(runs.filter(run => run.start <= end && (run.end ?? Date.now()) >= start));
  const key = JSON.stringify(models);
  if (filter.dataset.key === key) return;
  filter.dataset.key = key;
  filter.replaceChildren(element('option', '', 'Tất cả model')); filter.firstChild.value = '';
  for (const { name, count } of models) {
    const option = element('option', '', `${name} (${count})`); option.value = name; filter.append(option);
  }
  filter.value = models.some(model => model.name === value) ? value : '';
}
async function loadRuns() {
  if (fetching) { fetchQueued = true; return; }
  fetching = true;
  const serial = ++requestNumber;
  const start = end - hours * 3600_000;
  try {
    const response = await fetch(`/api/runs?from=${encodeURIComponent(new Date(start).toISOString())}&to=${encodeURIComponent(new Date(end).toISOString())}`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (serial === requestNumber) { runs = data; updateProjects(); updateModels(); renderChart(); }
  } catch { $('warnings').textContent = 'Không nạp được dòng thời gian; sẽ thử lại khi nguồn cập nhật.'; }
  finally { fetching = false; if (fetchQueued) { fetchQueued = false; void loadRuns(); } }
}
function showDetails(run, pin = false) {
  if (document.documentElement?.classList?.contains('map-only') && !pin && !pinned) return;
  if (pinned && !pin && selected?.id !== run.id) return;
  selected = run; if (pin) pinned = true;
  $('details')?.classList?.toggle('open', true);
  $('detail-title').textContent = `${LANE_LABELS[run.lane] || run.lane} · ${run.kind}`;
  $('detail-hint').hidden = true; $('clear-detail').hidden = false;
  const names = { ok: 'thành công', error: 'lỗi', quota: 'hết quota', unknown: 'chưa rõ' };
  const fields = [
    ['Làn', LANE_LABELS[run.lane] || run.lane], ['Model', modelText(run, true)],
    ...(run.lane === 'Codex' ? [['Nguồn model', run.modelSource || 'chưa rõ']] : []),
    ...(modelNote(run) ? [['Ghi chú model', modelNote(run)]] : []),
    ['Bắt đầu', format(run.start)], ['Kết thúc', run.running ? 'Đang chạy' : format(run.end)],
    ['Trạng thái', run.running ? activityText(run) : names[run.status] || 'chưa rõ'],
    ['Thời lượng', duration((run.end ?? Date.now()) - run.start)], ['Kết quả', run.running ? 'chưa rõ · đang chạy' : names[run.status]],
    ['Dự án', run.unknownReason ? `không rõ vì ${run.unknownReason}` : (run.projectLabel || 'Không rõ dự án') + (run.outsideClaude ? ' (ngoài Claude)' : ''), true],
    ...(run.crossProject ? [['Giao chéo dự án', crossProjectDetailText(run), true]] : []),
    ['Thư mục dự án', run.projectPath || 'Chưa rõ', true], ['Mã phiên nguồn', run.sourceSession, true],
    ...(run.rolloutSession ? [['Mã rollout ghép', run.rolloutSession, true]] : []),
    ...(run.agySession ? [['Mã hội thoại agy ghép', run.agySession, true]] : []),
    ...(run.endEstimated ? [
      ['Độ chính xác', 'Giờ kết thúc ước lượng, thanh giới hạn tối đa 60 phút.', true],
      ['Mốc ước lượng ban đầu', format(run.endRaw), true],
    ] : []),
    ['Lời nhắc đầu tiên', run.prompt || 'Chưa trích xuất được', true],
    ...(run.promptSource ? [['Nguồn lời nhắc', run.promptSource, true]] : []),
    ['Căn cứ thời gian và kết quả', run.evidence, true],
  ];
  $('detail-fields').replaceChildren();
  for (const [name, value, wide] of fields) {
    const item = element('div', `detail-item${wide ? ' wide' : ''}`);
    item.append(element('dt', '', name), element('dd', '', value));
    $('detail-fields').append(item);
  }
  for (const bar of document.querySelectorAll('.run-bar')) bar.classList.toggle('selected', bar.dataset.id === run.id);
}
function renderChart() {
  const shell = $('chart-shell'), chart = $('chart'), scroll = shell.scrollLeft;
  const focusedId = document.activeElement?.classList.contains('run-bar') ? document.activeElement.dataset.id : null;
  const width = Math.max(960, shell.clientWidth) * zoom;
  chart.style.width = `${width}px`; chart.replaceChildren();
  // renderChart dựng lại DOM mỗi giây nên animation mới sinh sẽ bắt đầu từ 0. Đặt pha theo đồng hồ thật
  // (độ trễ âm bằng thời điểm hiện tại modulo chu kỳ) để nhịp nhấp nháy chạy liên tục qua các lần dựng lại.
  const wall = Date.now();
  for (const ms of [700, 1600, 2000, 2800]) chart.style.setProperty(`--phase-${ms}`, `-${wall % ms}ms`);
  const start = end - hours * 3600_000, span = end - start, areaWidth = width - 104;
  const axis = element('div', 'axis'); chart.append(axis);
  let previousRight = -Infinity;
  for (let i = 0; i <= 12; i++) {
    const tick = element('span', 'tick', tickFormat.format(start + span * i / 12));
    tick.style.left = `${i / 12 * 100}%`;
    if (i === 12) tick.style.transform = 'translateX(-100%)';
    axis.append(tick);
    const box = tick.getBoundingClientRect();
    if (box.left < previousRight + 8) tick.remove();
    else previousRight = box.right;
  }
  const crossValue = $('cross-filter')?.value || '';
  const filtered = runs.filter(r =>
    (!$('lane-filter').value || r.lane === $('lane-filter').value)
    && (!$('project-filter').value || r.projectKey === $('project-filter').value)
    && (!$('model-filter').value || modelLabel(r.model).name === $('model-filter').value)
    && matchesCrossFilter(r, crossValue)
    && Number.isFinite(r.start) && r.start <= end && (r.end ?? Date.now()) >= start
  );
  $('run-count').textContent = `${filtered.length} thanh hoạt động`;
  $('empty').hidden = filtered.length > 0;
  $('range-label').textContent = `${tickFormat.format(start)} đến ${tickFormat.format(end)}`;
  for (const lane of lanes.filter(l => !$('lane-filter').value || l === $('lane-filter').value)) {
    const own = filtered.filter(r => r.lane === lane).sort((a, b) => a.start - b.start);
    const track = element('div', 'track'); track.style.setProperty('--lane', colors[lane]);
    const label = element('div', 'lane-label', LANE_LABELS[lane]); label.title = LANE_LABELS[lane]; label.append(element('small', '', `${own.length} hoạt động`));
    const activeRuns = own.filter(run => run.running);
    if (activeRuns.length) {
      label.classList.toggle('activity-working', true);
      const phase = activeRuns.some(run => activityPhase(run) === 'giao') ? 'giao' : 'làm';
      label.append(element('span', 'activity-dot'));
      label.setAttribute('aria-label', `${LANE_LABELS[lane]}, ${activeRuns.length} đang chạy, đang ${phase}`);
    }
    const area = element('div', 'bar-area'), rows = [];
    for (const run of own) {
      const right = Math.min(areaWidth, ((run.end ?? Date.now()) - start) / span * areaWidth);
      const visualEnd = Math.max(6, right);
      const left = Math.max(0, Math.min((run.start - start) / span * areaWidth, visualEnd - 6));
      let row = rows.findIndex(value => value + 3 < left); if (row < 0) row = rows.length;
      rows[row] = visualEnd;
      const bar = element('button',
        `run-bar ${run.running ? 'running' : run.status}${run.kind === 'tương tác' ? ' interactive' : ''}`,
        `${lane === 'Claude' ? modelPrefix(run.model) : modelText(run)}: ${run.status === 'error' ? 'X ' : ''}${run.kind === 'kiểm tra' ? 'Kiểm tra: ' : ''}${run.prompt || run.kind}`
      );
      if (lane === 'Claude') {
        const family = modelLabel(run.model).family;
        bar.classList.toggle('claude-opus', family === 'opus');
        bar.classList.toggle('claude-sonnet', family === 'sonnet');
        bar.classList.toggle('claude-other', !['opus', 'sonnet'].includes(family));
      }
      bar.classList.toggle('estimated', Boolean(run.endEstimated));
      const narrow = visualEnd - left < 70;
      bar.classList.toggle('narrow', narrow);
      if (narrow) bar.textContent = '';
      if (run.running) {
        bar.classList.toggle('activity-delegating', activityPhase(run) === 'giao');
        if (visualEnd - left >= 150) {
          const content = bar.textContent; bar.textContent = '';
          bar.append(element('span', 'activity-phase', `đang ${activityPhase(run)}`), element('span', 'run-caption', content));
        }
        const dot = element('span', 'activity-dot run-now-dot'); dot.setAttribute('aria-hidden', 'true'); bar.append(dot);
      }
      bar.classList.toggle('cross-project', Boolean(run.crossProject));
      if (run.crossProject) {
        const mark = element('span', 'cross-project-mark'); mark.setAttribute('aria-hidden', 'true'); bar.append(mark);
      }
      bar.classList.toggle('continued', run.start < start);
      bar.style.left = `${left / areaWidth * 100}%`; bar.style.width = `${Math.max(0, visualEnd - left) / areaWidth * 100}%`; bar.style.top = `${16 + row * 30}px`;
      bar.dataset.id = run.id; bar.title = `${LANE_LABELS[run.lane]} · ${modelText(run, true)} · ${run.prompt || run.kind}`
        + (modelNote(run) ? ` · ${modelNote(run)}` : '')
        + (run.crossProject ? ` · ${crossProjectBarText(run)}` : '');
      if (run.start < start) bar.title += ' · Tiếp tục từ trước khung nhìn';
      if (run.running) bar.title += ` · Trạng thái: ${activityText(run)}`;
      const statusText = run.running ? activityText(run) : run.status === 'error' ? 'lỗi'
        : run.status === 'unknown' ? 'chưa rõ' : run.status;
      bar.setAttribute('aria-label', `${LANE_LABELS[run.lane]}, ${modelText(run)}, ${run.kind}, ${format(run.start)}, ${statusText}, ${run.prompt}`
        + (run.crossProject ? `, ${crossProjectBarText(run)}` : '')
        + (run.start < start ? ', tiếp tục từ trước khung nhìn' : '')
        + (run.endEstimated ? ', giờ kết thúc ước lượng' : ''));
      bar.classList.toggle('selected', selected?.id === run.id);
      bar.addEventListener('pointerenter', () => showDetails(run));
      bar.addEventListener('focus', () => showDetails(run));
      bar.addEventListener('click', () => showDetails(run, true));
      area.append(bar);
    }
    const height = Math.max(86, 32 + rows.length * 30); track.style.height = `${height}px`; label.style.height = `${height}px`;
    track.append(label, area); chart.append(track);
  }
  if (Date.now() >= start && Date.now() <= end) { const line = element('div', 'now-line'); line.style.left = `${104 + (Date.now() - start) / span * areaWidth}px`; chart.append(line); }
  shell.scrollLeft = scroll;
  if (focusedId) for (const bar of chart.querySelectorAll('.run-bar')) if (bar.dataset.id === focusedId) { bar.focus({ preventScroll: true }); break; }
  if (selected) { const updated = filtered.find(r => r.id === selected.id); if (updated) showDetails(updated, pinned); }
  $('next').disabled = following; $('zoom-out').disabled = zoom <= 1; $('zoom-in').disabled = zoom >= 8;
  $('focus-activity').disabled = filtered.length === 0;
  const claudeRuns = runs.filter(r => r.lane === 'Claude' && r.start <= end && (r.end ?? Date.now()) >= start
    && (!$('project-filter').value || r.projectKey === $('project-filter').value)
    && (!$('model-filter').value || modelLabel(r.model).name === $('model-filter').value)
    && matchesCrossFilter(r, crossValue));
  const scopeKey = `${hours}:${$('lane-filter').value}:${$('project-filter').value}:${$('model-filter').value}${crossValue ? `:${crossValue}` : ''}`;
  window.boardMindmap?.update(filtered, showDetails, scopeKey, claudeRuns, latestPerFamily(Object.keys(claudeLane()?.models7d || {})));
}
for (const button of document.querySelectorAll('[data-hours]')) button.addEventListener('click', () => {
  hours = Number(button.dataset.hours); zoom = 1;
  for (const other of document.querySelectorAll('[data-hours]')) other.setAttribute('aria-pressed', String(other === button));
  void loadRuns();
});
$('lane-filter').addEventListener('change', renderChart); $('project-filter').addEventListener('change', renderChart);
$('model-filter').addEventListener('change', renderChart); $('cross-filter')?.addEventListener('change', renderChart);
$('previous').addEventListener('click', () => { following = false; end -= hours * 1800_000; void loadRuns(); });
$('next').addEventListener('click', () => { end = Math.min(Date.now(), end + hours * 1800_000); following = Date.now() - end < 1000; void loadRuns(); });
$('now').addEventListener('click', () => { following = true; end = Date.now(); void loadRuns(); });
$('zoom-in').addEventListener('click', () => { zoom = Math.min(8, zoom * 2); renderChart(); });
$('zoom-out').addEventListener('click', () => { zoom = Math.max(1, zoom / 2); renderChart(); });
$('focus-activity').addEventListener('click', () => {
  const start = end - hours * 3600_000;
  const own = runs.filter(r => Number.isFinite(r.start) && r.start <= end && (r.end ?? Date.now()) >= start
    && (!$('lane-filter').value || r.lane === $('lane-filter').value)
    && (!$('project-filter').value || r.projectKey === $('project-filter').value)
    && (!$('model-filter').value || modelLabel(r.model).name === $('model-filter').value)
    && matchesCrossFilter(r, $('cross-filter')?.value || ''));
  const target = own.find(r => r.id === selected?.id);
  const focus = target ? [target] : own;
  if (!focus.length) return;
  const first = Math.max(start, Math.min(...focus.map(r => r.start)));
  const last = Math.min(end, Math.max(...focus.map(r => r.end ?? Date.now())));
  const span = Math.max(600_000, (last - first) * 1.15);
  hours = Math.min(hours, span / 3600_000);
  end = Math.min(Date.now(), last + span * .05); following = false; zoom = 1;
  for (const button of document.querySelectorAll('[data-hours]')) button.setAttribute('aria-pressed', String(Number(button.dataset.hours) === hours));
  $('chart-shell').scrollLeft = 0; void loadRuns();
});
$('clear-detail').addEventListener('click', () => {
  selected = null; pinned = false;
  $('details')?.classList?.toggle('open', false);
  $('detail-title').textContent = 'Chọn một thanh hoạt động';
  $('detail-hint').hidden = false; $('detail-fields').replaceChildren(); $('clear-detail').hidden = true;
  renderChart();
});
let drag;
$('chart-shell').addEventListener('pointerdown', event => {
  if (event.target.closest('button') || event.pointerType === 'touch') return;
  drag = { x: event.clientX, scroll: $('chart-shell').scrollLeft };
  $('chart-shell').setPointerCapture(event.pointerId); $('chart-shell').classList.add('dragging');
});
$('chart-shell').addEventListener('pointermove', event => { if (drag) $('chart-shell').scrollLeft = drag.scroll - event.clientX + drag.x; });
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('chart-shell').addEventListener(name, () => { drag = null; $('chart-shell').classList.remove('dragging'); });
window.addEventListener('resize', renderChart);
window.addEventListener('mindmap-ready', renderChart);
const events = new EventSource('/events');
events.addEventListener('state', event => {
  state = JSON.parse(event.data); $('connection').textContent = 'Đã kết nối trực tiếp'; renderState();
  const key = `${state.revision}:${hours}:${end}`;
  if (key !== lastRangeKey) { lastRangeKey = key; void loadRuns(); }
});
events.addEventListener('error', () => { $('connection').textContent = 'Đang kết nối lại'; });
fetch('/api/state').then(response => response.json()).then(data => { state = data; renderState(); }).catch(() => { $('connection').textContent = 'Chưa kết nối được'; });
setInterval(() => {
  $('clock').textContent = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(Date.now());
  renderCards();
  if (following) end = Date.now();
  if (!document.hidden) renderChart();
}, 1000);
renderChart(); void loadRuns();
