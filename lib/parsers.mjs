import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeActivityUsage } from './tokens.mjs';

export const LANES = ['Claude', 'Codex', 'Opus', 'Argon'];
export const stamp = value => {
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) ? number : null;
};
export function redact(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [đã che]')
    .replace(/\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;<>]+)/gi, '[đã che]')
    .replace(/\bsk-[\w-]+/gi, '[đã che]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[đã che]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
export const safe = (value, limit = 500) => redact(value).slice(0, limit);
export const identifier = value => {
  const text = String(value || '');
  if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(text)) return text;
  return redact(text) === text ? text.slice(0, 100) : `mã-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
};
export function promptPreview(value, limit = 200) {
  const line = redact(value).split(/\r?\n/).map(s => s.trim()).find(s => s && !/^<[^>]+>$/.test(s)) || '';
  return Array.from(line).slice(0, limit).join('');
}
export function modelLane(model) {
  if (/^claude-(?:opus|sonnet|haiku)/i.test(model)) return 'Opus';
  if (/^gemini-.*(?:argon|flash|pro)/i.test(model)) return 'Argon';
  return null;
}

// Tách đối số mà không thực thi lệnh, giữ nguyên đường dẫn Windows.
export function tokenize(command) {
  const tokens = [];
  let value = '', quote = '', quoted = false, started = false;
  const push = () => { if (started) tokens.push({ value, quoted }); value = ''; quoted = false; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '`' && command[i + 1]) {
      if (command[i + 1] === '\r' || command[i + 1] === '\n') {
        i++;
        if (command[i] === '\r' && command[i + 1] === '\n') i++;
      } else value += command[++i];
      started = true;
      continue;
    }
    if (c === '\\' && /["'\\]/.test(command[i + 1] || '') && quote !== "'") { value += command[++i]; started = true; continue; }
    if (quote) {
      if (c === quote) {
        if (command[i + 1] === quote && quote === "'") { value += c; i++; } else quote = '';
      } else value += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; quoted = true; started = true; continue; }
    if (c === '\n') { push(); tokens.push({ value: '\n', separator: true }); continue; }
    if (c === '#' && !started) { while (i < command.length && command[i] !== '\n') i++; push(); tokens.push({ value: '\n', separator: true }); continue; }
    if (/\s/.test(c)) { push(); continue; }
    const operator = command.slice(i).match(/^(?:(?:\d+|\*)?(?:>>?|<<-?|<)(?:&\d+)?|&&|\|\||[;&|()])/);
    if (operator && !started) { push(); tokens.push({ value: operator[0], separator: true }); i += operator[0].length - 1; continue; }
    if (/[;&|()<>]/.test(c)) { push(); i--; continue; }
    value += c; started = true;
  }
  push();
  return tokens;
}
function option(tokens, names) {
  for (let i = 0; i < tokens.length; i++) {
    for (const name of names) {
      if (tokens[i].value === name) return tokens[i + 1]?.value || '';
      if (tokens[i].value.startsWith(name + '=')) return tokens[i].value.slice(name.length + 1);
    }
  }
  return '';
}
export const missingPrompt = file => file
  ? `Lời nhắc truyền qua stdin từ tệp ${safe(path.win32.basename(file), 120)}`
  : 'Lời nhắc truyền qua stdin, không còn trong lệnh';
export const usablePrompt = value => typeof value === 'string' && Boolean(value.trim())
  && !/^(?:\d+|\*|[<>|&;]+|-)$/.test(value.trim())
  && !/^Lời nhắc truyền qua stdin/.test(value);

function stdinPrompt(command, tokens, index, end) {
  // Chỉ xét nguồn nối trực tiếp vào lần gọi này, tránh lấy stdin của lệnh khác.
  let pipe = index - 1;
  if (tokens[pipe]?.value === '&') pipe--;
  if (tokens[pipe]?.value === '|') {
    let begin = pipe - 1;
    while (begin >= 0 && !tokens[begin].separator) begin--;
    const input = tokens.slice(begin + 1, pipe);
    const name = path.win32.basename(input[0]?.value || '').toLowerCase();
    if (/^(?:get-content|cat)$/.test(name)) {
      let file = option(input, ['-Path', '-LiteralPath', '-path', '-literalpath']);
      for (let i = 1; !file && i < input.length; i++) {
        if (/^-(?:encoding|readcount|totalcount|tail)$/i.test(input[i].value)) { i++; continue; }
        if (!input[i].value.startsWith('-')) file = input[i].value;
      }
      return { promptFile: file || '' };
    }
    if (/^(?:echo|printf|write-output)$/.test(name)) {
      const values = input.slice(1).filter(t => !/^(?:-n|-e|%s|%s\\n)$/.test(t.value));
      return { prompt: values.map(t => t.value).join(' ') };
    }
    if (input.length === 1 && input[0].quoted) return { prompt: input[0].value.replace(/^@\r?\n|\r?\n@$/g, '') };
  }
  for (let i = end; i < tokens.length; i++) {
    if (/^(?:\||&&|;|&|\n)$/.test(tokens[i].value)) break;
    if (tokens[i].value === '<') return { promptFile: tokens[i + 1]?.value || '' };
    if (/^<<-?$/.test(tokens[i].value)) {
      const delimiter = tokens[i + 1]?.value;
      const occurrence = tokens.slice(0, i).filter((token, index) => /^<<-?$/.test(token.value) && tokens[index + 1]?.value === delimiter).length;
      const here = [...command.matchAll(/<<-?\s*["']?(\w+)["']?[^\n]*\n([\s\S]*?)\r?\n\1\b/g)]
        .filter(match => match[1] === delimiter)[occurrence];
      if (here) return { prompt: here[2] };
    }
  }
  return {};
}
export function parseCommands(command, depth = 0) {
  if (typeof command !== 'string' || depth > 3) return [];
  // Nội dung heredoc là dữ liệu đầu vào, không phải lệnh được thực thi tại đây.
  const executable = command.replace(/(<<-?\s*["']?(\w+)["']?[^\n]*\n)[\s\S]*?(\n\2(?=\r?\n|$))/g, '$1$3');
  const tokens = tokenize(executable);
  const variables = new Map();
  for (const match of command.matchAll(/(?:^|[;\r\n])\s*(\$?[A-Za-z_]\w*)\s*=\s*(["'])([^\r\n]*?)\2/g)) variables.set(match[1], match[3]);
  for (const token of tokens) {
    if (variables.has(token.value)) token.value = variables.get(token.value);
    else if (/^\$\w+$/.test(token.value) && variables.has(token.value.slice(1))) token.value = variables.get(token.value.slice(1));
  }
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.separator) continue;
    const base = path.win32.basename(token.value).toLowerCase();
    if (/^(?:powershell|pwsh|bash|sh)(?:\.exe)?$/.test(base)) {
      const rest = tokens.slice(i + 1);
      const inner = option(rest, ['-Command', '-command', '-c']);
      if (inner) found.push(...parseCommands(inner, depth + 1));
    }
    if (/^start-process$/i.test(base)) {
      let stop = i + 1;
      while (stop < tokens.length && (!tokens[stop].separator || tokens[stop].value === ',')) stop++;
      const args = tokens.slice(i + 1, stop);
      const binary = option(args, ['-FilePath', '-filepath']) || args.find(t => !t.value.startsWith('-'))?.value;
      const argList = option(args, ['-ArgumentList', '-argumentlist']);
      const name = path.win32.basename(binary || '');
      if (/^(?:agy|codex|powershell|pwsh)(?:\.exe|\.cmd)?$/i.test(name) && argList) found.push(...parseCommands(`${name} ${argList}`, depth + 1).map(run => ({ ...run, background: true })));
      i = stop - 1; continue;
    }
    if (!/^(?:codex(?:\.cmd|\.exe|\.js)?|agy(?:\.exe)?)$/.test(base)) continue;
    // Một tên chương trình được trích dẫn trong lời nhắc không phải lệnh thực.
    const previous = tokens[i - 1];
    const boundary = !previous || previous.separator || /^(?:call|&|sudo|env|nohup)$/.test(previous.value)
      || /^\$[\w]+=$/.test(previous.value)
      || /^\d+(?:s|m)?$/.test(previous.value) && tokens.slice(Math.max(0, i - 3), i).some(t => t.value === 'timeout')
      || base === 'codex.js' && /^(?:node|node\.exe)$/.test(path.win32.basename(previous.value));
    if (!boundary) continue;
    let end = i + 1;
    while (end < tokens.length && !tokens[end].separator) end++;
    const args = tokens.slice(i + 1, end);
    const codex = base.startsWith('codex');
    const execIndex = args.findIndex(t => t.value === 'exec');
    if (codex && execIndex < 0) continue;
    const model = option(args, ['--model', '-m']);
    const lane = codex ? 'Codex' : modelLane(model);
    if (!lane) continue;
    let prompt = codex ? '' : option(args, ['-p', '--prompt']);
    if (!prompt && codex) {
      const skip = new Set(['--model', '-m', '-C', '--cd', '-s', '--sandbox', '-c', '--config', '--output-last-message', '-o', '--json-schema', '--output-schema', '--profile', '-p', '--color', '--add-dir', '--ask-for-approval', '-a']);
      for (let j = execIndex + 1; j < args.length; j++) {
        if (skip.has(args[j].value)) { j++; continue; }
        if (args[j].value === '-') { prompt = '-'; break; }
        if (args[j].value.startsWith('-')) continue;
        prompt = args[j].value; break;
      }
    }
    let promptFile = '';
    if (!prompt || prompt === '-' || /^\$/.test(prompt)) {
      const input = stdinPrompt(command, tokens, i, end);
      prompt = input.prompt || variables.get(prompt) || '';
      promptFile = input.promptFile || '';
    }
    const preview = promptPreview(prompt);
    const promptSource = usablePrompt(preview) ? 'lệnh' : 'không có';
    found.push({
      lane, model: safe(model, 100), prompt: promptSource === 'lệnh' ? preview : missingPrompt(promptFile), promptSource,
      ...(codex ? { modelSource: model ? 'lệnh' : 'chưa rõ' } : {}),
      ...(promptFile ? { promptFile } : {}),
      kind: /^(?:pong|ping|quota|\/usage)[\s.!?]*$/i.test(preview)
        || /(?:chỉ|only|respond|reply).*\bpong\b/i.test(preview) ? 'kiểm tra' : 'giao việc',
      project: safe(option(args, ['-C', '--cd']), 400),
    });
    i = end - 1;
  }
  return found;
}

export function resultStatus(value, isError = false, exitCode) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (/quota|usage[ _-]*limit|rate[ _-]*limit|resource[ _-]*exhausted|\b429\b|you.ve hit your usage limit/i.test(text)) return 'quota';
  if (isError || (exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0)
    || /(?:exit(?:ed with)? code|exit_code)\s*[:=]?\s*[1-9]\d*|<status>failed<\/status>/i.test(text)) return 'error';
  return 'ok';
}
export function addActivity(segments, time, gap = 600_000) {
  if (time === null) return;
  let index = segments.findIndex(s => s.start > time);
  if (index < 0) index = segments.length;
  if (index && time - segments[index - 1].end <= gap) {
    segments[index - 1].end = Math.max(time, segments[index - 1].end);
    index--;
  } else segments.splice(index, 0, { start: time, end: time });
  while (index + 1 < segments.length && segments[index + 1].start - segments[index].end <= gap) {
    segments[index].end = Math.max(segments[index].end, segments[index + 1].end);
    mergeActivityUsage(segments[index], segments[index + 1]);
    segments.splice(index + 1, 1);
  }
  return segments[index];
}
const normalizedProject = value => String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
export function mergeCodex(assignments, rollouts) {
  const result = assignments.map(run => ({ ...run }));
  const candidates = result.filter(run => run.lane === 'Codex');
  // Chỉ mục giữ thứ tự lệnh gốc để hòa khoảng cách vẫn chọn như phép sắp xếp ổn định.
  const byProject = new Map(), bySession = new Map();
  const add = (map, key, item) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };
  candidates.forEach((run, order) => {
    const item = { run, order };
    add(byProject, normalizedProject(run.project), item);
    add(bySession, run.sourceSession, item);
  });
  const used = new Set();
  for (const rollout of [...rollouts].sort((a, b) => a.start - b.start)) {
    let match, bestDelta = Infinity, bestOrder = Infinity;
    if (rollout.kind !== 'tương tác') {
      for (const { run, order } of [
        ...(byProject.get(normalizedProject(rollout.project)) || []),
        ...(rollout.claudeSession ? bySession.get(rollout.claudeSession) || [] : []),
      ]) {
        const delta = Math.abs(run.start - rollout.start);
        if (!used.has(run.id) && delta <= 120_000 && (delta < bestDelta || delta === bestDelta && order < bestOrder)) {
          match = run; bestDelta = delta; bestOrder = order;
        }
      }
    }
    if (!match) result.push({ ...rollout });
    else {
      used.add(match.id);
      const quota = match.status === 'quota' || rollout.status === 'quota';
      const fromCommand = usablePrompt(match.prompt);
      Object.assign(match, {
        ...rollout, endEstimated: Boolean(rollout.endEstimated), endRaw: rollout.endRaw,
        id: match.id, sourceSession: match.sourceSession, rolloutSession: rollout.sourceSession,
        model: rollout.model || match.model,
        modelSource: rollout.model ? 'rollout' : match.model ? 'lệnh' : 'chưa rõ',
        effort: rollout.effort || '',
        prompt: fromCommand ? match.prompt : usablePrompt(rollout.prompt) ? rollout.prompt : missingPrompt(match.promptFile),
        promptSource: fromCommand ? match.promptSource || 'lệnh' : usablePrompt(rollout.prompt) ? 'rollout' : 'không có',
        kind: match.kind, projectKey: match.projectKey,
        status: quota ? 'quota' : rollout.status === 'unknown' && match.status !== 'unknown' ? match.status : rollout.status,
        merged: true,
      });
    }
  }
  return result;
}
export function validHost(host, port = 8090) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
