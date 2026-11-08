import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { identifier, modelLane, promptPreview } from './parsers.mjs';
import { workspacePath } from './projects.mjs';
import { addAgyUsage } from './tokens.mjs';

const MODEL = /^(claude-(opus|sonnet|haiku)-[0-9a-z.\-]+|gemini-[0-9a-z.\-]*(argon|flash|pro)[0-9a-z.\-]*)$/;
const TOKEN_LIMIT = 2_000_000, MAX_DEPTH = 6, MAX_FIELDS = 4000;
const yieldThread = () => new Promise(resolve => setImmediate(resolve));
const bytesOf = blob => {
  if (blob instanceof Uint8Array) return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  try { return Buffer.from(blob || []); } catch { return Buffer.alloc(0); }
};

function varint(bytes, offset, end = bytes.length) {
  let value = 0, scale = 1;
  for (let i = offset; i < end && i < offset + 10; i++) {
    if (i === offset + 9 && bytes[i] > 1) return null;
    value += (bytes[i] & 127) * scale;
    if (!(bytes[i] & 128)) return { value, next: i + 1 };
    scale *= 128;
  }
  return null;
}

function validMessage(bytes, start, end) {
  if (start >= end) return false;
  for (let offset = start; offset < end;) {
    const tag = varint(bytes, offset, end);
    if (!tag || tag.value < 8) return false;
    offset = tag.next;
    const wire = tag.value % 8;
    if (wire === 0) {
      const value = varint(bytes, offset, end);
      if (!value) return false;
      offset = value.next;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > end) return false;
    } else if (wire === 2) {
      const length = varint(bytes, offset, end);
      if (!length || length.value > end - length.next) return false;
      offset = length.next + length.value;
    } else return false;
  }
  return true;
}

function readUsage(bytes, start, end) {
  if (!validMessage(bytes, start, end)) return null;
  let model = null, input = null, output = null, cacheRead = 0, fields = 0;
  for (let offset = start; offset < end;) {
    if (++fields > MAX_FIELDS) return null;
    const tag = varint(bytes, offset, end);
    offset = tag.next;
    const field = Math.floor(tag.value / 8), wire = tag.value % 8;
    if (field >= 1 && field <= 5 && wire !== 0) return null;
    if (wire === 0) {
      const { value, next } = varint(bytes, offset, end);
      offset = next;
      if (field === 1) {
        if (value < 1000 || value >= 5000) return null;
        model = value;
      } else if (field >= 2 && field <= 5) {
        if (value > TOKEN_LIMIT) return null;
        if (field === 2) input = value;
        else if (field === 3) output = value;
        else if (field === 5) cacheRead = value;
      }
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else {
      const length = varint(bytes, offset, end);
      offset = length.next + length.value;
    }
  }
  if (model === null || input === null || output === null || input + output > TOKEN_LIMIT) return null;
  return { input, cacheRead, output };
}

function scanMessage(bytes, start, end, onField) {
  if (!validMessage(bytes, start, end)) return null;
  for (let offset = start; offset < end;) {
    const tag = varint(bytes, offset, end);
    offset = tag.next;
    const field = Math.floor(tag.value / 8), wire = tag.value % 8;
    let subStart = 0, subEnd = 0;
    if (wire === 0) offset = varint(bytes, offset, end).next;
    else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else {
      const length = varint(bytes, offset, end);
      subStart = length.next; subEnd = subStart + length.value;
      offset = subEnd;
    }
    const result = onField(field, wire, subStart, subEnd);
    if (result !== undefined) return result;
  }
  return null;
}

export function extractGenerationTokens(blob) {
  const bytes = bytesOf(blob);
  let visited = 0;
  // Đường chuẩn: trường 1 (chat_model) -> trường 4 (usage); dự phòng duyệt đệ quy có giới hạn.
  const direct = scanMessage(bytes, 0, bytes.length, (field, wire, start, end) => {
    if (++visited > MAX_FIELDS) return null;
    if (field !== 1 || wire !== 2) return;
    return scanMessage(bytes, start, end, (innerField, innerWire, uStart, uEnd) => {
      if (++visited > MAX_FIELDS) return null;
      if (innerField === 4 && innerWire === 2) return readUsage(bytes, uStart, uEnd) || undefined;
    }) ?? undefined;
  });
  if (direct) return direct;
  visited = 0;
  const search = (start, end, depth) => depth > MAX_DEPTH ? null : scanMessage(bytes, start, end, (_field, wire, subStart, subEnd) => {
    if (++visited > MAX_FIELDS) return null;
    if (wire !== 2) return;
    return readUsage(bytes, subStart, subEnd) || search(subStart, subEnd, depth + 1) || undefined;
  });
  return search(0, bytes.length, 1);
}

// Chỉ lần theo trường độ dài hợp lệ; không coi toàn bộ blob là lời nhắc.
function textFields(bytes, depth = 0) {
  if (depth > 8) return [];
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    const tag = varint(bytes, offset);
    if (!tag || tag.value < 8) return [];
    offset = tag.next;
    const wire = tag.value % 8;
    if (wire === 0) {
      const value = varint(bytes, offset);
      if (!value) return [];
      offset = value.next;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
    } else if (wire === 2) {
      const length = varint(bytes, offset);
      if (!length || length.value > bytes.length - length.next) return [];
      const value = bytes.subarray(length.next, length.next + length.value);
      offset = length.next + length.value;
      const nested = textFields(value, depth + 1);
      if (nested.length) { result.push(...nested); continue; }
      let text = '';
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { /* Bỏ trường nhị phân. */ }
      if (text && !/[\p{C}]/u.test(text.replace(/[\r\n\t]/g, ''))) result.push(text);
    } else return [];
    if (offset > bytes.length) return [];
  }
  return result;
}

export function extractModel(blob) {
  if (!blob) return '';
  const text = bytesOf(blob).toString('utf8'), tokens = /[A-Za-z0-9_.-]+/g;
  let match;
  while ((match = tokens.exec(text))) if (match[0].length <= 100 && MODEL.test(match[0])) return match[0];
  return '';
}

export function extractTimes(blob, ceiling = Date.now()) {
  const bytes = bytesOf(blob);
  // Chỉ trường đầu metadata: trường 1, kiểu độ dài; bên trong là seconds/nanos.
  if (bytes[0] !== 10) return [];
  const length = varint(bytes, 1);
  if (!length || !length.value || length.value > bytes.length - length.next) return [];
  const timestamp = bytes.subarray(length.next, length.next + length.value);
  if (timestamp[0] !== 8) return [];
  const seconds = varint(timestamp, 1);
  if (!seconds) return [];
  if (seconds.next !== timestamp.length) {
    if (timestamp[seconds.next] !== 16) return [];
    const nanos = varint(timestamp, seconds.next + 1);
    if (!nanos || nanos.value >= 1e9 || nanos.next !== timestamp.length) return [];
  }
  const time = seconds.value * 1000;
  return seconds.value >= 1.7e9 && seconds.value <= 1.9e9 && time <= ceiling ? [time] : [];
}

export function filterTimes(times, ceiling) {
  const sorted = times.filter(time => Number.isFinite(time) && time <= ceiling).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return sorted.filter(time => Math.abs(time - median) <= 3 * 86_400_000);
}

export function extractPrompt(blob) {
  const candidates = [...new Set(textFields(bytesOf(blob)))].filter(text =>
    text.length >= 8 && text.length <= 65_536 && /\p{L}/u.test(text) && /\s/u.test(text)
    && !/^https?:\/\//i.test(text) && !MODEL.test(text)
  ).sort((a, b) => b.length - a.length);
  // Nhiều trường văn bản gần bằng nhau là mơ hồ, để trống thay vì đoán.
  if (!candidates.length || candidates[1]?.length > candidates[0].length / 1.5) return '';
  return promptPreview(candidates[0]);
}

export function extractWorkspace(blob) {
  // Chỉ chuỗi là một đường dẫn hoàn chỉnh trong metadata, không tìm đường dẫn bên trong lời nhắc.
  const candidates = new Map();
  textFields(bytesOf(blob)).forEach((text, index) => {
    if (!/^(?:[a-z]:[\\/]|file:\/\/\/)/i.test(text) || /[\r\n\t<>"|?*\uFFFD]/.test(text)) return;
    const value = workspacePath(text);
    if (!/^[a-z]:\//i.test(value) && !(/^file:\/\/\//i.test(text) && value.startsWith('/'))) return;
    const key = value.toLowerCase();
    const previous = candidates.get(key);
    candidates.set(key, { value, index: previous?.index ?? index, count: (previous?.count || 0) + 1 });
  });
  return [...candidates.values()].sort((a, b) => b.count - a.count || a.value.length - b.value.length || a.index - b.index)[0]?.value || '';
}

async function readConversation(file, mtime) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    let model = '', fallbackModel = '', lastStatus = null, prompt = '', tokens = null;
    const times = [], ceiling = mtime + 60_000;
    const meta = db.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1').get();
    // Một số bản DB tổng hợp/cũ không có bảng này; vẫn đọc được các trường cũ.
    const hasWorkspace = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trajectory_metadata_blob'").get();
    const workspace = hasWorkspace ? extractWorkspace(db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get()?.data) : '';
    for (const row of db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC').iterate()) {
      if (!model) model = extractModel(row.data);
      tokens = addAgyUsage(tokens, extractGenerationTokens(row.data));
    }
    const query = `SELECT idx, step_type, status, metadata,
      CASE WHEN step_type = 14 THEN step_payload ELSE NULL END AS payload FROM steps ORDER BY idx`;
    let userStepSeen = false;
    for (const row of db.prepare(query).iterate()) {
      lastStatus = row.status;
      // Khi gen_metadata đã có model hợp lệ, fallback không thể ảnh hưởng kết quả.
      if (!model) fallbackModel = extractModel(row.metadata) || fallbackModel;
      times.push(...extractTimes(row.metadata, ceiling));
      if (row.step_type === 14 && !userStepSeen) {
        userStepSeen = true; prompt = extractPrompt(row.payload);
      }
    }
    model ||= fallbackModel;
    const filtered = filterTimes(times, ceiling);
    if (!modelLane(model) || !filtered.length) return null;
    const start = filtered[0], end = filtered.at(-1);
    return { id: identifier(meta?.trajectory_id || path.basename(file, '.db')), model, start, end, lastStatus, prompt, workspace, tokens };
  } finally { db.close(); }
}

// SQLite đồng bộ nằm trong luồng riêng; chỉ gửi các trường đã rút gọn về luồng phục vụ HTTP.
if (!isMainThread && workerData?.agentBoardAgy) {
  parentPort.on('message', async files => {
    for (const { file, mtime } of files) {
      try { parentPort.postMessage({ file, record: await readConversation(file, mtime), error: false }); }
      catch { parentPort.postMessage({ file, record: null, error: true }); }
      await yieldThread();
    }
    parentPort.postMessage({ done: true });
  });
}

export class AgySource {
  constructor(root) {
    this.root = root;
    this.cache = new Map();
    this.workers = new Set();
    this.statistics = { conversationsRead: 0, merged: 0, errors: 0, skipped: 0, parsedFiles: 0 };
  }
  // Gộp các lần gọi chồng nhau: nếu một lần làm mới đang chạy thì dùng lại chính lần đó.
  refresh() {
    this.running ??= this.refreshOnce().finally(() => { this.running = null; });
    return this.running;
  }
  async refreshOnce() {
    const began = performance.now(), changed = [], present = new Set();
    this.statistics = { conversationsRead: 0, merged: 0, errors: 0, skipped: 0, parsedFiles: 0 };
    if (!this.root) return;
    const inspect = async file => {
      try {
        const [info, wal] = await Promise.all([
          stat(file), stat(file + '-wal').catch(error => { if (error.code !== 'ENOENT') throw error; }),
        ]);
        return { status: 'fulfilled', value: { info, wal } };
      } catch (reason) { return { status: 'rejected', reason }; }
    };
    // Chồng thời gian liệt kê thư mục với stat các tệp đã biết, vẫn lấy danh sách hiện hành làm chuẩn.
    const known = new Map([...this.cache.keys()].map(file => [file, inspect(file)]));
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch { this.cache.clear(); this.statistics.errors = 1; return; }
    entries = entries.filter(entry => entry.isFile() && entry.name.endsWith('.db') && !/obsolete|legacy/i.test(entry.name));
    const infos = await Promise.all(entries.map(entry => {
      const file = path.join(this.root, entry.name);
      return known.get(file) || inspect(file);
    }));
    for (const [index, entry] of entries.entries()) {
      const file = path.join(this.root, entry.name);
      present.add(file);
      try {
        if (infos[index].status === 'rejected') throw infos[index].reason;
        const { info, wal } = infos[index].value;
        const signature = [info.size, info.mtimeMs, wal?.size ?? 0, wal?.mtimeMs ?? 0].join(':');
        const previous = this.cache.get(file);
        if (previous?.signature === signature && !previous.error) continue;
        const item = { signature, mtime: Math.max(info.mtimeMs, wal?.mtimeMs ?? 0), record: null, error: false };
        this.cache.set(file, item); changed.push(file);
      } catch { this.cache.set(file, { record: null, error: true }); }
    }
    for (const file of this.cache.keys()) if (!present.has(file)) this.cache.delete(file);
    if (changed.length) {
      // Hai luồng SQLite cho tập lớn, vẫn chỉ đọc và giữ thứ tự Map nguồn.
      const groups = Array.from({ length: changed.length >= 32 && availableParallelism() >= 4 ? 2 : 1 }, () => []);
      const sizes = new Map(entries.map((entry, i) => [path.join(this.root, entry.name), infos[i].value?.info.size || 0]));
      [...changed].sort((a, b) => sizes.get(b) - sizes.get(a)).forEach((file, i) => groups[i % groups.length].push(file));
      await Promise.all(groups.map(async files => {
        const worker = new Worker(new URL('./agy.mjs', import.meta.url), {
          workerData: { agentBoardAgy: true }, execArgv: ['--disable-warning=ExperimentalWarning'],
        });
        this.workers.add(worker);
        try {
          await new Promise((resolve, reject) => {
            worker.on('error', reject);
            worker.on('exit', code => { if (code !== 0 || this.stopped) reject(new Error('Luồng đọc đã dừng.')); });
            worker.on('message', message => {
              if (message.done) return resolve();
              // Tệp có thể đã biến mất khỏi đệm (agy xóa hoặc đổi tên tệp tạm giữa chừng): bỏ qua, không ném lỗi.
              const item = this.cache.get(message.file);
              if (item) Object.assign(item, { record: message.record, error: message.error });
            });
            worker.postMessage(files.map(file => ({ file, mtime: this.cache.get(file)?.mtime ?? Date.now() })));
          });
        } catch { for (const file of files) { const item = this.cache.get(file); if (item) Object.assign(item, { record: null, error: true }); } }
        finally { await worker.terminate(); this.workers.delete(worker); }
      }));
    }
    const values = [...this.cache.values()];
    Object.assign(this.statistics, {
      totalFiles: present.size, conversationsRead: values.filter(item => item.record).length,
      errors: values.filter(item => item.error).length,
      skipped: values.filter(item => !item.record && !item.error).length,
      parsedFiles: changed.length, durationMs: Math.round(performance.now() - began),
      cacheBytes: Buffer.byteLength(JSON.stringify([...this.cache])),
    });
  }
  runs(now = Date.now()) {
    return [...this.cache.values()].filter(item => item.record).map(({ record, mtime }) => {
      // Chưa đủ chứng cứ để đổi mã bước thành kết quả thành công/lỗi.
      const running = record.lastStatus !== 3 && now - mtime >= 0 && now - mtime < 90_000;
      return {
        ...record, id: `agy:${record.id}`, sourceSession: record.id, lane: modelLane(record.model),
        project: '', kind: 'hội thoại', source: 'agy-db', status: 'unknown', running,
        end: running ? null : record.end, endEstimated: false,
        tokens: record.tokens ? { ...record.tokens } : null,
        tokenSource: record.tokens ? 'agy' : null,
        evidence: 'Hội thoại agy, không rõ nguồn giao. Giờ từ trường đầu metadata, đã lọc trần mtime và ngoại lai 3 ngày; kết quả chưa được xác minh.',
      };
    });
  }
  stop() { this.stopped = true; for (const worker of this.workers) void worker.terminate(); }
}

export function mergeAgy(assignments, conversations, comparison = {}) {
  const result = assignments.map(run => ({ ...run })), used = new Set(), pairs = [];
  const candidates = new Map();
  for (const run of result) {
    if (run.source !== 'claude-tool') continue;
    if (!candidates.has(run.lane)) candidates.set(run.lane, new Map());
    const models = candidates.get(run.lane);
    if (!models.has(run.model)) models.set(run.model, []);
    models.get(run.model).push(run);
  }
  for (const conversation of conversations) {
    for (const assignment of candidates.get(conversation.lane)?.get(conversation.model) || []) {
      const delta = Math.abs(assignment.start - conversation.start);
      if (delta <= 120_000) pairs.push({ assignment, conversation, delta });
    }
  }
  pairs.sort((a, b) => a.delta - b.delta || a.conversation.start - b.conversation.start);
  const usedConversations = new Set();
  for (const { assignment, conversation } of pairs) {
    if (used.has(assignment.id) || usedConversations.has(conversation.id)) continue;
    used.add(assignment.id); usedConversations.add(conversation.id);
    const key = String(conversation.lastStatus);
    comparison[key] ||= { ok: 0, error: 0, quota: 0, unknown: 0, promptsAvailable: 0, promptsEqual: 0 };
    comparison[key][assignment.status]++;
    if (conversation.prompt && assignment.prompt) {
      comparison[key].promptsAvailable++;
      if (conversation.prompt === assignment.prompt) comparison[key].promptsEqual++;
    }
    Object.assign(assignment, {
      ...conversation, id: assignment.id, sourceSession: assignment.sourceSession,
      agySession: conversation.sourceSession, prompt: assignment.prompt, project: assignment.project,
      kind: assignment.kind, endRaw: undefined, merged: true,
      tokens: conversation.tokens ? { ...conversation.tokens } : null,
      tokenSource: conversation.tokens ? conversation.tokenSource || 'agy' : null,
      evidence: 'Đã ghép với hội thoại agy theo model và giờ bắt đầu trong 120 giây. Kết quả chưa được xác minh.',
    });
  }
  return [...result, ...conversations.filter(run => !usedConversations.has(run.id))];
}
