// Trạng thái dẫn xuất chỉ dùng cho giao diện, không đưa vào dữ liệu quét.
export const DELEGATING_MS = 45000;

export function activityPhase(run, now = Date.now()) {
  if (!run?.running) return 'nghỉ';
  return Number.isFinite(run.start) && now - run.start <= DELEGATING_MS ? 'giao' : 'làm';
}

export function activityText(run, now = Date.now()) {
  const phase = activityPhase(run, now);
  const seconds = Math.max(0, Math.floor((now - run.start) / 1000));
  return phase === 'giao' ? `đang giao (vừa gửi ${seconds} giây trước)` : phase === 'làm' ? 'đang làm' : 'đã xong';
}

export function watchActivityVisibility(document) {
  const update = () => document.documentElement.setAttribute('data-motion-paused', String(Boolean(document.hidden)));
  document.addEventListener('visibilitychange', update);
  update();
}
