export const LANE_LABELS = Object.freeze({
  Claude: 'Claude Code', Codex: 'Codex', Opus: 'Antigravity Opus', Argon: 'Gemini Argon',
});

export function modelLabel(rawModel) {
  const raw = typeof rawModel === 'string' ? rawModel : '';
  const label = { name: raw || 'Chưa rõ model', family: '', version: '', effort: '', raw };
  const suffix = raw.match(/-(low|medium|high|xhigh)$/);
  const base = suffix ? raw.slice(0, -suffix[0].length) : raw;
  let match = base.match(/^claude-(opus|sonnet|haiku)-(\d+(?:[-.]\d+)*)$/);
  if (match) {
    label.family = match[1]; label.version = match[2].replaceAll('-', '.');
    label.name = `${match[1][0].toUpperCase()}${match[1].slice(1)} ${label.version}`;
    label.effort = suffix?.[1] || '';
  } else if ((match = base.match(/^gemini-(\d+(?:[-.]\d+)*)-(argon|flash|pro)(-lite)?$/))) {
    label.family = match[2]; label.version = match[1].replaceAll('-', '.');
    label.name = match[2] === 'argon' ? 'Gemini Argon'
      : `Gemini ${label.version} ${match[2] === 'flash' ? 'Flash' : 'Pro'}${match[3] ? ' Lite' : ''}`;
    label.effort = suffix?.[1] || '';
  } else if (raw.startsWith('gpt-')) label.family = 'gpt';
  return label;
}

export function modelFamilyLane(lane, label) {
  const expected = lane === 'Argon' || lane === LANE_LABELS.Argon ? 'argon'
    : lane === 'Opus' || lane === LANE_LABELS.Opus ? 'opus' : '';
  return { offLabel: Boolean(expected && label.raw && label.family !== expected) };
}

export function modelText(run, includeRaw = false) {
  const label = modelLabel(run.model);
  if (!label.raw && run.lane === 'Codex') return 'Chưa rõ model (lệnh không ghi -m, chưa ghép rollout)';
  const effort = run.effort || label.effort;
  return label.name + (effort ? ` · ${effort}` : '') + (includeRaw && label.raw ? ` (${label.raw})` : '');
}

export function modelNote(run) {
  return modelFamilyLane(run.lane, modelLabel(run.model)).offLabel ? 'model khác tên làn' : '';
}

export function countModels(runs) {
  const counts = new Map();
  for (const run of runs) {
    const name = modelLabel(run.model).name;
    counts.set(name, (counts.get(name) || 0) + (run.count ?? 1));
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
}

// Phiên bản mới nhất của mỗi họ model trong danh sách id thô (Opus 5.5 thắng Opus 4.8, Sonnet 5.5 thắng Sonnet 5).
// Dùng để chỉ liệt kê "số 0" cho model hiện hành, tránh làm rối bằng các model cũ đã ngừng dùng.
export function latestPerFamily(rawIds) {
  const parts = value => String(value || '').split('.').map(Number).filter(Number.isFinite);
  const newer = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff) return diff > 0;
    }
    return false;
  };
  const best = new Map();
  for (const raw of rawIds || []) {
    if (!raw) continue;
    const { family, version } = modelLabel(raw);
    const key = family || raw, current = best.get(key), candidate = parts(version);
    if (!current || newer(candidate, current.parts)) best.set(key, { raw, parts: candidate });
  }
  return [...best.values()].map(item => item.raw);
}

export function modelSummary(runs, unit = '') {
  return countModels(runs).map(({ name, count }) => `${name} x ${count}${unit ? ` ${unit}` : ''}`).join(' · ');
}

export function modelPrefix(raw) {
  const label = modelLabel(raw);
  const prefix = { sonnet: 'S', opus: 'O', haiku: 'H' }[label.family];
  return prefix ? `${prefix} ${label.version}` : label.name;
}

export const CROSS_PROJECT_LEGEND = 'Mũi tên nhỏ = giao chéo sang dự án khác';
export const CROSS_FILTER_OPTIONS = Object.freeze([
  { value: '', label: 'Tất cả' },
  { value: 'cross', label: 'Chỉ giao chéo' },
  { value: 'same', label: 'Không giao chéo' },
]);

// Đường dẫn Windows hiển thị bằng dấu gạch chéo ngược, đồng nhất với "Thư mục dự án" ở panel chi tiết.
function displayPath(value) {
  const text = String(value || '');
  return /^[A-Za-z]:[\\/]/.test(text) ? text.replace(/\//g, '\\') : text;
}

export function workProjectDisplay(run) {
  if (!run?.crossProject || !run.workProjectLabel) return '';
  return `${run.workProjectLabel}${run.workProjectOutsideClaude ? ' (ngoài Claude)' : ''}`;
}

export function crossProjectLabel(run) {
  if (!run?.crossProject) return '';
  const from = run.projectLabel || run.projectKey || 'Không rõ dự án';
  const to = workProjectDisplay(run);
  return to ? `Giao từ ${from}, làm việc ở ${to}` : '';
}

export function crossProjectCardText(run) {
  if (!run?.crossProject) return run?.projectLabel || '';
  const from = run.projectLabel || run.projectKey || 'Không rõ dự án';
  const to = workProjectDisplay(run);
  return `${from} → ${to}`;
}

export function crossProjectCardTitle(run) {
  if (!run?.crossProject) return run?.unknownReason || run?.projectLabel || '';
  return `${crossProjectLabel(run)}${run.workProjectPath ? ` (${displayPath(run.workProjectPath)})` : ''}`;
}

export function crossProjectDetailText(run) {
  if (!run?.crossProject) return '';
  const from = run.projectLabel || run.projectKey || 'Không rõ dự án';
  const to = workProjectDisplay(run);
  const pathSuffix = run.workProjectPath ? ` (${displayPath(run.workProjectPath)})` : '';
  return `Phiên Claude ở dự án ${from} giao việc cho ${modelText(run)} làm việc ở dự án ${to}${pathSuffix}`;
}

export function crossProjectBarText(run) {
  if (!run?.crossProject) return '';
  return `giao chéo sang dự án ${workProjectDisplay(run)}`;
}

export function crossProjectLeafText(run) {
  if (!run?.crossProject) return '';
  return `giao chéo: làm việc ở dự án ${workProjectDisplay(run)}`;
}

export function crossProjectNodeText(count) {
  return count > 0 ? `${count} lần giao chéo sang dự án khác` : '';
}

export function crossProjectFooterText(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const count = stats.count ?? stats.cross ?? stats.crossProject;
  const total = stats.total ?? stats.eligible ?? stats.crossProjectTotal;
  if (count == null || total == null) return '';
  return `Giao chéo dự án: ${count}/${total} lần giao`;
}

export function matchesCrossFilter(run, filterValue = '') {
  const value = String(filterValue || '').trim();
  if (!value || value === 'all' || value === 'Tất cả') return true;
  if (value === 'cross' || value === 'only' || value === 'true' || value === 'Chỉ giao chéo') return Boolean(run?.crossProject);
  if (value === 'same' || value === 'none' || value === 'false' || value === 'Không giao chéo') return !run?.crossProject;
  return true;
}
