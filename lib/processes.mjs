import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCommands, promptPreview, stamp } from './parsers.mjs';

const execute = promisify(execFile);
const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
  + "@(Get-CimInstance Win32_Process -Filter \"Name LIKE '%agy%' OR Name LIKE '%codex%' OR Name LIKE '%claude%' OR Name LIKE '%node%'\" "
  + "| Select-Object Name,ProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine) "
  + '| ConvertTo-Json -Compress -Depth 3';

export function summarizeProcesses(processes) {
  const result = [], names = new Map();
  for (const process of processes) {
    if (!/agy|codex|claude|node/i.test(process.Name || '')) continue;
    const command = process.CommandLine || '';
    if (!/agy(?:\.exe)?|codex/i.test(command)) continue;
    for (const parsed of parseCommands(command)) {
      const start = stamp(process.CreationDate) ?? Date.now();
      const prompt = promptPreview(parsed.prompt, 120);
      if (result.some(r => r.lane === 'Codex' && parsed.lane === 'Codex' && names.get(r.pid) !== process.Name && r.prompt === prompt && Math.abs(r.start - start) < 10_000)) continue;
      result.push({ ...parsed, prompt, start, pid: Number(process.ProcessId) }); names.set(Number(process.ProcessId), process.Name);
    }
  }
  return result;
}
export function watchProcesses(scanner) {
  let busy = false, stopped = false;
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
      const data = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : [];
      if (stopped) return;
      scanner.live = summarizeProcesses(Array.isArray(data) ? data : [data]);
      scanner.warnings.delete('process');
      scanner.scan.processScan = new Date().toISOString();
      scanner.publish();
    } catch {
      if (!stopped) {
        scanner.live = [];
        scanner.warn('process', 'Không đọc được tiến trình Windows; trạng thái dựa trên bản ghi.');
        scanner.publish();
      }
    } finally { busy = false; }
  };
  void poll();
  const timer = setInterval(() => void poll(), 3000);
  return () => { stopped = true; clearInterval(timer); };
}
