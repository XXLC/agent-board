import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { AgySource, extractGenerationTokens } from '../lib/agy.mjs';
import { Scanner } from '../lib/scanner.mjs';

const BASE = 1_793_577_600_000;

function varintBytes(value) {
  const out = [];
  let n = BigInt(value);
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n > 0n) byte |= 128;
    out.push(byte);
  } while (n > 0n);
  return Buffer.from(out);
}

const tagByte = (fieldNumber, wireType) => varintBytes((BigInt(fieldNumber) << 3n) | BigInt(wireType));
const varintField = (fieldNumber, value) => Buffer.concat([tagByte(fieldNumber, 0), varintBytes(value)]);
const lengthField = (fieldNumber, payload) => {
  const bytes = Buffer.from(payload);
  return Buffer.concat([tagByte(fieldNumber, 2), varintBytes(bytes.length), bytes]);
};
const fixed32Field = (fieldNumber, value = 0) => {
  const b = Buffer.alloc(4); b.writeUInt32LE(value);
  return Buffer.concat([tagByte(fieldNumber, 5), b]);
};
const fixed64Field = (fieldNumber, value = 0n) => {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([tagByte(fieldNumber, 1), b]);
};
const timestampMeta = time => lengthField(1, varintField(1, Math.floor(time / 1000)));

function usageMessage({ model = 1402, input = 1200, output = 350, cacheWrite, cacheRead, extra = [] } = {}) {
  const parts = [];
  if (model !== null) parts.push(varintField(1, model));
  if (input !== null) parts.push(varintField(2, input));
  if (output !== null) parts.push(varintField(3, output));
  if (cacheWrite !== undefined) parts.push(varintField(4, cacheWrite));
  if (cacheRead !== undefined) parts.push(varintField(5, cacheRead));
  parts.push(...extra);
  return Buffer.concat(parts);
}

function standardGenBlob(usageOpts, modelName = 'gemini-4-argon-high') {
  const usage = usageMessage(usageOpts);
  const chatModel = Buffer.concat([
    lengthField(1, 'Dữ liệu đầu vào tổng hợp'),
    varintField(3, 1),
    lengthField(4, usage),
    lengthField(9, modelName),
  ]);
  return Buffer.concat([
    lengthField(2, 'Siêu dữ liệu tổng hợp'),
    fixed32Field(6, 42),
    fixed64Field(7, 99n),
    lengthField(1, chatModel),
  ]);
}

async function temporary(t) {
  const root = path.resolve('.cache');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'agy-token-tổng-hợp-'));
  t.after(async () => { assert.ok(dir.startsWith(root + path.sep)); await rm(dir, { recursive: true }); });
  return dir;
}

function createAgyDb(file, { id, model = 'gemini-4-argon-high', generations = [], status = 3, start = BASE, end = BASE + 10_000 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT);
    CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);`);
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(id || path.basename(file, '.db'));
  const insertGen = db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)');
  generations.forEach((blob, i) => insertGen.run(i, blob, blob.length));
  const insertStep = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
  insertStep.run(0, 14, 3, Buffer.concat([timestampMeta(start), lengthField(2, model)]), lengthField(1, 'Kiểm tra đếm token tổng hợp'));
  insertStep.run(1, 15, status, Buffer.concat([timestampMeta(end), lengthField(2, model)]), Buffer.alloc(0));
  db.close();
}

test('Đường chuẩn trường 1 -> trường 4 giải mã đủ trường, bỏ qua cache_write và nhận thiếu cache_read', () => {
  const full = standardGenBlob({ model: 1402, input: 1500, output: 420, cacheWrite: 777, cacheRead: 8300, extra: [
    varintField(6, 12), fixed32Field(7, 1), fixed64Field(8, 2n), lengthField(11, 'phụ'),
  ] });
  assert.deepEqual(extractGenerationTokens(full), { input: 1500, cacheRead: 8300, output: 420 });

  const noCacheRead = standardGenBlob({ model: 1000, input: 300, output: 80, cacheWrite: 500 });
  assert.deepEqual(extractGenerationTokens(noCacheRead), { input: 300, cacheRead: 0, output: 80 });

  const zeroValues = standardGenBlob({ model: 4999, input: 0, output: 0 });
  assert.deepEqual(extractGenerationTokens(zeroValues), { input: 0, cacheRead: 0, output: 0 });
});

test('Kiểm hợp lý loại model ngoài khoảng [1000, 5000), thiếu trường bắt buộc hoặc sai kiểu wire', () => {
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 999, input: 100, output: 50 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 5000, input: 100, output: 50 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 0, input: 100, output: 50 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: null, input: 100, output: 50 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: null, output: 50 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: 100, output: null, cacheRead: 500 })), null);

  // Trường 1..5 trong usage không phải varint (wire = 2) phải bị loại.
  for (const badField of [1, 2, 3, 4, 5]) {
    const raw = Buffer.concat([
      badField === 1 ? lengthField(1, 'sai') : varintField(1, 1402),
      badField === 2 ? lengthField(2, 'sai') : varintField(2, 100),
      badField === 3 ? lengthField(3, 'sai') : varintField(3, 50),
      ...(badField === 4 ? [lengthField(4, 'sai')] : []),
      ...(badField === 5 ? [lengthField(5, 'sai')] : []),
    ]);
    assert.equal(extractGenerationTokens(lengthField(1, lengthField(4, raw))), null);
  }
});

test('Kiểm hợp lý loại giá trị vượt 2.000.000, tổng input + output vượt 2.000.000 và khối giả nano giây', () => {
  assert.deepEqual(
    extractGenerationTokens(standardGenBlob({ model: 1402, input: 1_200_000, output: 800_000, cacheRead: 2_000_000 })),
    { input: 1_200_000, cacheRead: 2_000_000, output: 800_000 },
  );
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: 2_000_001, output: 0 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: 0, output: 2_000_001 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: 1_200_000, output: 800_001 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: 100, output: 50, cacheRead: 2_000_001 })), null);
  assert.equal(extractGenerationTokens(standardGenBlob({ model: 1402, input: 100, output: 50, cacheWrite: 2_000_001 })), null);

  // Khối giả kiểu mốc thời gian / nano giây (field 1 trong [1000, 5000), field 2 = 850.000.000 ns, field 3 = 1).
  const bogusNanos = usageMessage({ model: 1800, input: 850_000_000, output: 1 });
  assert.equal(extractGenerationTokens(lengthField(1, lengthField(4, bogusNanos))), null);

  // Nếu khối giả đứng trước một khối hợp lệ trong nhánh dự phòng, bỏ qua khối giả và lấy khối hợp lệ.
  const combined = Buffer.concat([
    lengthField(3, bogusNanos),
    lengthField(5, usageMessage({ model: 1405, input: 900, output: 110, cacheRead: 400 })),
  ]);
  assert.deepEqual(extractGenerationTokens(combined), { input: 900, cacheRead: 400, output: 110 });
});

test('Bản ghi cũ dùng duyệt đệ quy dự phòng và tôn trọng giới hạn độ sâu <= 6 cùng số trường <= 4000', () => {
  const valid = usageMessage({ model: 1417, input: 640, output: 190, cacheRead: 2100 });
  // Đặt ở độ sâu 6 (6 lớp thông điệp lồng: trường 2 -> 3 -> 4 -> 5 -> 6 -> 7).
  let nested6 = lengthField(7, valid);
  for (const f of [6, 5, 4, 3, 2]) nested6 = lengthField(f, nested6);
  assert.deepEqual(extractGenerationTokens(nested6), { input: 640, cacheRead: 2100, output: 190 });

  // Độ sâu 7 vượt giới hạn 6 phải trả null.
  const nested7 = lengthField(8, nested6);
  assert.equal(extractGenerationTokens(nested7), null);

  // Vượt 4000 trường trước khi tới khối usage phải dừng và trả null.
  const manyFields = Buffer.concat([
    ...Array.from({ length: 4000 }, (_, i) => varintField((i % 20) + 2, i)),
    lengthField(9, valid),
  ]);
  assert.equal(extractGenerationTokens(manyFields), null);

  // Khối usage nằm ở đầu vẫn đọc được dù thông điệp có nhiều trường phía sau.
  const earlyField = Buffer.concat([
    lengthField(9, valid),
    ...Array.from({ length: 100 }, (_, i) => varintField(2, i)),
  ]);
  assert.deepEqual(extractGenerationTokens(earlyField), { input: 640, cacheRead: 2100, output: 190 });
});

test('Blob hỏng, cắt cụt, độ dài khai khống hoặc lát Uint8Array không ném lỗi', () => {
  for (const invalid of [
    null, undefined, '', 123, {}, Buffer.alloc(0),
    Buffer.from([0, 1, 2]),
    Buffer.from([8, 255, 255, 255]),
    Buffer.from([8, 128, 128, 128, 128, 128, 128, 128, 128, 128, 2]),
    Buffer.from([10, 50, 8, 1]),
    Buffer.from([10, 255, 255, 255, 255, 7, 8, 1]),
    Buffer.from([11, 8, 1]),
    Buffer.from([14, 8, 1]),
  ]) {
    assert.equal(extractGenerationTokens(invalid), null);
  }

  const blob = standardGenBlob({ model: 1402, input: 450, output: 120, cacheRead: 900 });
  for (let cut = 1; cut < blob.length - 5; cut++) {
    assert.doesNotThrow(() => extractGenerationTokens(blob.subarray(0, cut)));
  }

  const padded = Buffer.concat([Buffer.from('đệm-đầu'), blob, Buffer.from('đệm-cuối')]);
  const copy = Buffer.from(padded);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + Buffer.byteLength('đệm-đầu'), blob.length);
  assert.deepEqual(extractGenerationTokens(view), { input: 450, cacheRead: 900, output: 120 });
  assert.deepEqual(padded, copy);
});

test('Cộng dồn nhiều lần sinh trong hội thoại, bỏ lần sinh lỗi và trả null khi không có khối hợp lệ', async t => {
  const dir = await temporary(t);
  const withTokens = path.join(dir, 'có-token.db');
  createAgyDb(withTokens, {
    id: 'phiên-1',
    model: 'claude-opus-5-5-high',
    generations: [
      standardGenBlob({ model: 1417, input: 1000, output: 250, cacheWrite: 500 }, 'claude-opus-5-5-high'),
      standardGenBlob({ model: 1417, input: 600, output: 350, cacheRead: 1400 }, 'claude-opus-5-5-high'),
      // Hàng bị hủy giữa chừng chỉ có model, không có input/output.
      lengthField(1, Buffer.concat([lengthField(4, varintField(1, 1417)), lengthField(9, 'claude-opus-5-5-high')])),
      // Hàng theo nhánh dự phòng.
      lengthField(3, usageMessage({ model: 1417, input: 400, output: 100, cacheRead: 2000 })),
    ],
  });
  const withoutTokens = path.join(dir, 'không-token.db');
  createAgyDb(withoutTokens, {
    id: 'phiên-2',
    model: 'gemini-4-argon-high',
    generations: [lengthField(1, lengthField(9, 'gemini-4-argon-high'))],
  });

  const source = new AgySource(dir);
  t.after(() => source.stop());
  await source.refresh();
  const runs = source.runs(BASE + 60_000);
  const run1 = runs.find(r => r.sourceSession === 'phiên-1');
  const run2 = runs.find(r => r.sourceSession === 'phiên-2');

  assert.deepEqual(run1.tokens, {
    input: 2000,
    cacheRead: 3400,
    cacheWrite: 0,
    output: 700,
    reasoning: 0,
    total: 6100,
  });
  assert.equal(run1.tokenSource, 'agy');
  assert.equal(run2.tokens, null);
  assert.equal(run2.tokenSource, null);

  // Bộ nhớ đệm chỉ giữ các trường rút gọn và số token, không giữ blob.
  for (const { record } of source.cache.values()) {
    assert.ok(!('data' in record) && !('blob' in record));
  }
});

test('Ghép lệnh Claude lấy token từ DB agy, tổng hợp tokens24h, tokensRunning và độ phủ hai làn agy', async t => {
  const dir = await temporary(t);
  const agy = path.join(dir, 'agy'), conversations = path.join(agy, 'conversations');
  const claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex');
  await mkdir(conversations, { recursive: true }); await mkdir(claude); await mkdir(codex);

  // Hội thoại Opus ghép với lệnh Claude (đã xong).
  createAgyDb(path.join(conversations, 'opus-ghép.db'), {
    id: 'opus-1',
    model: 'claude-opus-5-5-high',
    status: 3,
    generations: [
      standardGenBlob({ model: 1417, input: 1200, output: 300, cacheRead: 2500 }, 'claude-opus-5-5-high'),
    ],
  });

  // Hội thoại Argon độc lập đang chạy (status != 3, mtime mới).
  const argonRunning = path.join(conversations, 'argon-chạy.db');
  createAgyDb(argonRunning, {
    id: 'argon-1',
    model: 'gemini-4-argon-high',
    status: 2,
    generations: [
      standardGenBlob({ model: 1402, input: 800, output: 200, cacheRead: 1000 }, 'gemini-4-argon-high'),
    ],
  });
  await utimes(argonRunning, new Date(BASE + 15_000), new Date(BASE + 15_000));

  // Hội thoại Argon độc lập không có token (để kiểm độ phủ runsWithTokens < runsTotal).
  createAgyDb(path.join(conversations, 'argon-rỗng.db'), {
    id: 'argon-2',
    model: 'gemini-4-argon-high',
    status: 3,
    start: BASE + 5000,
    end: BASE + 12_000,
    generations: [lengthField(1, lengthField(9, 'gemini-4-argon-high'))],
  });

  const claudeRecord = {
    type: 'assistant',
    timestamp: new Date(BASE).toISOString(),
    sessionId: 'phiên-claude',
    cwd: 'D:/Dự án tổng hợp',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Bash',
        id: 'công-cụ-opus',
        input: { command: 'agy.exe --model claude-opus-5-5-high -p "Kiểm tra ghép token"' },
      }],
    },
  };
  await writeFile(path.join(claude, 'phiên.jsonl'), JSON.stringify(claudeRecord) + '\n');

  const scanner = new Scanner({ claude, codex, agy });
  t.after(() => scanner.stop());
  await scanner.refresh(true);

  const now = BASE + 20_000;
  const runs = scanner.runs(now);
  const opusRun = runs.find(r => r.lane === 'Opus');
  assert.equal(opusRun.merged, true);
  assert.match(opusRun.id, /^claude:/);
  assert.equal(opusRun.agySession, 'opus-1');
  assert.equal(opusRun.tokenSource, 'agy');
  assert.deepEqual(opusRun.tokens, {
    input: 1200, cacheRead: 2500, cacheWrite: 0, output: 300, reasoning: 0, total: 4000,
  });

  const state = scanner.state(now);
  const opusLane = state.lanes.find(l => l.lane === 'Opus');
  assert.deepEqual(opusLane.tokens24h, {
    input: 1200, cacheRead: 2500, cacheWrite: 0, output: 300, reasoning: 0, total: 4000,
    runsWithTokens: 1, runsTotal: 1,
  });
  assert.equal(opusLane.tokensRunning, 0);

  const argonLane = state.lanes.find(l => l.lane === 'Argon');
  assert.deepEqual(argonLane.tokens24h, {
    input: 800, cacheRead: 1000, cacheWrite: 0, output: 200, reasoning: 0, total: 2000,
    runsWithTokens: 1, runsTotal: 2,
  });
  assert.equal(argonLane.tokensRunning, 2000);
});

test('Hội thoại đang chạy ghi thêm hàng gen_metadata thì token tăng ở lượt quét kế tiếp', async t => {
  const dir = await temporary(t), file = path.join(dir, 'đang-chạy.db');
  createAgyDb(file, {
    id: 'phiên-tăng',
    model: 'gemini-4-argon-high',
    status: 2,
    generations: [
      standardGenBlob({ model: 1402, input: 500, output: 100, cacheRead: 400 }, 'gemini-4-argon-high'),
    ],
  });

  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA journal_mode = WAL');
  const source = new AgySource(dir);
  t.after(() => source.stop());
  try {
    await source.refresh();
    assert.equal(source.runs(Date.now())[0].tokens.total, 1000);

    const nextBlob = standardGenBlob({ model: 1402, input: 300, output: 200, cacheRead: 900 }, 'gemini-4-argon-high');
    writer.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(1, nextBlob, nextBlob.length);
    const walInfo = path.join(dir, 'đang-chạy.db-wal');
    await utimes(walInfo, new Date(), new Date(Date.now() + 2000));

    await source.refresh();
    const [updated] = source.runs(Date.now());
    assert.deepEqual(updated.tokens, {
      input: 800, cacheRead: 1300, cacheWrite: 0, output: 300, reasoning: 0, total: 2400,
    });
    assert.equal(updated.tokenSource, 'agy');
  } finally {
    writer.close();
  }
});
