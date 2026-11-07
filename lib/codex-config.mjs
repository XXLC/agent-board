import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Chỉ giữ hai khóa ở mức gốc; không phân tích hay đưa phần cấu hình khác ra ngoài.
export async function readCodexDefault(file) {
  if (!file) return undefined;
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const result = {};
  try {
    for await (const line of lines) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')\s*(?:#.*)?$/);
      if (match) result[match[1] === 'model' ? 'model' : 'effort'] = match[2] ?? match[3];
    }
    return result.model && result.effort ? result : undefined;
  } catch { return undefined; }
  finally { lines.close(); input.destroy(); }
}
