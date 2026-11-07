import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Scanner } from './lib/scanner.mjs';
import { validHost } from './lib/parsers.mjs';
import { watchProcesses } from './lib/processes.mjs';

const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/activity.js', ['public/activity.js', 'text/javascript; charset=utf-8']],
  ['/model-labels.js', ['public/model-labels.js', 'text/javascript; charset=utf-8']],
  ['/mindmap.js', ['public/mindmap.js', 'text/javascript; charset=utf-8']],
  ['/mindmap-layout.js', ['public/mindmap-layout.js', 'text/javascript; charset=utf-8']],
  ['/wake-lock.js', ['public/wake-lock.js', 'text/javascript; charset=utf-8']],
  ['/counters.js', ['public/counters.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
]);
export function createBoardServer(scanner, port = 8090) {
  const clients = new Set();
  const sendState = () => {
    if (!clients.size) return;
    const message = `event: state\ndata: ${JSON.stringify(scanner.state())}\n\n`;
    for (const response of clients) {
      if (response.writableLength > 1024 * 1024) { response.destroy(); clients.delete(response); }
      else response.write(message);
    }
  };
  scanner.on('change', sendState);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    const json = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    if (!validHost(request.headers.host, port)) return json(403, { error: 'Host không được phép.' });
    if (request.method !== 'GET') return json(405, { error: 'Chỉ hỗ trợ GET.' });
    let url;
    try { url = new URL(request.url, `http://127.0.0.1:${port}`); } catch { return json(400, { error: 'Đường dẫn không hợp lệ.' }); }
    if (url.pathname === '/api/state') return json(200, scanner.state());
    if (url.pathname === '/api/runs') {
      const from = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from')) : Date.now() - 86_400_000;
      const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')) : Date.now();
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return json(400, { error: 'Khoảng thời gian không hợp lệ.' });
      return json(200, scanner.runs().filter(run => run.start <= to && (run.end ?? Date.now()) >= from));
    }
    if (url.pathname === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write('retry: 3000\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      sendState(); return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) return json(404, { error: 'Không tìm thấy tài nguyên.' });
    try { const data = await readFile(new URL(asset[0], import.meta.url)); response.writeHead(200, { 'Content-Type': asset[1] }); response.end(data); }
    catch { json(500, { error: 'Không đọc được tệp giao diện.' }); }
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': nhịp tim\n\n'); }, 15_000);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); scanner.off('change', sendState); });
  server.stopEvents = () => { for (const client of clients) client.end(); clients.clear(); };
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const port = Number(process.env.AGENT_BOARD_PORT || 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('Cổng không hợp lệ.'); process.exitCode = 1; }
  else {
    // Bảng theo dõi không được chết vì một lỗi ở nguồn dữ liệu: ghi lỗi ra stderr rồi chạy tiếp.
    process.on('uncaughtException', error => console.error('Lỗi chưa bắt:', error?.stack || error));
    process.on('unhandledRejection', error => console.error('Promise bị từ chối:', error?.stack || error));
    const scanner = new Scanner();
    const server = createBoardServer(scanner, port);
    let stopProcesses = () => {};
    const stop = () => { scanner.stop(); stopProcesses(); server.stopEvents(); server.close(); server.closeAllConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    server.on('error', () => { console.error('Không thể khởi động server; kiểm tra cổng đang sử dụng.'); stop(); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Agent Board đang phục vụ tại http://127.0.0.1:${port}`);
      stopProcesses = watchProcesses(scanner);
      void scanner.start();
    });
  }
}
