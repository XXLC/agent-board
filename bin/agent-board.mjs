#!/usr/bin/env node
// Lệnh điều khiển Agent Board: agent-board start | stop | restart | status.
// Không phụ thuộc gói ngoài; chỉ chạm tiến trình đã xác minh là server.mjs của chính thư mục này.
import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'server.mjs');
const cache = path.join(root, '.cache');
const pidFile = path.join(cache, 'agent-board.pid');
const logFile = path.join(cache, 'server.log');
const port = Number(process.env.AGENT_BOARD_PORT || 8090);
const url = `http://127.0.0.1:${port}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameFile = (a, b) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

function usage(code = 0) {
  console.log(`Dùng: agent-board <start|stop|restart|status>
  start    chạy Agent Board nền tại ${url}
  stop     dừng Agent Board đang chạy
  restart  dừng rồi chạy lại
  status   cho biết đang chạy hay không`);
  process.exit(code);
}

async function powershell(script) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  return stdout.trim();
}

// Dòng lệnh của một tiến trình; chuỗi rỗng nếu tiến trình không còn.
async function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  return powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`);
}

// Chỉ coi là Agent Board khi đúng là node chạy server.mjs của thư mục này.
async function isBoardProcess(pid) {
  const line = await commandLineOf(pid);
  if (!/node(\.exe)?["']?\s/i.test(line)) return false;
  const match = line.match(/server\.mjs/i);
  if (!match) return false;
  // Chạy bằng đường dẫn tương đối thì không đối chiếu được thư mục; chấp nhận khi tên tệp khớp và có tiến trình nghe cổng.
  const quoted = [...line.matchAll(/"([^"]*server\.mjs)"|(\S*server\.mjs)/gi)].map(m => m[1] || m[2]);
  return quoted.some(file => !path.isAbsolute(file) || sameFile(path.resolve(file), server));
}

// Cổng có đang bị giữ không: thử bind thật, chính xác hơn mọi công cụ liệt kê
// (máy này không in dòng LISTENING cho cổng 8090 và Get-NetTCPConnection cũng thiếu).
function portInUse() {
  return new Promise(resolve => {
    const probeServer = net.createServer();
    probeServer.once('error', error => resolve(error.code === 'EADDRINUSE'));
    probeServer.listen(port, '127.0.0.1', () => probeServer.close(() => resolve(false)));
  });
}

// PID chủ phía máy chủ của các kết nối tới cổng (dòng netstat có địa chỉ cục bộ là cổng này); bổ trợ để chọn đúng ứng viên.
async function portOwners() {
  const { stdout } = await execute('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' });
  const owners = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[4]);
    if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) owners.add(pid);
  }
  return owners;
}

// Mọi tiến trình node có server.mjs trong dòng lệnh và qua được kiểm tra isBoardProcess.
async function boardCandidates() {
  const out = await powershell(`(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\\.mjs' }).ProcessId -join ','`);
  const pids = out.split(',').map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
  const checks = await Promise.all(pids.map(async pid => [pid, await isBoardProcess(pid)]));
  return checks.filter(([, ok]) => ok).map(([pid]) => pid);
}

function readPidFile() {
  try { const data = JSON.parse(readFileSync(pidFile, 'utf8')); return Number.isInteger(data.pid) ? data : null; }
  catch { return null; }
}

async function probe() {
  try {
    const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

// PID đang giữ Agent Board: ưu tiên tệp PID; không có thì tìm tiến trình chạy server.mjs (trường hợp chạy tay).
// Khi có nhiều ứng viên mà không phân biệt được bằng kết nối tới cổng thì trả 0 (không đoán, tránh dừng nhầm).
async function findRunning() {
  const saved = readPidFile();
  if (saved && await isBoardProcess(saved.pid)) return saved.pid;
  if (!await portInUse()) return 0;
  const candidates = await boardCandidates();
  if (candidates.length === 1) return candidates[0];
  await probe(); // tạo một kết nối để netstat thấy chủ phía máy chủ
  const owners = await portOwners();
  const matched = candidates.filter(pid => owners.has(pid));
  if (matched.length === 1) return matched[0];
  // Không đọc được dòng lệnh (ví dụ tiến trình chạy với quyền cao hơn): nhận diện bằng phản hồi API của chính cổng,
  // chỉ khi đúng một tiến trình giữ cổng và API trả đúng dạng của Agent Board.
  const state = await probe();
  if (owners.size === 1 && Array.isArray(state?.lanes) && state?.scan && typeof state.revision === 'number') return [...owners][0];
  return 0;
}

// Tiến trình còn sống không, không cần đọc dòng lệnh.
async function isAlive(pid) {
  return Boolean(await powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`));
}

async function start() {
  const running = await findRunning();
  if (running) { console.log(`Agent Board đã chạy (PID ${running}): ${url}`); return 0; }
  if (await portInUse()) { console.error(`Cổng ${port} đang bị một tiến trình không phải Agent Board giữ (hoặc có nhiều bản Agent Board chạy chồng). Đặt AGENT_BOARD_PORT khác hoặc dừng tiến trình đó.`); return 1; }
  mkdirSync(cache, { recursive: true });
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [server], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env,
  });
  child.unref(); closeSync(log);
  writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port, started: new Date().toISOString() }));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await probe()) { console.log(`Agent Board đã chạy (PID ${child.pid}): ${url}`); return 0; }
    if (!await commandLineOf(child.pid)) break;
  }
  console.error(`Agent Board không khởi động được. Xem nhật ký: ${logFile}`);
  rmSync(pidFile, { force: true });
  return 1;
}

async function stop() {
  const pid = await findRunning();
  if (!pid) {
    if (await portInUse()) {
      console.error(`Cổng ${port} đang bị một tiến trình không phải Agent Board giữ; không dừng gì và giữ nguyên tệp PID.`);
      return 1;
    }
    rmSync(pidFile, { force: true });
    console.log('Agent Board không chạy.');
    return 0;
  }
  try { process.kill(pid); } catch (error) {
    const elevated = error.code === 'EPERM' || error.code === 'EACCES';
    console.error(`Không dừng được PID ${pid}: ${error.message}` + (elevated
      ? `\nTiến trình này chạy với quyền cao hơn shell hiện tại. Mở PowerShell bằng Run as administrator và chạy: Stop-Process -Id ${pid} -Force`
      : ''));
    return 1;
  }
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!await isAlive(pid)) { rmSync(pidFile, { force: true }); console.log(`Đã dừng Agent Board (PID ${pid}).`); return 0; }
  }
  console.error(`PID ${pid} vẫn còn sau 5 giây.`);
  return 1;
}

async function status() {
  const pid = await findRunning();
  if (!pid) { console.log('Agent Board không chạy.'); return 3; }
  const state = await probe();
  const scan = state?.scan;
  console.log(`Agent Board đang chạy (PID ${pid}): ${url}`);
  if (scan) console.log(scan.initial ? `Đang quét lần đầu: ${scan.scannedFiles}/${scan.totalFiles} tệp.` : `Quét gần nhất: ${scan.lastScan}, ${scan.scannedFiles} tệp.`);
  else console.log('Chưa trả lời API (có thể đang khởi động).');
  return 0;
}

const commands = { start, stop, status, restart: async () => { const code = await stop(); return code === 0 ? start() : code; } };
const name = process.argv[2];
if (process.argv.length > 3 || !Object.hasOwn(commands, name)) usage(name ? 2 : 0);
process.exitCode = await commands[name]();
