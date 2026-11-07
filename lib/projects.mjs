import path from 'node:path';
import os from 'node:os';
import { statSync } from 'node:fs';

export const UNKNOWN_PROJECT = {
  projectKey: '(không rõ)', projectLabel: 'Không rõ dự án', projectPath: '',
};
export function workspacePath(value) {
  let text = String(value || '').trim();
  if (/^file:\/\/\//i.test(text)) {
    try { text = decodeURIComponent(new URL(text).pathname).replace(/^\/(?=[a-z]:)/i, ''); } catch { return ''; }
  }
  text = text.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(text)) text = path.win32.normalize(text).replace(/\\/g, '/');
  else if (text.startsWith('/')) text = path.posix.normalize(text);
  return text.replace(/\/+$/, '');
}
// Cwd đã được chuẩn hóa ở đầu resolveProject; so tiền tố không cần xử lý lại từng thành phần.
const normalized = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const contains = (root, cwd) => normalized(cwd) === normalized(root)
  || normalized(cwd).startsWith(normalized(root) + '/');
export const temporaryWorkspace = cwd => contains(os.tmpdir(), cwd) || /\/(?:temp|tmp)(?:\/|$)/i.test(workspacePath(cwd));
export function scratchpadSession(cwd) {
  return workspacePath(cwd).match(/\/temp\/claude\/[^/]+\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/scratchpad(?:\/|$)/i)?.[1]?.toLowerCase() || '';
}

// Claude Code đặt tên thư mục project bằng cwd lúc khởi chạy với mọi ký tự không phải chữ hoặc số đổi thành "-".
export const slugOf = cwd => String(cwd || '').replace(/[^A-Za-z0-9]/g, '-').toLowerCase();

// Chỉ suy gốc từ cwd đã quan sát; không giải mã ngược slug bị mất thông tin.
// Ưu tiên cwd có slug khớp đúng tên thư mục project (chính xác kể cả khi cwd lang thang khỏi gốc);
// không có thì dùng cwd là tiền tố của mọi cwd còn lại.
export function projectCatalog(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.source !== 'claude' || !entry.projectKey) continue;
    if (!groups.has(entry.projectKey)) groups.set(entry.projectKey, new Set());
    for (const cwd of entry.cwds || []) if (cwd) groups.get(entry.projectKey).add(cwd);
  }
  const projects = [...groups].map(([projectKey, values]) => {
    const paths = [...values].sort((a, b) => a.length - b.length || a.localeCompare(b));
    const projectPath = paths.find(candidate => slugOf(candidate) === projectKey.toLowerCase())
      || paths.find(candidate => paths.every(cwd => contains(candidate, cwd))) || '';
    const projectLabel = projectPath ? path.win32.basename(projectPath) : projectKey;
    return { projectKey, projectPath, projectLabel };
  });
  return distinguishProjects(projects);
}

export function distinguishProjects(projects) {
  for (const project of projects) project.projectLabel = project.projectPath ? path.win32.basename(project.projectPath) : project.projectKey;
  const labels = new Map();
  for (const project of projects) labels.set(project.projectLabel, (labels.get(project.projectLabel) || 0) + 1);
  for (const project of projects) if (labels.get(project.projectLabel) > 1) {
    const parent = path.win32.basename(path.win32.dirname(project.projectPath));
    project.projectLabel = `${parent}/${project.projectLabel}`;
  }
  // Hai gốc có cả thư mục cha trùng tên vẫn cần nhãn phân biệt.
  const duplicates = new Set(projects.filter(project => projects.some(other =>
    other !== project && other.projectLabel === project.projectLabel)).map(project => project.projectLabel));
  for (const project of projects) if (duplicates.has(project.projectLabel)) project.projectLabel += ` (${project.projectKey})`;
  return projects;
}

// Bộ nhớ đệm chỉ sống trong một lần dựng kết quả, không giữ kết quả stat qua lượt quét.
export function projectResolver(projects) {
  const paths = new Map(), norms = new Map(), directories = new Map();
  const memo = (map, key, calculate) => {
    if (!map.has(key)) map.set(key, calculate(key));
    return map.get(key);
  };
  let count = -1, keys, roots;
  const sync = () => {
    if (count === projects.length) return;
    count = projects.length; keys = new Map();
    for (const project of projects) if (!keys.has(project.projectKey)) keys.set(project.projectKey, project);
    roots = projects.filter(project => !project.outsideClaude && project.projectPath)
      .map(project => ({ project, root: memo(norms, project.projectPath, normalized) }))
      .sort((a, b) => b.project.projectPath.length - a.project.projectPath.length);
  };
  const context = {
    direct: key => { sync(); return keys.get(key); },
    match: cwd => { sync(); return roots.find(({ root }) => cwd === root || cwd.startsWith(root + '/'))?.project; },
    workspace: value => memo(paths, value, workspacePath),
    normalize: value => memo(norms, value, normalized),
    directory: value => memo(directories, value, cwd => {
      try { return statSync(cwd).isDirectory(); } catch { return false; }
    }),
  };
  return run => resolveProject(run, projects, context);
}

export function resolveProject(run, projects, context) {
  const direct = context ? context.direct(run.projectKey) : projects.find(project => project.projectKey === run.projectKey);
  if (direct) return { ...direct, outsideClaude: Boolean(direct.outsideClaude), unknownReason: undefined };
  const cwd = (context?.workspace || workspacePath)(run.source === 'agy-db' ? run.workspace : run.project);
  const norm = context?.normalize || normalized;
  const normCwd = norm(cwd);
  let match = context?.match(normCwd);
  if (!context) for (const project of projects) {
    if (project.outsideClaude || !project.projectPath || match && match.projectPath.length >= project.projectPath.length) continue;
    const root = norm(project.projectPath);
    if (normCwd === root || normCwd.startsWith(root + '/')) match = project;
  }
  if (match) return { ...match, outsideClaude: false, unknownReason: undefined };
  if (cwd && !temporaryWorkspace(cwd) && !contains(path.join(os.homedir(), '.claude'), cwd)
    && (/^[a-z]:\//i.test(cwd) || process.platform !== 'win32' && path.isAbsolute(cwd))) {
    const projectKey = 'ngoài-claude:' + normalized(cwd);
    const existing = context ? context.direct(projectKey) : projects.find(project => project.projectKey === projectKey);
    if (existing) return { ...existing, outsideClaude: true, unknownReason: undefined };
    try {
      if (context ? context.directory(cwd) : statSync(cwd).isDirectory()) return {
        projectKey, projectLabel: path.win32.basename(cwd), projectPath: cwd, outsideClaude: true, unknownReason: undefined,
      };
    } catch { /* Đường dẫn không tồn tại hoặc không đọc được: giữ lý do chưa rõ. */ }
  }
  const unknownReason = run.source === 'agy-db' && !cwd ? 'agy: hội thoại không có thư mục làm việc đọc được'
    : run.lane === 'Codex' || run.source === 'codex-rollout'
      ? !cwd ? 'Codex: không ghi thư mục làm việc'
        : temporaryWorkspace(cwd) ? 'Codex: chạy ở thư mục tạm không rõ phiên Claude' : 'cwd không khớp thư mục nào'
      : 'cwd không khớp thư mục nào';
  return { ...UNKNOWN_PROJECT, outsideClaude: false, unknownReason };
}

export function executionDirectory(run) {
  if (!run || typeof run !== 'object') return '';
  if (run.source === 'agy-db') return workspacePath(run.workspace);
  if (run.source === 'codex-rollout') return workspacePath(run.project);
  if (run.source === 'claude-tool') {
    if (run.commandProject !== undefined) return workspacePath(run.commandProject);
    if (run.cwd !== undefined) {
      return normalized(workspacePath(run.project)) !== normalized(workspacePath(run.cwd)) ? workspacePath(run.project) : '';
    }
    return workspacePath(run.project);
  }
  return '';
}

export function resolveCrossProject(run, projectsOrResolve) {
  const resolve = typeof projectsOrResolve === 'function'
    ? projectsOrResolve
    : candidate => resolveProject(candidate, projectsOrResolve || []);
  const projectKey = run?.projectKey === '(không rõ)' ? '(không rõ)'
    : (run?.projectKey && !run.projectKey.startsWith('ngoài-claude:')
      ? resolve({ projectKey: run.projectKey }).projectKey
      : resolve(run || {}).projectKey) || '(không rõ)';
  const dir = executionDirectory(run);
  const work = dir && !temporaryWorkspace(dir) && !contains(path.join(os.homedir(), '.claude'), dir)
    ? resolve({ source: run?.source === 'agy-db' ? 'agy-db' : 'codex-rollout', workspace: dir, project: dir })
    : { ...UNKNOWN_PROJECT, outsideClaude: false };
  const eligible = Boolean(run && run.kind !== 'hoạt động' && run.kind !== 'tương tác'
    && projectKey !== '(không rõ)' && work.projectKey !== '(không rõ)');
  const crossProject = Boolean(eligible && work.projectKey !== projectKey);
  return {
    crossProject,
    eligible,
    ...(crossProject ? {
      workProjectKey: work.projectKey,
      workProjectLabel: work.projectLabel,
      workProjectPath: work.projectPath,
      workProjectOutsideClaude: Boolean(work.outsideClaude),
    } : {}),
  };
}
