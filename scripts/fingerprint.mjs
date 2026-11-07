// Công cụ kiểm hồi quy: quét thật một lượt rồi ghi "dấu vân tay" kết quả (không chứa lời nhắc hay nội dung).
// Dùng: node --disable-warning=ExperimentalWarning scripts/fingerprint.mjs <tệp_ra.json> <mốc_cắt_epoch_ms>
// Chỉ tính các lần chạy đã xong và bắt đầu trước mốc cắt, để dữ liệu đang ghi thêm không làm lệch so sánh.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Scanner } from '../lib/scanner.mjs';

const out = process.argv[2];
const cutoff = Number(process.argv[3]);
if (!out || !Number.isFinite(cutoff)) { console.error('Dùng: fingerprint.mjs <tệp_ra.json> <mốc_cắt_epoch_ms>'); process.exit(2); }
const scanner = new Scanner();
const began = performance.now();
await scanner.start();
await new Promise(resolve => {
  const timer = setInterval(() => { if (!scanner.state().scan.initial && !scanner.busy) { clearInterval(timer); resolve(); } }, 300);
});
const ms = Math.round(performance.now() - began);
const runs = scanner.runs().filter(r => !r.running && r.start < cutoff && (r.end ?? 0) < cutoff);
const rows = runs.map(r => [r.id, r.lane, r.source, r.status, r.projectKey, r.promptSource ?? '', r.start, r.end ?? null, r.model ?? '']);
rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const counts = {};
for (const r of runs) { const k = `${r.lane}|${r.source}|${r.status}`; counts[k] = (counts[k] || 0) + 1; }
const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
writeFileSync(out, JSON.stringify({ ms, cutoff, runs: runs.length, hash, counts, projects: [...new Set(runs.map(r => r.projectKey))].sort() }, null, 1));
console.log(`xong sau ${ms} ms | ${runs.length} run | sha256 ${hash.slice(0, 16)}`);
scanner.stop();
setTimeout(() => process.exit(0), 300);
