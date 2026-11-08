// Chỉ giữ bộ đếm số; không giữ nội dung thông điệp hoặc blob nguồn.
const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total'];
const CLAUDE_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
const CODEX_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const valid = value => Number.isSafeInteger(value) && value >= 0;
const count = value => valid(value) ? value : 0;
const hasUsage = (usage, fields) => usage && fields.some(field => valid(usage[field]));
const empty = () => Object.fromEntries(FIELDS.map(field => [field, 0]));

function addClaudeValues(segment, key, values) {
  segment.tokenMessages ??= new Map();
  segment.tokenTotals ??= empty();
  const prior = segment.tokenMessages.get(key);
  for (let i = 0; i < 4; i++) {
    const delta = Math.max(0, values[i] - (prior?.[i] || 0));
    segment.tokenTotals[FIELDS[i]] += delta;
    segment.tokenTotals.total += delta;
    if (prior) prior[i] += delta;
  }
  if (!prior) segment.tokenMessages.set(key, values);
}

export function addClaudeUsage(segment, message, uuid) {
  if (!hasUsage(message?.usage, CLAUDE_FIELDS)) return;
  // Hai không gian mã riêng để uuid không đụng message.id.
  const key = message.id ? `m:${message.id}` : uuid ? `u:${uuid}` : segment.tokenMessages?.size || 0;
  addClaudeValues(segment, key, CLAUDE_FIELDS.map(field => count(message.usage[field])));
}

export function mergeActivityUsage(target, source) {
  if (!source.tokenMessages) return;
  for (const [key, values] of source.tokenMessages) addClaudeValues(target, key, [...values]);
}

export function addAgyUsage(totals, usage) {
  if (!usage) return totals;
  const target = totals || empty();
  const input = count(usage.input), cacheRead = count(usage.cacheRead), output = count(usage.output);
  target.input += input;
  target.cacheRead += cacheRead;
  target.output += output;
  target.total += input + cacheRead + output;
  return target;
}

export function codexTokens(record) {
  const payload = record.payload || {};
  const usage = record.type === 'event_msg' && payload.type === 'token_count' ? payload.info?.total_token_usage
    : record.type === 'token_usage_record' ? payload.thread_token_usage : null;
  if (!hasUsage(usage, CODEX_FIELDS)) return null;
  const cached = count(usage.cached_input_tokens), output = count(usage.output_tokens);
  const input = Math.max(0, count(usage.input_tokens) - cached);
  return { input, cacheRead: cached, cacheWrite: 0, output, reasoning: count(usage.reasoning_output_tokens), total: input + cached + output };
}

export function laneTokenMetrics(runs, now) {
  const from = now - 86_400_000;
  const tokens24h = { ...empty(), runsWithTokens: 0, runsTotal: 0 };
  const intervals = [];
  let tokensRunning = 0;
  for (const run of runs) {
    if (run.start >= from && run.start <= now) {
      tokens24h.runsTotal++;
      if (run.tokens !== null) {
        tokens24h.runsWithTokens++;
        for (const field of FIELDS) tokens24h[field] += run.tokens[field];
      }
    }
    if (run.running) tokensRunning += run.tokens?.total || 0;
    const start = Math.max(from, run.start), end = Math.min(now, run.running ? now : run.end ?? run.start);
    if (end > start) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let busyMs24h = 0, coveredUntil = from;
  for (const [start, end] of intervals) {
    busyMs24h += Math.max(0, end - Math.max(start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, end);
  }
  return { tokens24h, busyMs24h, tokensRunning };
}
