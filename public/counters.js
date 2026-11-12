// Các phép tính dùng chung cho thẻ, dòng thời gian và sơ đồ; không phụ thuộc DOM.
const integer = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const compact = digits => new Intl.NumberFormat('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const million = compact(1), billion = compact(2);
const amount = n => Number.isFinite(n) ? Math.max(0, n) : 0;
const fields = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total'];

export function formatDuration(ms) {
  const seconds = Math.floor(amount(ms) / 1000);
  if (seconds < 60) return `${seconds} giây`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`;
  return `${Math.floor(seconds / 3600)} giờ ${Math.floor(seconds % 3600 / 60)} phút`;
}

export function formatTokens(n) {
  n = amount(n);
  if (n >= 999_950_000) return `${billion.format(n / 1e9)} tỷ`;
  if (n >= 999_950) return `${million.format(n / 1e6)} triệu`;
  return integer.format(n);
}

export function tokenBreakdown(tokens) {
  if (!tokens) return 'Chưa đọc được token';
  if (tokens.totalOnly) return `Tổng: ${integer.format(amount(tokens.total))} token (số liệu gộp của phiên, chưa tách vào/ra)`;
  const labels = ['Vào', 'Cache đọc', 'Cache ghi', 'Ra', 'Suy luận (nằm trong ra)', 'Tổng'];
  return fields.map((key, i) => `${labels[i]}: ${integer.format(amount(tokens[key]))} token`).join(' · ');
}

export function coverageText(value, total) {
  const known = typeof value === 'object' ? value?.runsWithTokens : value;
  const all = typeof value === 'object' ? value?.runsTotal : total;
  return `${amount(known)}/${amount(all)} lần có số liệu`;
}

export function unreadTokenReason(lane) {
  if (['Opus', 'Argon'].includes(lane)) return 'chưa có lần gọi model nào hoàn tất để tính token';
  if (lane === 'DeepSeek') return 'chưa có tệp phiên Codewhale nào để lấy token (lần chạy exec không có --auto không được lưu phiên)';
  return 'Nguồn chưa cung cấp số liệu token';
}

export function laneCounters(lane, now, receivedAt = now) {
  const coverage = lane.tokens24h || { runsWithTokens: 0, runsTotal: 0 };
  const tokens = coverage.runsWithTokens > 0 ? coverage : null;
  return {
    tokens, tokenText: tokens ? `${formatTokens(tokens.total)} token` : 'chưa đọc được token',
    busyMs: amount(lane.busyMs24h) + (lane.running ? amount(now - receivedAt) : 0),
    runningTokens: lane.running && tokens ? amount(lane.tokensRunning) : null,
    coverage: coverageText(coverage), reason: tokens ? '' : unreadTokenReason(lane.lane),
  };
}

// Token thuộc toàn bộ lần chạy đang hiển thị; chỉ thời gian được cắt tại biên khung nhìn.
export function rangeCounters(runs, now = Date.now(), { from = -Infinity, to = Infinity } = {}) {
  const tokens = Object.fromEntries(fields.map(key => [key, 0]));
  const intervals = [];
  let runsWithTokens = 0;
  for (const run of runs) {
    if (run.tokens) {
      runsWithTokens++;
      for (const key of fields) tokens[key] += amount(run.tokens[key]);
    }
    const start = Math.max(from, run.start), end = Math.min(to, run.running ? now : run.end ?? now);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let busyMs = 0, right = -Infinity;
  for (const [start, end] of intervals) {
    busyMs += Math.max(0, end - Math.max(start, right));
    right = Math.max(right, end);
  }
  return { tokens: runsWithTokens ? tokens : null, busyMs, runsWithTokens, runsTotal: runs.length };
}

// Cùng cách tính và định dạng cho bóng gốc, làn và dự án trong khoảng đang chọn.
export function nodeCounters(runs, lane, now, range) {
  const counters = rangeCounters(runs, now, range);
  const { busyMs, tokens, runsWithTokens, runsTotal } = counters;
  const brief = busyMs >= 3600_000 ? `${Math.floor(busyMs / 3600_000)} giờ`
    : busyMs >= 60_000 ? `${Math.floor(busyMs / 60_000)} phút` : formatDuration(busyMs);
  const tokenText = tokens ? `${formatTokens(tokens.total)} token` : 'chưa đọc được token';
  return {
    ...counters,
    counterText: brief + (tokens ? ` · ${tokenText}` : ''),
    counterDescription: `thời gian chạy ${formatDuration(busyMs)}, ${tokens ? `token ${formatTokens(tokens.total)}` : tokenText}`
      + ` (${runsWithTokens}/${runsTotal} lần giao có số liệu)` + (tokens ? '' : `, ${unreadTokenReason(lane)}`),
  };
}
