// Đo trên nguồn thật và dữ liệu nối thêm tổng hợp, chỉ xuất số liệu.
// Dùng: node --disable-warning=ExperimentalWarning scripts/perf.mjs .cache/perf.json
// Đặt AGENT_BOARD_PERF_API=1 để đo thêm HTTP tại cổng 8091; không ghi nội dung phản hồi.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFile, mkdir, mkdtemp, appendFile, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { Scanner } from '../lib/scanner.mjs';
import { createBoardServer } from '../server.mjs';

async function syntheticAppend() {
  const root = path.resolve(fileURLToPath(new URL('../.cache', import.meta.url)));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'đo-nối-thêm-'));
  const claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex');
  const source = new Scanner({ claude, codex });
  const data = (count, offset) => Array.from({ length: count }, (_, i) => JSON.stringify({
    type: 'progress', uuid: `tổng-hợp-${offset + i}`, cwd: 'D:/Dự án tổng hợp',
    timestamp: '2026-01-01T00:00:00Z', message: { content: 'Dữ liệu tổng hợp '.repeat(20) },
  }) + '\n').join('');
  try {
    await mkdir(claude); await mkdir(codex);
    const file = path.join(claude, 'tổng-hợp.jsonl');
    await writeFile(file, data(16_384, 0));
    const baseBytes = (await stat(file)).size;
    await source.refresh(true);
    const start = performance.now(); await source.refresh();
    const stableMs = +(performance.now() - start).toFixed(2), append = [];
    let offset = 16_384;
    for (const count of [2048, 8192]) {
      const text = data(count, offset); offset += count;
      await appendFile(file, text);
      const before = source.scan.bytesRead, began = performance.now();
      await source.refresh();
      append.push({ addedBytes: Buffer.byteLength(text), readBytes: source.scan.bytesRead - before,
        ms: +(performance.now() - began).toFixed(2) });
    }
    return { baseBytes, stableMs, append };
  } finally {
    source.stop();
    if (!dir.startsWith(root + path.sep)) throw new Error('Thư mục đo nằm ngoài vùng cho phép.');
    await rm(dir, { recursive: true });
  }
}

const scanner = new Scanner();
let server, poll;
const requests = [], latencies = [];
if (process.env.AGENT_BOARD_PERF_API) {
  server = createBoardServer(scanner, 8091);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8091, '127.0.0.1', resolve); });
  poll = setInterval(() => {
    if (!scanner.busy) return;
    requests.push(new Promise((resolve, reject) => {
      const began = performance.now();
      http.get('http://127.0.0.1:8091/api/state', response => {
        response.resume();
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('API trả mã trạng thái không hợp lệ.'));
          latencies.push(performance.now() - began); resolve();
        });
        response.on('error', reject);
      }).on('error', reject);
    }));
    requests.at(-1).catch(() => {});
  }, 400);
}
const timings = {};
if (process.env.AGENT_BOARD_PERF_DETAIL) {
  for (const method of ['rebuild', 'loadPromptFiles', 'discover']) {
    const original = scanner[method].bind(scanner);
    scanner[method] = (...args) => {
      const start = performance.now();
      const finish = () => { timings[method] = (timings[method] || 0) + performance.now() - start; };
      const result = original(...args);
      if (result?.then) return result.finally(finish);
      finish(); return result;
    };
  }
}
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
await new Promise(resolve => setTimeout(resolve, 20));
const began = performance.now();
try {
  await scanner.refresh(true);
  const initialMs = performance.now() - began;
  const agyMs = scanner.scan.agy?.durationMs;
  clearInterval(poll);
  await Promise.all(requests);
  await new Promise(resolve => setTimeout(resolve, 20));
  delay.disable();
  const incremental = [];
  for (let i = 0; i < 10 && incremental.filter(item => item.stable).length < 2; i++) {
    const prior = { ...timings };
    const bytes = scanner.scan.bytesRead, start = performance.now();
    await scanner.refresh();
    incremental.push({ ms: +(performance.now() - start).toFixed(2), bytesRead: scanner.scan.bytesRead - bytes,
      agyMs: scanner.scan.agy?.durationMs, agyParsedFiles: scanner.scan.agy?.parsedFiles,
      stable: scanner.scan.bytesRead === bytes && !scanner.scan.agy?.parsedFiles,
      ...(process.env.AGENT_BOARD_PERF_DETAIL ? { timings: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, +(value - (prior[key] || 0)).toFixed(2)])) } : {}),
    });
  }
  const result = {
    initialMs: +initialMs.toFixed(2), initialDurationMs: scanner.scan.initialDurationMs,
    agyMs,
    p99Ms: +(delay.percentile(99) / 1e6).toFixed(2), maxMs: +(delay.max / 1e6).toFixed(2),
    incremental, rssMiB: +(process.memoryUsage().rss / 1024 ** 2).toFixed(2),
    ...(process.env.AGENT_BOARD_PERF_DETAIL ? { timings } : {}),
    bytesRead: scanner.scan.bytesRead, files: scanner.scan.scannedFiles,
    agyFiles: scanner.scan.agy?.conversationsRead,
  };
  if (server) {
    latencies.sort((a, b) => a - b);
    result.api = { requests: latencies.length, p99Ms: +latencies[Math.ceil(latencies.length * .99) - 1]?.toFixed(2),
      maxMs: +latencies.at(-1)?.toFixed(2) };
  }
  result.synthetic = await syntheticAppend();
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  scanner.stop(); clearInterval(poll);
  if (server) { server.stopEvents(); await new Promise(resolve => server.close(resolve)); }
}
