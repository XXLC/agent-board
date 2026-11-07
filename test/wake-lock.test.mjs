import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from '../public/wake-lock.js';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(request) {
  const listeners = {}, changes = [], locks = [];
  let calls = 0;
  const document = { hidden: false, addEventListener(name, fn) { listeners[name] = fn; } };
  function makeLock() {
    const events = {};
    const lock = { released: false, releases: 0, addEventListener(name, fn) { events[name] = fn; },
      release() { lock.releases++; lock.released = true; events.release?.(); return Promise.resolve(); },
      autoRelease() { lock.released = true; events.release?.(); } };
    locks.push(lock); return lock;
  }
  const navigator = { wakeLock: { request(type) { calls++; assert.equal(type, 'screen'); return request ? request(makeLock, document) : makeLock(); } } };
  const controller = createWakeLock({ navigator, document, onChange: value => changes.push(value) });
  return { controller, document, changes, locks, get calls() { return calls; },
    visibility(hidden) { document.hidden = hidden; listeners.visibilitychange?.(); } };
}

test('Wake Lock chỉ xin khi bật, không xin chồng khi đang chờ hay đã giữ, nhả khi tắt', async () => {
  const ui = setup();
  await settle(); assert.equal(ui.calls, 0);
  ui.controller.set(false); assert.equal(ui.calls, 0);
  ui.controller.set(true); ui.controller.set(true);
  await settle(); assert.equal(ui.calls, 1); assert.equal(ui.controller.state, 'bật');
  ui.controller.set(true); await settle(); assert.equal(ui.calls, 1);
  ui.controller.set(false); await settle();
  assert.equal(ui.locks[0].releases, 1); assert.equal(ui.controller.state, 'tắt');
  ui.visibility(false); await settle(); assert.equal(ui.calls, 1);
});

test('Tab ẩn làm nhả khóa, khóa tự nhả cũng chờ visibilitychange rồi xin lại khi hiện', async () => {
  const ui = setup(); ui.controller.set(true); await settle();
  ui.document.hidden = true; ui.locks[0].autoRelease();
  assert.equal(ui.controller.state, 'đang chờ (tab ẩn)');
  await settle(); assert.equal(ui.calls, 1);
  ui.visibility(false); await settle();
  assert.equal(ui.calls, 2); assert.equal(ui.controller.state, 'bật');
  ui.visibility(true); await settle();
  assert.equal(ui.locks[1].releases, 1);
  ui.visibility(false); await settle(); assert.equal(ui.calls, 3);
  ui.controller.set(false);
});

test('Khóa tự nhả lúc tab vẫn hiện được xin lại có giãn nhịp, chỉ có một khóa', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = setup(); ui.controller.set(true); await settle();
  ui.locks[0].autoRelease();
  assert.equal(ui.controller.state, 'đang chờ');
  t.mock.timers.tick(999); await settle(); assert.equal(ui.calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(ui.calls, 2);
  ui.controller.set(false);
});

test('NotAllowedError do tab chuyển sang ẩn trong lúc xin phải chờ hiện rồi thử lại', async () => {
  let reject;
  const ui = setup(makeLock => !reject ? new Promise((resolve, fail) => { reject = fail; }) : makeLock());
  ui.controller.set(true); await settle();
  ui.visibility(true);
  reject(Object.assign(new Error('Trang không hiện'), { name: 'NotAllowedError' }));
  await settle(); assert.equal(ui.calls, 1); assert.equal(ui.controller.state, 'đang chờ (tab ẩn)');
  ui.visibility(false); await settle();
  assert.equal(ui.calls, 2); assert.equal(ui.controller.state, 'bật'); ui.controller.set(false);
});

test('Lỗi chính sách bị chặn dừng sau ba lần, giãn nhịp 1 rồi 2 giây và không thông báo lặp', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = setup(() => { throw new Error('Chính sách chặn'); });
  ui.controller.set(true); await settle();
  assert.equal(ui.calls, 1); assert.equal(ui.controller.state, 'bị chặn');
  t.mock.timers.tick(999); await settle(); assert.equal(ui.calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(ui.calls, 2);
  t.mock.timers.tick(1999); await settle(); assert.equal(ui.calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(ui.calls, 3);
  t.mock.timers.tick(60_000); await settle(); assert.equal(ui.calls, 3);
  assert.equal(ui.changes.filter(value => value === 'bị chặn').length, 1);
  ui.visibility(true); ui.visibility(false); await settle(); assert.equal(ui.calls, 3);
  ui.controller.set(true); await settle(); assert.equal(ui.calls, 3);
  ui.controller.set(false);
});

test('Tắt trong lúc chờ retry hủy mọi lần thử còn lại', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ui = setup(() => Promise.reject(new Error('Pin yếu')));
  ui.controller.set(true); await settle(); ui.controller.set(false);
  t.mock.timers.tick(60_000); await settle(); assert.equal(ui.calls, 1);
});

test('Không xin khi bật trong tab ẩn, trình duyệt không hỗ trợ luôn giữ trạng thái không hỗ trợ', async () => {
  const ui = setup(); ui.visibility(true); ui.controller.set(true); await settle();
  assert.equal(ui.calls, 0); assert.equal(ui.controller.state, 'đang chờ (tab ẩn)');
  ui.visibility(false); await settle(); assert.equal(ui.calls, 1); ui.controller.set(false);
  const noApi = createWakeLock({ navigator: {}, document: ui.document });
  noApi.set(true); ui.visibility(true); ui.visibility(false);
  assert.equal(noApi.state, 'không hỗ trợ'); noApi.set(false);
});

test('Kết quả API đến sau khi tắt phải được nhả, tắt rồi bật không tạo hai khóa', async () => {
  let resolve;
  const ui = setup(makeLock => !resolve ? new Promise(done => { resolve = () => done(makeLock()); }) : makeLock());
  ui.controller.set(true); await settle(); ui.controller.set(false); resolve(); await settle();
  assert.equal(ui.locks[0].releases, 1); assert.equal(ui.controller.state, 'tắt');
  ui.controller.set(true); await settle(); assert.equal(ui.calls, 2);
  ui.controller.set(false);
  let finish;
  const rapid = setup(makeLock => !finish ? new Promise(done => { finish = () => done(makeLock()); }) : makeLock());
  rapid.controller.set(true); await settle(); rapid.controller.set(false); rapid.controller.set(true);
  finish(); await settle();
  assert.equal(rapid.calls, 2); assert.equal(rapid.locks[0].releases, 1); assert.equal(rapid.locks[1].releases, 0);
  rapid.controller.set(false);
});
