// Chỉ giữ một khóa; thế hệ ngăn kết quả xin khóa cũ sống lại sau khi đã thoát.
export function createWakeLock({ navigator, document, onChange = () => {} }) {
  let enabled = false, sentinel = null, pending = null, generation = 0, attempts = 0, retry = null;
  let state = navigator?.wakeLock?.request ? 'tắt' : 'không hỗ trợ';
  const change = next => {
    if (state === next) return;
    state = next;
    onChange(next);
  };
  const cancelRetry = () => { if (retry !== null) clearTimeout(retry); retry = null; };
  const release = lock => { try { Promise.resolve(lock.release()).catch(() => {}); } catch {} };
  async function acquire() {
    if (!enabled || sentinel || pending || retry !== null || attempts >= 3 || !navigator?.wakeLock?.request) return;
    if (document.hidden) { change('đang chờ (tab ẩn)'); return; }
    const version = generation;
    attempts++;
    // Đặt pending trước khi gọi API, kể cả API giả ném lỗi đồng bộ.
    pending = Promise.resolve().then(() => navigator.wakeLock.request('screen'));
    try {
      const lock = await pending;
      if (!enabled || version !== generation || document.hidden) {
        release(lock);
        return;
      }
      sentinel = lock;
      attempts = 0;
      lock.addEventListener('release', () => {
        if (sentinel !== lock) return;
        sentinel = null;
        if (!enabled) return;
        if (document.hidden) change('đang chờ (tab ẩn)');
        else {
          change('đang chờ');
          // Nhả ngay khi hiện cũng cần xin lại, có giãn nhịp tránh vòng lặp.
          retry = setTimeout(() => { retry = null; void acquire(); }, 1000);
        }
      });
      change('bật');
    } catch (error) {
      if (!enabled || version !== generation) return;
      if (document.hidden && error?.name === 'NotAllowedError') {
        attempts--;
        change('đang chờ (tab ẩn)');
      } else {
        change('bị chặn');
        if (attempts < 3) retry = setTimeout(() => { retry = null; void acquire(); }, attempts * 1000);
      }
    } finally {
      pending = null;
      // Một lần tắt rồi bật xảy ra trong lúc API cũ còn chờ.
      if (enabled && version !== generation) void acquire();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!enabled || !navigator?.wakeLock?.request) return;
    cancelRetry();
    if (document.hidden) {
      const lock = sentinel;
      sentinel = null;
      if (lock) release(lock);
      change('đang chờ (tab ẩn)');
    } else if (attempts < 3) {
      void acquire();
    } else change('bị chặn');
  });
  return {
    get state() { return state; },
    set(value) {
      value = Boolean(value);
      if (value === enabled) return;
      enabled = value;
      generation++;
      cancelRetry();
      attempts = 0;
      if (!navigator?.wakeLock?.request) { change('không hỗ trợ'); return; }
      if (enabled) {
        change(document.hidden ? 'đang chờ (tab ẩn)' : 'đang chờ');
        void acquire();
      } else {
        const lock = sentinel;
        sentinel = null;
        if (lock) release(lock);
        change('tắt');
      }
    },
  };
}
