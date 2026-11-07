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

export function modelSummary(runs, unit = '') {
  return countModels(runs).map(({ name, count }) => `${name} x ${count}${unit ? ` ${unit}` : ''}`).join(' · ');
}

export function modelPrefix(raw) {
  const label = modelLabel(raw);
  const prefix = { sonnet: 'S', opus: 'O', haiku: 'H' }[label.family];
  return prefix ? `${prefix} ${label.version}` : label.name;
}
