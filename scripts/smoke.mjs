import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.AGENT_BOARD_PORT || 8090);
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const closed = once(server, 'exit');
let ready = false;
server.stdout.on('data', chunk => { if (chunk.toString().includes('Agent Board đang phục vụ')) ready = true; });
server.stderr.resume();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function curl(route, extra = []) {
  return execute('curl.exe', ['--silent', '--show-error', '--max-time', '15', ...extra, `http://127.0.0.1:${port}${route}`], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
}
try {
  const deadline = Date.now() + 180_000;
  while (!ready && server.exitCode === null && Date.now() < deadline) await pause(100);
  if (!ready) throw new Error('Server không khởi động được.');
  let state;
  do {
    state = JSON.parse((await curl('/api/state', ['--fail'])).stdout);
    if (state.scan.initial) await pause(500);
  } while (state.scan.initial && Date.now() < deadline);
  if (state.scan.initial) throw new Error('Quá thời gian chờ quét đầu tiên.');
  const initialBytes = state.scan.bytesRead, initialScan = state.scan.lastScan;
  await pause(5700);
  const laterState = JSON.parse((await curl('/api/state', ['--fail'])).stdout);
  if (laterState.scan.lastScan === initialScan) throw new Error('Lượt quét tăng dần chưa chạy.');
  const runs = JSON.parse((await curl('/api/runs?from=1970-01-01T00:00:00Z&to=' + encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString()), ['--fail'])).stdout);
  const estimated = runs.filter(run => run.endEstimated);
  if (estimated.some(run => run.end > run.start + 3600_000 || !Number.isFinite(run.endRaw))) {
    throw new Error('Giới hạn giờ kết thúc ước lượng không đạt.');
  }
  if (runs.some(run => Array.from(run.prompt || '').length > 200)) throw new Error('Lời nhắc vượt giới hạn cho phép.');
  if (runs.some(run => run.start > Date.now() || run.end != null && (run.end > Date.now() || run.end < run.start))) {
    throw new Error('API trả mốc giờ tương lai hoặc kết thúc trước bắt đầu.');
  }
  const host = await curl('/api/state', ['-H', 'Host: khong-hop-le.test:8090', '-o', 'NUL', '-w', '%{http_code}']);
  const html = await curl('/', ['--fail']);
  if (!html.stdout.includes('Agent Board') || host.stdout !== '403') throw new Error('Kiểm tra HTTP không đạt.');
  const summary = {
    thờiĐiểm: new Date().toISOString(),
    quét: laterState.scan,
    lỗiAgyLầnQuétĐầu: state.scan.agy?.errors ?? 0,
    tổngThanh: runs.length,
    mốcGiờ: {
      kếtThúcTươngLai: runs.filter(r => r.end > Date.now() + 120_000).length,
      kếtThúcTrướcBắtĐầu: runs.filter(r => r.end != null && r.end < r.start).length,
      dàiHơn24Giờ: runs.filter(r => r.end != null && r.end - r.start > 86_400_000).length,
      bắtĐầuQuá90Ngày: runs.filter(r => r.start < Date.now() - 90 * 86_400_000).length,
    },
    giờKếtThúcƯớcLượng: { sốThanh: estimated.length, giớiHạn60Phút: true },
    theoLàn: Object.fromEntries(['Claude', 'Codex', 'Opus', 'Argon'].map(lane => [lane, { tổng: runs.filter(r => r.lane === lane).length, giaoViệc: runs.filter(r => r.lane === lane && !['hoạt động', 'tương tác'].includes(r.kind)).length, tươngTác: runs.filter(r => r.lane === lane && r.kind === 'tương tác').length, kiểmTra: runs.filter(r => r.lane === lane && r.kind === 'kiểm tra').length, đangChạy: runs.filter(r => r.lane === lane && r.running).length, kếtQuả: Object.fromEntries(['ok', 'error', 'quota', 'unknown'].map(s => [s, runs.filter(r => r.lane === lane && r.status === s).length])) }])),
    hostLạ: Number(host.stdout),
    trangChủ: 'Đã nhận HTML',
    tăngDần: {
      byteĐọcThêm: laterState.scan.bytesRead - initialBytes, thờiGianMs: laterState.scan.durationMs,
      hộiThoạiPhânTíchLại: laterState.scan.agy?.parsedFiles,
      mốcQuétĐãĐổi: laterState.scan.lastScan !== initialScan,
    },
  };
  await mkdir(new URL('../.cache', import.meta.url), { recursive: true });
  await writeFile(new URL('../.cache/verification.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.kill();
  await closed;
  console.log('Đã dừng tiến trình server thử nghiệm.');
}
