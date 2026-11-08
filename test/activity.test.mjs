import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DELEGATING_MS, activityPhase, watchActivityVisibility } from '../public/activity.js';

test('Giai đoạn dùng chung ngưỡng 45 giây kể cả đúng mốc', () => {
  assert.equal(DELEGATING_MS, 45000);
  const run = { start: 100000, running: true };
  for (const [elapsed, phase] of [[0, 'giao'], [44900, 'giao'], [45000, 'giao'], [46000, 'làm']]) {
    assert.equal(activityPhase(run, run.start + elapsed), phase);
  }
  for (const running of [false, undefined]) assert.equal(activityPhase({ ...run, running }, 100000), 'nghỉ');
  assert.equal(activityPhase(null, 100000), 'nghỉ');
});

test('Ẩn tab tạm dừng chuyển động, mở lại tiếp tục', () => {
  const attrs = {}, events = {};
  const document = { hidden: false, documentElement: { setAttribute(key, value) { attrs[key] = value; } },
    addEventListener(key, handler) { events[key] = handler; } };
  watchActivityVisibility(document);
  assert.equal(attrs['data-motion-paused'], 'false');
  document.hidden = true; events.visibilitychange();
  assert.equal(attrs['data-motion-paused'], 'true');
  document.hidden = false; events.visibilitychange();
  assert.equal(attrs['data-motion-paused'], 'false');
});

test('Chuyển động chỉ đổi transform, opacity; giảm chuyển động có vòng tĩnh, mũi tên và nhãn ở thẻ, thanh', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const [, body] of css.matchAll(/@keyframes[^{]+\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    for (const [, declarations] of body.matchAll(/\{([^{}]*)\}/g)) {
      assert.ok(declarations.split(';').filter(text => text.trim()).every(text => /^\s*(transform|opacity)\s*:/.test(text)));
    }
  }
  const reduced = css.slice(css.lastIndexOf('@media(prefers-reduced-motion:reduce)'));
  assert.match(reduced, /stroke-width:4/);
  assert.match(reduced, /stroke-dasharray:none/);
  assert.match(reduced, /\.activity-delegating > \.map-end-dot/);
  assert.match(reduced, /animation:none!important/);
  assert.match(reduced, /\.badge-phase \{ display:block/);
  assert.match(css, /animation-play-state:paused!important/);
  for (const label of ['Nét đứt chạy từ Claude = đang giao việc', 'Vòng tròn nhấp nháy = đang làm', 'Nét liền mảnh = đã xong']) assert.ok(html.includes(label));
});

test('Giảm chuyển động phân biệt bóng bằng halo tĩnh dày gấp đôi và nét giao có mũi tên, chấm đặc', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const reduced = css.slice(css.lastIndexOf('@media(prefers-reduced-motion:reduce)'));
  const declarations = (text, selector) => {
    const matches = [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1].split(',').some(part => part.trim() === selector));
    assert.ok(matches.length, `Thiếu quy tắc ${selector}`);
    return Object.fromEntries(matches.flatMap(match => match[2].split(';').filter(part => part.includes(':'))
      .map(part => part.split(':').map(value => value.trim()))));
  };
  const baseWidth = Number(declarations(css, '.map-halo')['stroke-width']);
  assert.equal(baseWidth, 2);
  for (const type of ['root', 'lane', 'run']) {
    const halo = declarations(reduced, `.map-${type}.activity-working .map-halo`);
    assert.equal(halo.opacity, '1');
    assert.equal(Number(halo['stroke-width']), baseWidth * 2);
    assert.equal(halo['stroke-dasharray'], 'none');
    assert.equal(halo.transform, 'scale(1.12)');
    assert.equal(declarations(reduced, `.map-${type} .halo-1`).display, 'none!important');
  }
  assert.equal(declarations(reduced, '*').animation, 'none!important');
  assert.equal(declarations(reduced, '.map-particles').display, 'none!important');
  for (const mark of ['map-arrow', 'map-end-dot']) {
    assert.equal(declarations(css, `.${mark}`).fill, 'var(--activity-color)');
    assert.equal(declarations(reduced, `.map-edge.activity-delegating > .${mark}`).display, 'inline');
    assert.doesNotMatch(reduced, new RegExp(`activity-working > \\.${mark}`));
  }
  assert.equal(declarations(css, '.map-flow')['stroke-dasharray'], '12 8');
});

test('CSS: hover và focus chỉ đổi vòng chính, không đụng halo hay chấm huy hiệu', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.map-node:hover > circle:not\(\.map-halo\):not\(\.map-badge-dot\)/);
  assert.match(css, /\.map-node:focus-visible > circle:not\(\.map-halo\):not\(\.map-badge-dot\)/);
  // Bộ chọn hậu duệ chung "circle" từng làm halo và chấm huy hiệu bị viền focus dày.
  assert.doesNotMatch(css, /\.map-node:(?:hover|focus-visible) circle/);
  assert.doesNotMatch(css, /\.map-node\.(?:error|estimated) circle/);
});

test('Pha animation theo đồng hồ thật: mọi --phase-N trong CSS đều được app.js đặt', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const used = [...new Set([...css.matchAll(/var\(--phase-(\d+)/g)].map(match => match[1]))];
  assert.ok(used.length >= 4, 'CSS phải dùng các biến pha để animation không bị đặt lại mỗi giây.');
  const declared = app.match(/for \(const ms of \[([\d, ]+)\]\) chart\.style\.setProperty\(`--phase-\$\{ms\}`/)?.[1].split(',').map(item => item.trim());
  assert.ok(declared, 'app.js phải đặt biến pha sau mỗi lần dựng lại dòng thời gian.');
  for (const ms of used) assert.ok(declared.includes(ms), `--phase-${ms} được CSS dùng nhưng app.js không đặt`);
  // Biến chỉ có giá trị hợp lệ cho animation trùng chu kỳ: chu kỳ khai báo trong CSS phải khớp tên biến.
  assert.match(css, /\.run-bar\.running::before \{ animation-delay:var\(--phase-2800/);
  assert.match(css, /\.run-bar\.activity-delegating::before \{ animation-delay:var\(--phase-700/);
  assert.match(css, /\.activity-dot \{ animation-delay:var\(--phase-1600/);
});

test('Giảm chuyển động: mũi tên và chấm đặc chỉ ở cạnh đang giao nên giao và làm vẫn phân biệt được', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'));
  assert.match(block, /\.map-edge\.activity-delegating > \.map-arrow/);
  assert.match(block, /\.map-edge\.activity-delegating > \.map-end-dot/);
  assert.doesNotMatch(block, /\.map-edge\.activity-working > \.map-arrow/);
  assert.doesNotMatch(block, /\.map-edge\.activity-working > \.map-end-dot/);
});

test('Chú giải: nét đứt chạy bị cắt để không đâm qua mũi tên', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<clipPath id="legend-flow-clip">/);
  assert.match(html, /<g clip-path="url\(#legend-flow-clip\)"><line class="map-flow"/);
  assert.doesNotMatch(html, /<svg[^>]*><line class="map-flow"/);
});

test('CSS: nút gốc đang chạy có halo liên tục và có phương án tĩnh khi giảm chuyển động', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.map-root\.activity-working \.map-halo \{ display:inline; animation:activity-halo 1\.6s ease-out infinite both; \}/);
  assert.match(css, /\.map-root\.activity-working \.halo-1 \{ display:inline; \}/);
  const reduced = css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'));
  assert.match(reduced, /\.map-root\.activity-working \.map-halo \{[^}]*stroke-width:4/);
  // Nút gốc không chạy thì halo vẫn ẩn khi giảm chuyển động.
  assert.match(reduced, /\.map-root:not\(\.activity-working\) \.map-halo/);
});
