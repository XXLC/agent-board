import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { parseCommands, safe } from '../lib/parsers.mjs';
import { ROOTS } from '../lib/scanner.mjs';

async function files(root, recursive = true) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (/obsolete|legacy|subagents/i.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && recursive) out.push(...await files(file));
    else if (entry.isFile() && file.endsWith('.jsonl')) out.push(file);
  }
  return out;
}
const claude = await files(ROOTS.claude);
const codex = await files(ROOTS.codex);
const counts = {};
const add = key => counts[key] = (counts[key] || 0) + 1;
const shapes = new Set();
const unique = new Set();
let bytes = 0;
for (const file of claude) {
  bytes += (await stat(file)).size;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!/"(tool_use|tool_result|task-notification|task_notification)"|agy\.exe|codex exec/.test(line)) continue;
    let record;
    try { record = JSON.parse(line); } catch { add('dòng lỗi'); continue; }
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (record.type === 'assistant' && item.type === 'tool_use' && /TaskOutput/i.test(item.name)) { add('công cụ đọc kết quả nền'); shapes.add('đầu vào đọc nền: ' + Object.keys(item.input || {}).sort().join(',')); }
      if (record.type === 'user' && record.toolUseResult && (record.toolUseResult.task || record.toolUseResult.retrieval_status)) {
        shapes.add('kết quả đọc nền: ' + Object.keys(record.toolUseResult).sort().join(',') + '; tác vụ: ' + Object.keys(record.toolUseResult.task || {}).sort().join(','));
      }
      if (item.type === 'tool_use' && /bash|powershell/i.test(item.name)) {
        const command = item.input?.command || '';
        if (/agy\.exe/i.test(command)) {
          add('lệnh agy thô');
          add('vai ' + record.type);
          if (item.input.run_in_background) add('agy chạy nền');
          if (/--model(?:\s|=)/i.test(command)) add('agy có model');
          if (/claude-opus|claude-sonnet/i.test(command)) add('agy nhắc Opus hoặc Sonnet');
          if (/gemini-[\w.-]*(?:argon|flash)/i.test(command)) add('agy nhắc Argon hoặc Flash');
          if (record.type === 'assistant') {
            const key = record.sessionId + ':' + item.id;
            if (!unique.has(key)) {
              unique.add(key); add('lệnh agy duy nhất');
              const parsed = parseCommands(command);
              if (parsed.some(c => c.lane === 'Opus' || c.lane === 'Argon')) add('agy phân tích được');
              else add('agy chưa phân tích được hoặc chỉ là tham chiếu');
            }
            const models = [...command.matchAll(/--model(?:\s+|=)["']?([a-z][\w.-]*)/gi)].map(m => m[1]);
            for (const model of new Set(models)) add('model ' + safe(model, 100));
          }
        }
        if (/codex(?:\.cmd)?["']?\s+exec/i.test(command)) add('lệnh codex thô');
      }
      if (item.type === 'tool_result') {
        if (/running in background/i.test(JSON.stringify(item.content))) {
          add('kết quả nền');
          shapes.add('kết quả nền phụ: ' + Object.keys(record.toolUseResult || {}).sort().join(','));
        }
      }
      if (item.type === 'text' && /<task-notification>/.test(item.text || '')) {
        add('thông báo tác vụ');
        const tags = [...item.text.matchAll(/<([a-z-]+)>/g)].map(match => match[1]);
        shapes.add('thẻ thông báo: ' + [...new Set(tags)].sort().join(','));
      }
    }
  }
}
const codexShapes = new Set();
for (const file of codex.slice(-10)) {
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (['session_meta', 'turn_context', 'event_msg'].includes(record.type)) {
      codexShapes.add(record.type + ': ' + Object.keys(record.payload || {}).sort().join(','));
      if (record.type === 'session_meta') add('nguồn Codex ' + (/^codex[_\w-]*$/.test(record.payload?.originator || '') ? record.payload.originator : 'khác'));
      if (record.type === 'event_msg' && /task|turn/.test(record.payload?.type)) codexShapes.add('sự kiện: ' + record.payload.type);
    }
    if (++n >= 120) break;
  }
}
console.log(JSON.stringify({ tepClaude: claude.length, tepCodex: codex.length, byteClaude: bytes, counts, shapes: [...shapes], codexShapes: [...codexShapes] }, null, 2));
