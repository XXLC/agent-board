import path from 'node:path';
import os from 'node:os';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promptPreview } from './parsers.mjs';

// Đường dẫn từ bản ghi không đáng tin: chỉ đọc trong hai gốc cho phép, không đi qua liên kết.
export async function readPromptFile(file, options = {}) {
  const roots = [path.join(options.tempRoot || os.tmpdir(), 'claude'), options.claudeRoot || path.join(os.homedir(), '.claude', 'projects')];
  if (!file || !path.isAbsolute(file)) return '';
  const target = path.resolve(file);
  const root = roots.find(value => {
    const relative = path.relative(path.resolve(value), target);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
  if (!root) return '';
  let handle;
  try {
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return '';
    }
    const before = await lstat(target);
    if (!before.isFile() || before.size > 1024 * 1024) return '';
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || before.ino !== info.ino || before.dev !== info.dev) return '';
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return promptPreview(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return ''; }
  finally { await handle?.close(); }
}
