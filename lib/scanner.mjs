import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { addActivity, extractCodewhaleOutput, identifier, LANES, mergeCodewhale, mergeCodex, missingPrompt, parseCommands, promptPreview, resultStatus, safe, stamp, usablePrompt } from './parsers.mjs';
import { AgySource, mergeAgy } from './agy.mjs';
import { distinguishProjects, projectCatalog, projectResolver, resolveCrossProject, resolveProject, scratchpadSession, workspacePath } from './projects.mjs';
import { readPromptFile } from './prompt-files.mjs';
import { ScanWorkers } from './scan-workers.mjs';
import { readCodexDefault } from './codex-config.mjs';
import { addClaudeUsage, codewhaleTokens, codexTokens, laneTokenMetrics } from './tokens.mjs';

// Gốc dữ liệu suy ra từ thư mục home của người dùng đang chạy (laptop và desktop có tên người dùng khác nhau).
const home = os.homedir().replace(/\\/g, '/');
export const ROOTS = {
  claude: `${home}/.claude/projects`,
  codex: `${home}/.codex/sessions`,
  codexConfig: `${home}/.codex/config.toml`,
  agy: `${home}/.gemini/antigravity-cli`,
  codewhale: `${home}/.codewhale/sessions`,
};
// Các trường thời gian dạng số của sự kiện Codex dùng giây Unix; timestamp dòng là ISO.
const codexStamp = value => stamp(typeof value === 'number' && value >= 1e9 && value < 1e10 ? value * 1000 : value);
// Chỉ che lời nhắc còn được đoạn hoạt động tham chiếu; giải phóng văn bản gốc sau lần dùng đầu.
function deferredPrompt(text) {
  let preview;
  return () => {
    if (text !== undefined) { preview = promptPreview(text); text = undefined; }
    return preview;
  };
}
const activityPrompt = value => typeof value === 'function' ? value() : value || '';
export function rolloutPrompt(content) {
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (part.type !== 'input_text' || typeof part.text !== 'string') continue;
    let text = part.text.trim();
    const context = /^(?:#\s*AGENTS\.md\b|<(?:environment_context|user_instructions|permissions\b[^>]*|INSTRUCTIONS)(?:\s|>))/i;
    for (;;) {
      if (context.test(text)) { text = ''; break; }
      const wrapper = text.match(/^<([a-z_][\w:-]*)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>$/i);
      if (!wrapper) break;
      text = wrapper[2].trim();
    }
    const preview = promptPreview(text);
    if (usablePrompt(preview)) return preview;
  }
  return '';
}
export class Scanner extends EventEmitter {
  constructor(roots = ROOTS) {
    super();
    this.roots = roots;
    this.agy = new AgySource(roots.agy ? path.join(roots.agy, 'conversations') : null);
    this.files = new Map();
    this.live = [];
    this.warnings = new Map();
    this.scan = {
      initial: true, busy: false, scannedFiles: 0, totalFiles: 0, bytesRead: 0,
      lastScan: null, durationMs: 0, initialDurationMs: null, invalidLines: 0, warnings: [], agy: null,
    };
    this.revision = 0;
    this.busy = false;
    this.timers = [];
    this.cachedRuns = [];
    this.promptFiles = new Map();
    this.config = {};
    this.configReadAt = -Infinity;
  }
  warn(key, message) { this.warnings.set(key, message); }
  publish() { this.revision++; this.emit('change'); }
  async discover(root, source) {
    if (!root && source === 'codewhale') return;
    try {
      const walk = async dir => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (/obsolete|legacy|subagents|\.late-usage|\.deleted/i.test(entry.name)) continue;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (source === 'codewhale') {
            if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'session_boot_owners.json' && !this.files.has(file)) {
              this.files.set(file, this.makeFile(file, source));
            }
          } else if (entry.isFile() && entry.name.endsWith('.jsonl') && (source !== 'codex' || entry.name.startsWith('rollout-')) && !this.files.has(file)) {
            this.files.set(file, this.makeFile(file, source));
          }
        }
      };
      await walk(root);
      this.warnings.delete(source);
    } catch (error) {
      if (source === 'codewhale' && error?.code === 'ENOENT') { this.warnings.delete(source); return; }
      const label = source === 'claude' ? 'Claude' : source === 'codewhale' ? 'Codewhale' : 'Codex';
      this.warn(source, `Không đọc đầy đủ nguồn ${label}.`);
    }
  }
  makeFile(file, source) {
    const relative = this.roots.claude ? path.relative(this.roots.claude, file).split(path.sep) : [];
    return {
      projectKey: source === 'claude' && relative.length > 1 ? relative[0] : '', cwds: new Set(),
      file, source, offset: 0, size: 0, mtime: 0, seen: new Set(), segments: [], runs: new Map(), tasks: new Map(),
      session: identifier(path.basename(file, source === 'codewhale' ? '.json' : '.jsonl')), project: '', model: '', prompt: '', last: 0,
      rawAgy: 0, excludedAgy: 0, started: null, ended: null, latestStarted: null, latestComplete: null,
      originator: '', status: 'unknown', scanned: false, cwd: '', claudeSession: '', completed: false,
    };
  }
  async start() {
    await this.refresh(true);
    this.timers.push(setInterval(() => void this.refresh(false), 5000));
    this.timers.push(setInterval(() => { this.needsDiscovery = true; }, 30_000));
  }
  stop() {
    this.stopped = true;
    this.agy.stop();
    void this.readWorkers?.stop();
    for (const timer of this.timers) clearInterval(timer);
  }
  async refresh(discover = false) {
    if (this.busy || this.stopped) return;
    this.busy = true; this.scan.busy = true;
    const began = performance.now();
    let changed = this.scan.initial;
    try {
      if (Date.now() - this.configReadAt >= 60_000) {
        this.configReadAt = Date.now();
        this.config.codexDefault = await readCodexDefault(this.roots.codexConfig);
      }
      if (discover || this.needsDiscovery) {
        this.needsDiscovery = false;
        await this.discover(this.roots.claude, 'claude');
        await this.discover(this.roots.codex, 'codex');
        if (this.roots.codewhale) await this.discover(this.roots.codewhale, 'codewhale');
      }
      const agyBefore = new Map(this.agy.cache);
      const agyRefresh = this.agy.refresh();
      agyRefresh.catch(() => {}); // tránh lỗi chưa xử lý nếu vòng quét tệp thoát sớm; kết quả vẫn được chờ ở dưới
      this.scan.totalFiles = this.files.size;
      let progress = performance.now(), rebuilt = progress;
      const entries = [...this.files];
      const infos = await Promise.allSettled(entries.map(([file]) => stat(file)));
      const large = entries.map(([, entry], i) => entry.source !== 'codewhale' && !entry.scanned && infos[i].status === 'fulfilled' && infos[i].value.size >= 256 * 1024);
      const parallel = new Map();
      if (this.scan.initial && large.filter(Boolean).length >= 3) {
        this.readWorkers = new ScanWorkers(this.roots);
        // Xếp tệp lớn trước để tránh một luồng ôm tệp dài sau khi các luồng còn lại đã rảnh.
        entries.map(([file, entry], i) => ({ file, entry, i })).filter(item => large[item.i])
          .sort((a, b) => infos[b.i].value.size - infos[a.i].value.size)
          .forEach(({ file, entry, i }) => parallel.set(file, this.readWorkers.read(entry, infos[i].value.size)));
      }
      for (const [index, [file, original]] of entries.entries()) {
        if (this.stopped) break;
        let entry = original;
        try {
          if (infos[index].status === 'rejected') throw infos[index].reason;
          const info = infos[index].value;
          if (!entry.scanned || info.size !== entry.size || info.mtimeMs !== entry.mtime || info.ino !== entry.ino) changed = true;
          if (entry.source === 'codewhale') {
            if (entry.scanned && (info.size !== entry.size || info.mtimeMs !== entry.mtime || (entry.ino && entry.ino !== info.ino))) {
              entry = this.makeFile(file, entry.source); this.files.set(file, entry);
            }
            if (!entry.scanned || info.size !== entry.size || info.mtimeMs !== entry.mtime) await this.readCodewhale(entry, info.size);
          } else {
            if (info.size < entry.offset || (entry.scanned && info.mtimeMs !== entry.mtime && info.size <= entry.offset) || (entry.ino && entry.ino !== info.ino)) {
              entry = this.makeFile(file, entry.source); this.files.set(file, entry);
            }
            if (parallel.has(file)) {
              let read;
              try { read = await parallel.get(file); } catch { /* Luồng lỗi: đọc lại bằng cùng bộ phân tích trên luồng chính. */ }
              if (read) {
                entry = read.entry; this.files.set(file, entry);
                this.scan.bytesRead += read.bytesRead; this.scan.invalidLines += read.invalidLines;
                for (const [key, message] of read.warnings) this.warn(key, message);
              } else await this.readAppend(entry, info.size);
            } else if (!entry.scanned || info.size !== entry.size || info.mtimeMs !== entry.mtime) await this.readAppend(entry, info.size);
          }
          entry.size = info.size; entry.mtime = info.mtimeMs; entry.ino = info.ino; entry.scanned = true;
          this.warnings.delete(file);
        } catch {
          const label = entry.source === 'claude' ? 'Claude' : entry.source === 'codewhale' ? 'Codewhale' : 'Codex';
          this.warn(file, `Không đọc được một tệp ${label}.`);
        }
        if (performance.now() - progress > 400) {
          this.scan.scannedFiles = [...this.files.values()].filter(e => e.scanned).length;
          // rebuild() tốn theo số run nên chỉ dựng lại thưa (mỗi 5 giây); tiến độ vẫn cập nhật mỗi 400 ms.
          if (performance.now() - rebuilt > 5000) { this.rebuild(); rebuilt = performance.now(); }
          this.publish(); progress = performance.now();
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      this.scan.scannedFiles = [...this.files.values()].filter(e => e.scanned).length;
      await agyRefresh;
      changed ||= agyBefore.size !== this.agy.cache.size || [...this.agy.cache].some(([file, item]) => agyBefore.get(file) !== item);
      this.scan.agy = this.agy.statistics;
      const skipped = this.scan.agy.errors + this.scan.agy.skipped;
      if (skipped) this.warn('agy', `Nguồn hội thoại agy: ${this.scan.agy.errors} lỗi đọc, ${this.scan.agy.skipped} tệp thiếu model hoặc mốc giờ hợp lệ.`);
      else this.warnings.delete('agy');
      this.scan.lastScan = new Date().toISOString();
      // Không dựng hai lần cùng dữ liệu. runs()/state() luôn dựng theo giờ gọi để cửa sổ trực tiếp vẫn hết hạn đúng.
      if (changed) this.rebuild();
      if (await this.loadPromptFiles()) this.rebuild();
    } catch { this.warn('scan', 'Lượt quét bị gián đoạn; sẽ thử lại ở lượt kế tiếp.'); }
    finally {
      await this.readWorkers?.stop(); this.readWorkers = null;
      this.scan.durationMs = Math.round(performance.now() - began);
      if (this.scan.initial) this.scan.initialDurationMs = this.scan.durationMs;
      const memory = process.memoryUsage();
      this.scan.memory = { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
      this.scan.initial = false;
      this.busy = false; this.scan.busy = false; this.publish();
    }
  }
  async loadPromptFiles() {
    const files = new Set(this.cachedRuns.filter(run => ['Codex', 'DeepSeek'].includes(run.lane) && ['không có', 'tệp'].includes(run.promptSource)
      && run.promptFile && !run.rolloutSession && !run.codewhaleSession).map(run => run.promptFile));
    let changed = false;
    for (const file of this.promptFiles.keys()) if (!files.has(file)) { this.promptFiles.delete(file); changed = true; }
    const previews = await Promise.all([...files].map(async file => [file, await readPromptFile(file)]));
    for (const [file, preview] of previews) {
      if (this.promptFiles.get(file) !== preview) changed = true;
      this.promptFiles.set(file, preview);
    }
    return changed;
  }
  finishPrompts(entry) {
    if (entry.source !== 'claude') return;
    entry.prompt = activityPrompt(entry.prompt);
    for (const segment of entry.segments) segment.prompt = activityPrompt(segment.prompt);
  }
  async readCodewhale(entry, size) {
    if (size <= 0 || size > 16 * 1024 * 1024) return;
    const raw = await readFile(entry.file, 'utf8');
    this.scan.bytesRead += size;
    // Nội dung phiên (diff, tệp đã đọc) có thể chứa chuỗi giống khóa, kể cả khóa giả trong test; bảng chỉ lấy siêu dữ liệu
    // và lời nhắc qua safe()/redact() nên không bỏ cả phiên vì lý do đó.
    let data;
    try { data = JSON.parse(raw); } catch { this.scan.invalidLines++; return; }
    const meta = data?.metadata || {};
    entry.session = identifier(meta.id || entry.session);
    entry.model = safe(meta.model || '', 100);
    entry.cwd = typeof meta.workspace === 'string' ? meta.workspace : '';
    entry.claudeSession = scratchpadSession(entry.cwd);
    entry.project = safe(entry.cwd, 400);
    const times = [
      stamp(meta.created_at), stamp(meta.updated_at),
      ...(Array.isArray(data?.journal?.entries) ? data.journal.entries.map(item => stamp(item?.created_at)) : []),
    ].filter(t => t !== null);
    if (!times.length) { entry.started = null; return; }
    const turnMs = Number.isFinite(meta.cumulative_turn_secs) && meta.cumulative_turn_secs > 0
      ? Math.round(meta.cumulative_turn_secs * 1000) : 0;
    entry.ended = Math.max(...times);
    entry.started = Math.min(...times, turnMs ? entry.ended - turnMs : Infinity);
    entry.last = entry.ended;
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const firstUser = messages.find(m => m?.role === 'user');
    const userText = typeof firstUser?.content === 'string' ? firstUser.content
      : Array.isArray(firstUser?.content) ? firstUser.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
    const preview = promptPreview(userText) || promptPreview(meta.title || '');
    entry.prompt = usablePrompt(preview) ? preview : '';
    const lastMsg = messages.at(-1);
    const lastBlocks = Array.isArray(lastMsg?.content) ? lastMsg.content : [];
    entry.completed = Boolean(lastMsg && lastMsg.role === 'assistant' && !lastBlocks.some(b => b?.type === 'tool_use'));
    entry.tokens = codewhaleTokens(data?.usage || meta.usage || meta);
    // Tệp phiên chỉ có tổng gộp: giữ làm số liệu "chỉ tổng", không chia thành vào/ra (chưa đối chiếu với hóa đơn DeepSeek).
    if (!entry.tokens && Number.isSafeInteger(meta.total_tokens) && meta.total_tokens > 0) {
      entry.tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: meta.total_tokens, totalOnly: true };
    }
  }
  async readAppend(entry, size) {
    if (size <= entry.offset) return;
    const initialOffset = entry.offset;
    let pending = Buffer.alloc(0), consumed = initialOffset, dropping = false;
    let slice = performance.now();
    const input = createReadStream(entry.file, { start: initialOffset, end: size - 1, highWaterMark: 128 * 1024 });
    for await (const chunk of input) {
      this.scan.bytesRead += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0, newline;
      while ((newline = pending.indexOf(10, start)) !== -1) {
        const line = pending.subarray(start, newline).toString('utf8');
        if (!dropping) this.line(entry, line);
        dropping = false;
        consumed += newline - start + 1; start = newline + 1;
        if (performance.now() - slice >= 15) {
          await new Promise(resolve => setImmediate(resolve));
          slice = performance.now();
        }
      }
      pending = pending.subarray(start);
      if (pending.length > 16 * 1024 * 1024) {
        consumed += pending.length; pending = Buffer.alloc(0); dropping = true;
        this.warn('oversize', 'Đã bỏ qua dòng vượt 16 MiB để giới hạn bộ nhớ.');
      }
      entry.offset = consumed;
    }
    if (pending.length && !dropping) {
      const line = pending.toString('utf8');
      try { JSON.parse(line); this.line(entry, line); entry.offset = size; } catch { /* Giữ phần dòng chưa hoàn chỉnh để đọc lại. */ }
    }
  }
  line(entry, line) {
    if (!line || !line.includes('"timestamp"') && !line.includes('"session_meta"') && !line.includes('"cwd"')) return;
    const hasCommand = entry.source === 'claude' && (line.includes('codex') || line.includes('agy') || line.includes('codewhale') || line.includes('codew') || line.includes('deepseek-exec'));
    if (entry.source === 'codex' && !line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"event_msg"')
      && !line.includes('"token_usage_record"')
      && !(line.includes('"response_item"') && /"role"\s*:\s*"user"/.test(line))) {
      const time = stamp(line.match(/"timestamp"\s*:\s*"([^"\r\n]+)"/)?.[1]);
      if (time !== null) { entry.started ??= time; entry.last = Math.max(entry.last, time); }
      return;
    }
    let record;
    try { record = JSON.parse(line); } catch { this.scan.invalidLines++; return; }
    if (entry.source === 'claude') {
      if (typeof record.cwd === 'string' && record.cwd) entry.cwds.add(record.cwd.replace(/[\u0000-\u001f]/g, ''));
      this.claude(entry, record, hasCommand);
    }
    else this.codex(entry, record);
  }
  claude(entry, record, hasCommand) {
    if (!['assistant', 'user', 'system', 'progress'].includes(record.type)) return;
    const time = stamp(record.timestamp);
    if (time === null) return;
    if (record.uuid && entry.seen.has(record.uuid)) {
      if (record.type === 'assistant' && record.message?.usage) {
        const segment = entry.segments.find(segment => time >= segment.start && time <= segment.end);
        if (segment) addClaudeUsage(segment, record.message, record.uuid);
      }
      return;
    }
    if (record.uuid) entry.seen.add(record.uuid);
    entry.last = Math.max(entry.last, time);
    const cwd = record.cwd || entry.project;
    if (entry.safeCwdInput !== cwd) { entry.safeCwdInput = cwd; entry.safeCwd = safe(cwd, 400); }
    entry.project = entry.safeCwd;
    const session = record.sessionId || entry.session;
    if (entry.sessionInput !== session) { entry.sessionInput = session; entry.sessionValue = identifier(session); }
    entry.session = entry.sessionValue;
    if (record.message?.model && !/^</.test(record.message.model)) {
      if (entry.modelInput !== record.message.model) { entry.modelInput = record.message.model; entry.modelValue = safe(record.message.model, 100); }
      entry.model = entry.modelValue;
    }
    const segment = addActivity(entry.segments, time);
    if (record.type === 'assistant') addClaudeUsage(segment, record.message, record.uuid);
    const content = record.message?.content;
    if (record.type === 'user' && !record.isMeta) {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
      if (text && !/<task-notification>|<system-reminder>|<local-command/.test(text)) entry.prompt = deferredPrompt(text);
    }
    if (!segment.metaTime || time >= segment.metaTime) {
      Object.assign(segment, { model: entry.model, project: entry.project, prompt: entry.prompt, metaTime: time });
      if (record.isApiErrorMessage || record.type === 'system' && record.subtype === 'api_error') segment.status = resultStatus(record.message?.content || record.error || '', true);
    }
    if (!Array.isArray(content)) {
      if (record.type === 'user' && typeof content === 'string') this.notification(entry, content, time);
      return;
    }
    for (const item of content) {
      if (record.type === 'assistant' && item.type === 'tool_use' && /^(?:Bash|PowerShell)$/i.test(item.name) && hasCommand) {
        if (entry.runs.has(item.id)) continue;
        const command = item.input?.command || '';
        if (/agy\.exe/i.test(command)) entry.rawAgy++;
        const commands = parseCommands(command);
        if (/agy\.exe/i.test(command) && !commands.some(c => ['Opus', 'Argon'].includes(c.lane))) entry.excludedAgy++;
        if (!commands.length) continue;
        const runs = commands.map((parsed, i) => ({
          ...parsed, id: `claude:${entry.session}:${identifier(item.id)}:${i}`, source: 'claude-tool',
          sourceSession: entry.session, toolId: identifier(item.id), project: parsed.project || entry.project,
          commandProject: parsed.project && workspacePath(parsed.project).toLowerCase() !== workspacePath(entry.project).toLowerCase() ? parsed.project : '',
          start: time, end: null, status: 'unknown', background: Boolean(parsed.background || item.input?.run_in_background),
          evidence: 'Chưa có kết quả công cụ.',
        }));
        entry.runs.set(item.id, runs);
      }
      if (record.type === 'user' && item.type === 'tool_result') {
        const runs = entry.runs.get(item.tool_use_id);
        if (!runs) continue;
        const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content || '');
        const background = record.toolUseResult?.backgroundTaskId || text.match(/(?:task|background)[ _-]*(?:id)?\s*[:=]\s*([\w-]+)/i)?.[1];
        if (background) entry.tasks.set(background, item.tool_use_id);
        const stillRunning = /running in (?:the )?background|Command (?:is )?running|process running|still running/i.test(text) || Boolean(record.toolUseResult?.backgroundTaskId);
        const cw = runs.some(r => r.lane === 'DeepSeek') ? extractCodewhaleOutput(text) : null;
        for (const run of runs) {
          if (run.lane === 'DeepSeek' && cw) {
            if (cw.sessionHint) run.sessionHint = cw.sessionHint;
            if (cw.model && !run.model) { run.model = cw.model; run.modelSource = 'kết quả'; }
            if (cw.tokens) { run.tokens = cw.tokens; run.tokenSource = 'codewhale'; }
          }
          if (stillRunning) { run.background = true; run.evidence = 'Đang chờ thông báo hoàn tất tác vụ nền.'; if (resultStatus(text, item.is_error) === 'quota') run.status = 'quota'; }
          else {
            run.end = time; run.status = run.status === 'quota' ? 'quota' : resultStatus(text, item.is_error, record.toolUseResult?.exitCode);
            run.evidence = 'Ghép tool_result theo tool_use_id.';
          }
        }
      }
      if (record.type === 'user' && item.type === 'text') this.notification(entry, item.text || '', time);
    }
  }
  notification(entry, text, time) {
    if (!text.includes('<task-notification>')) return;
    for (const block of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const tag = name => block[1].match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim();
      const id = tag('tool-use-id') || entry.tasks.get(tag('task-id'));
      const runs = entry.runs.get(id);
      if (!runs) continue;
      const status = tag('status');
      if (!/completed|failed|killed|error/.test(status || '') && !/exit(?:ed with)? code\s*\d/i.test(block[1])) continue;
      const cw = runs.some(r => r.lane === 'DeepSeek') ? extractCodewhaleOutput(block[1]) : null;
      for (const run of runs) {
        if (run.lane === 'DeepSeek' && cw) {
          if (cw.sessionHint) run.sessionHint = cw.sessionHint;
          if (cw.model && !run.model) { run.model = cw.model; run.modelSource = 'kết quả'; }
          if (cw.tokens) { run.tokens = cw.tokens; run.tokenSource = 'codewhale'; }
        }
        run.end = time; run.status = run.status === 'quota' ? 'quota' : resultStatus(block[1], /failed|killed|error/.test(status));
        run.evidence = 'Ghép thông báo hoàn tất tác vụ nền theo mã công cụ hoặc mã tác vụ.';
      }
    }
  }
  codex(entry, record) {
    const time = stamp(record.timestamp);
    if (time !== null) { entry.started ??= time; entry.last = Math.max(entry.last, time); }
    const payload = record.payload || {};
    const tokens = codexTokens(record);
    if (tokens) entry.tokens = tokens;
    if (record.type === 'session_meta') {
      entry.session = identifier(payload.id || payload.session_id || entry.session);
      entry.cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      entry.claudeSession = scratchpadSession(entry.cwd);
      entry.project = safe(payload.cwd, 400); entry.originator = payload.originator || '';
      entry.started = stamp(payload.timestamp) ?? entry.started;
    }
    if (record.type === 'turn_context') {
      entry.model = safe(payload.model || entry.model, 100);
      entry.effort = safe(payload.effort || payload.collaboration_mode?.settings?.reasoning_effort || '', 30);
      if (typeof payload.cwd === 'string' && payload.cwd) {
        entry.cwd = payload.cwd; entry.claudeSession = scratchpadSession(payload.cwd);
        entry.project = safe(payload.cwd, 400);
      }
    }
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && !entry.prompt) {
      entry.prompt = rolloutPrompt(payload.content);
    }
    if (record.type !== 'event_msg') return;
    if (payload.type === 'user_message' && !entry.prompt) entry.prompt = promptPreview(payload.message);
    if (payload.type === 'task_started') { entry.latestStarted = codexStamp(payload.started_at) ?? time; entry.status = 'unknown'; }
    if (/^(?:task_complete|task_completed|turn_complete|turn_completed|task_failed|turn_aborted)$/.test(payload.type)) {
      entry.latestComplete = codexStamp(payload.completed_at) ?? time; entry.ended = entry.latestComplete;
      entry.status = resultStatus(payload.error || payload.last_agent_message || '', /failed|aborted/.test(payload.type) || Boolean(payload.error));
    }
    if (payload.type === 'error') entry.status = resultStatus(payload.message || payload.error, true);
  }
  rebuild(now = Date.now()) {
    const projects = projectCatalog(this.files.values());
    const resolve = projectResolver(projects);
    const sessions = new Map([...this.files.values()].filter(entry => entry.source === 'claude')
      .flatMap(entry => [[entry.session.toLowerCase(), entry.projectKey], [path.basename(entry.file, '.jsonl').toLowerCase(), entry.projectKey]]));
    const agyRuns = this.agy.runs(now);
    for (const candidate of [
      ...[...this.files.values()].filter(entry => entry.source === 'codex' || entry.source === 'codewhale').map(entry => ({ project: entry.cwd || entry.project })),
      ...agyRuns,
    ]) {
      const project = resolve(candidate);
      if (project.outsideClaude && !projects.some(existing => existing.projectKey === project.projectKey)) projects.push(project);
    }
    // Giữ quy tắc phân biệt nhãn cả với dự án ngoài Claude.
    distinguishProjects(projects);
    const assignments = [], rollouts = [], codewhaleSessions = [], segments = [];
    const stats = { rawAgyCommands: 0, excludedAgyCommands: 0, backgroundCompleted: 0, mergedCodex: 0, mergedCodewhale: 0 };
    for (const entry of this.files.values()) {
      if (entry.source === 'claude') {
        stats.rawAgyCommands += entry.rawAgy; stats.excludedAgyCommands += entry.excludedAgy;
        for (const group of entry.runs.values()) for (const run of group) {
          if (run.evidence.startsWith('Ghép thông báo')) stats.backgroundCompleted++;
          const endEstimated = run.end === null;
          const endRaw = endEstimated ? Math.max(run.start, entry.last) : undefined;
          assignments.push({
            ...run, projectKey: entry.projectKey, end: endEstimated ? Math.min(endRaw, run.start + 3600_000) : run.end,
            endEstimated, endRaw, status: run.status, running: false,
            tokens: run.tokens ? { ...run.tokens } : null, tokenSource: run.tokens ? run.tokenSource : null,
            evidence: endEstimated
              ? 'Ước lượng kết thúc bằng sự kiện cuối phiên Claude, giới hạn tối đa 60 phút; kết quả chưa rõ.'
              : run.evidence,
          });
        }
        entry.segments.forEach((segment, i) => {
          const running = i === entry.segments.length - 1 && now - entry.mtime < 60_000;
          segments.push({
            projectKey: entry.projectKey,
            id: `activity:${entry.session}:${i}`, lane: 'Claude', model: segment.model || entry.model,
            prompt: activityPrompt(segment.prompt), project: segment.project || entry.project, sourceSession: entry.session,
            start: segment.start, end: running ? null : segment.end, running, status: segment.status || 'unknown',
            kind: 'hoạt động', source: 'claude-session',
            tokens: segment.tokenTotals ? { ...segment.tokenTotals } : null,
            tokenSource: segment.tokenTotals ? 'claude' : null,
            evidence: 'Gộp hoạt động cùng phiên, cắt khi khoảng lặng vượt 10 phút.',
          });
        });
      } else if (entry.source === 'codewhale' && entry.started !== null) {
        const running = !entry.completed && now - entry.mtime >= 0 && now - entry.mtime < 90_000;
        codewhaleSessions.push({
          id: `codewhale:${entry.session}`, lane: 'DeepSeek', model: entry.model,
          modelSource: entry.model ? 'session' : 'chưa rõ',
          prompt: usablePrompt(entry.prompt) ? entry.prompt : missingPrompt(), promptSource: usablePrompt(entry.prompt) ? 'session' : 'không có',
          ...resolve({ workspace: entry.cwd || entry.project, project: entry.cwd || entry.project, lane: 'DeepSeek', source: 'codewhale-session', projectKey: sessions.get(entry.claudeSession) }),
          claudeSession: sessions.has(entry.claudeSession) ? entry.claudeSession : '',
          project: entry.project, workspace: entry.project, sourceSession: entry.session, start: entry.started,
          end: running ? null : entry.ended ?? entry.last, endEstimated: false, running, status: entry.status,
          kind: 'hội thoại', source: 'codewhale-session',
          tokens: entry.tokens ? { ...entry.tokens } : null, tokenSource: entry.tokens ? 'codewhale' : null,
          evidence: 'Phiên Codewhale trong ~/.codewhale/sessions; thời điểm lưu ở cuối lượt và trạng thái kết thúc chưa được xác minh riêng.',
        });
      } else if (entry.started !== null) {
        const completed = entry.latestComplete !== null && (entry.latestStarted === null || entry.latestComplete >= entry.latestStarted);
        const running = !completed && now - entry.mtime < 90_000;
        const endEstimated = !completed && !running;
        rollouts.push({
          id: `codex:${entry.session}`, lane: 'Codex', model: entry.model,
          effort: entry.effort || '', modelSource: entry.model ? 'rollout' : 'chưa rõ',
          prompt: usablePrompt(entry.prompt) ? entry.prompt : missingPrompt(), promptSource: usablePrompt(entry.prompt) ? 'rollout' : 'không có',
          ...resolve({ project: entry.cwd || entry.project, lane: 'Codex', projectKey: sessions.get(entry.claudeSession) }),
          claudeSession: sessions.has(entry.claudeSession) ? entry.claudeSession : '',
          project: entry.project, sourceSession: entry.session, start: entry.started,
          end: running ? null : completed ? entry.ended : Math.min(entry.last, entry.started + 3600_000),
          endEstimated, endRaw: endEstimated ? entry.last : undefined, running, status: entry.status,
          kind: entry.originator === 'codex_exec' ? 'giao việc' : 'tương tác', source: 'codex-rollout',
          tokens: entry.tokens ? { ...entry.tokens } : null, tokenSource: entry.tokens ? 'codex' : null,
          evidence: completed ? 'Sự kiện bắt đầu và hoàn tất trong rollout Codex.'
            : 'Chưa có sự kiện hoàn tất; ước lượng từ sự kiện cuối và mốc sửa tệp, giới hạn tối đa 60 phút.',
        });
      }
    }
    const codexMerged = mergeCodex(assignments, rollouts);
    stats.mergedCodex = codexMerged.filter(r => r.rolloutSession).length;
    const codewhaleMerged = mergeCodewhale(codexMerged, codewhaleSessions);
    stats.mergedCodewhale = codewhaleMerged.filter(r => r.codewhaleSession).length;
    const comparison = {};
    const merged = mergeAgy(codewhaleMerged, agyRuns, comparison);
    if (this.scan.agy) {
      this.scan.agy.merged = merged.filter(r => r.agySession).length;
      this.scan.agy.comparison = comparison;
    }
    this.cachedRuns = [...segments, ...merged].map(run => {
      const base = {
        ...run,
        ...(run.lane === 'Codex' || run.lane === 'DeepSeek' ? { modelSource: run.model ? run.modelSource || 'lệnh' : 'chưa rõ' } : {}),
        ...(['Codex', 'DeepSeek'].includes(run.lane) && !run.rolloutSession && !run.codewhaleSession && run.promptSource === 'không có' && usablePrompt(this.promptFiles.get(run.promptFile))
          ? { prompt: this.promptFiles.get(run.promptFile), promptSource: 'tệp' } : {}),
        ...resolve(run),
      };
      return { ...base, ...resolveCrossProject(base, resolve) };
    })
      .sort((a, b) => a.start - b.start);
    this.projects = projects;
    const crossCount = this.cachedRuns.filter(run => run.crossProject).length;
    const crossTotal = this.cachedRuns.filter(run => run.eligible).length;
    this.scan.statistics = {
      ...stats, counts: Object.fromEntries(LANES.map(lane => [lane, this.cachedRuns.filter(r => r.lane === lane).length])),
      assignments: Object.fromEntries(LANES.map(lane => [lane,
        this.cachedRuns.filter(r => r.lane === lane && r.kind !== 'tương tác' && r.kind !== 'hoạt động').length,
      ])),
      codexPrompts: Object.fromEntries(['lệnh', 'rollout', 'tệp', 'không có'].map(source => [source,
        this.cachedRuns.filter(run => run.lane === 'Codex' && run.kind !== 'tương tác' && run.promptSource === source).length,
      ])),
      codexModels: Object.fromEntries(['rollout', 'lệnh', 'chưa rõ'].map(source => [source,
        this.cachedRuns.filter(run => run.lane === 'Codex' && run.kind !== 'tương tác' && run.modelSource === source).length,
      ])),
      codewhale: {
        sessionsRead: codewhaleSessions.length,
        merged: stats.mergedCodewhale,
      },
      projects: {
        total: this.cachedRuns.length, known: this.cachedRuns.filter(run => run.projectKey !== '(không rõ)').length,
        outsideClaude: this.cachedRuns.filter(run => run.outsideClaude).length,
        crossProject: crossCount, crossProjectTotal: crossTotal,
      },
      crossProjects: { count: crossCount, total: crossTotal },
    };
  }
  runs(now = Date.now()) {
    // Cửa sổ trực tiếp cũng hết hạn ngay cả khi tệp không đổi.
    this.rebuild(now);
    const resolve = projectResolver(this.projects);
    const result = this.cachedRuns.map(r => ({ ...r }));
    const matched = new Set();
    for (const live of this.live) {
      const candidate = result.filter(r =>
        !matched.has(r.id) && r.lane === live.lane && (r.model === live.model || !r.model || ['Codex', 'DeepSeek'].includes(live.lane))
        && Math.abs(r.start - live.start) <= 120_000
      ).sort((a, b) => Math.abs(a.start - live.start) - Math.abs(b.start - live.start))[0];
      if (candidate) matched.add(candidate.id);
      if (candidate) Object.assign(candidate, {
        ...(['Codex', 'DeepSeek'].includes(candidate.lane) && live.model && live.model !== candidate.model ? { modelSource: 'lệnh', effort: '' } : {}),
        running: true, end: null, endEstimated: false, endRaw: undefined, model: live.model || candidate.model,
      });
      else result.push({
        ...live, id: `process:${live.pid}`, sourceSession: 'Chỉ có tín hiệu tiến trình', kind: 'giao việc',
        source: 'process', end: null, running: true, status: 'unknown',
        evidence: 'Tiến trình đang chạy; chưa ghép được bản ghi nguồn.',
      });
    }
    // Chặn mốc lỗi ở lớp dữ liệu dùng chung cho cả hai API và SSE.
    return result.map(run => {
      const start = Math.min(run.start, now);
      const end = run.end == null ? null : Math.max(start, Math.min(run.end, now));
      const timeAdjusted = start !== run.start || end !== run.end;
      const resolved = resolve(run);
      const cross = resolveCrossProject({ ...run, ...resolved }, resolve);
      const { commandProject, sessionHint, eligible, workProjectKey, workProjectLabel, workProjectPath, workProjectOutsideClaude, ...rest } = {
        ...run, ...resolved, ...cross,
      };
      return {
        ...rest,
        tokens: run.tokens ? { ...run.tokens } : null,
        tokenSource: run.tokens ? run.tokenSource : null,
        ...(cross.crossProject ? {
          workProjectKey, workProjectLabel,
          workProjectPath: safe(workProjectPath, 400),
          workProjectOutsideClaude,
        } : {}),
        ...(run.lane === 'Codex' ? { modelSource: run.model ? run.modelSource === 'rollout' ? 'rollout' : 'lệnh' : 'chưa rõ' } : {}),
        ...(run.lane === 'DeepSeek' ? { modelSource: run.model ? run.modelSource || 'lệnh' : 'chưa rõ' } : {}),
        ...(run.promptFile ? { promptFile: safe(run.promptFile, 400) } : {}),
        ...(run.workspace ? { workspace: safe(run.workspace, 400) } : {}),
        start, end, timeAdjusted,
        evidence: run.evidence + (timeAdjusted
          ? ' Mốc bất hợp lệ đã chặn về hiện tại hoặc giờ bắt đầu; thời lượng này không chứng minh thời lượng thực.' : ''),
      };
    });
  }
  state(now = Date.now()) {
    const runs = this.runs(now);
    this.scan.warnings = [...new Set(this.warnings.values())];
    if (this.scan.invalidLines) this.scan.warnings.push(`Đã bỏ qua ${this.scan.invalidLines} dòng JSON không hợp lệ.`);
    return { revision: this.revision, now, config: { ...this.config }, lanes: LANES.map(lane => {
      const own = runs.filter(r => r.lane === lane).sort((a, b) => b.start - a.start);
      const running = own.find(r => r.running), recent = running || own[0];
      const knownModel = lane === 'Codex' ? own.find(r => r.model) : recent;
      const last24h = own.filter(r => r.start >= now - 86_400_000);
      const last7d = own.filter(r => r.start >= now - 7 * 86_400_000);
      const countByModel = list => Object.fromEntries([...new Set(list.map(r => r.model || ''))]
        .map(model => [model, list.filter(r => (r.model || '') === model).length]));
      return {
        lane, state: running ? 'Đang chạy' : ['error', 'quota'].includes(recent?.status) ? 'Lỗi gần nhất' : 'Rảnh',
        model: recent?.model || 'Chưa rõ', prompt: promptPreview(recent?.prompt, 120),
        knownModel: knownModel?.model || '', effort: knownModel?.effort || '',
        models24h: countByModel(last24h),
        ...laneTokenMetrics(own, now),
        // Model đã dùng trong 7 ngày: giao diện liệt kê cả model chưa dùng trong khung đang xem (ví dụ Opus 5.5 của Claude).
        models7d: countByModel(last7d),
        promptSource: recent?.promptSource,
        promptTitle: promptPreview(recent?.prompt), project: recent?.project || 'Chưa rõ',
        ...resolveProject(recent || {}, this.projects),
        crossProject: Boolean(recent?.crossProject),
        ...(recent?.crossProject ? {
          workProjectKey: recent.workProjectKey,
          workProjectLabel: recent.workProjectLabel,
          workProjectPath: recent.workProjectPath,
          workProjectOutsideClaude: recent.workProjectOutsideClaude,
        } : {}),
        start: recent?.start ?? null, end: recent?.end ?? null, running: Boolean(running),
        activeCount: own.filter(r => r.running).length,
        count24h: own.filter(r => r.start >= now - 86_400_000 && r.kind !== 'hoạt động' && r.kind !== 'tương tác').length,
        activity24h: own.filter(r => r.start >= now - 86_400_000).length, status: recent?.status || 'unknown',
      };
    }), scan: { ...this.scan } };
  }
}
