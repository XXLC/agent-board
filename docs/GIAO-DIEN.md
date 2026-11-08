# Giao diện

Giao diện là HTML, CSS và JS thuần trong `public/`, không framework, không CDN, không font ngoài. Thời gian hiển thị cố định theo Việt Nam (UTC+7). Theo chế độ sáng/tối của hệ thống, mặc định tối.

## Tên làn và model

Mã làn nội bộ (`Claude`, `Codex`, `Opus`, `Argon`) giữ nguyên ở API. Tên hiển thị nằm ở hằng số `LANE_LABELS` trong `public/model-labels.js`: **Claude Code**, **Codex**, **Antigravity Opus** (Claude chạy qua agy), **Gemini Argon** (Gemini chạy qua agy). Tên làn chỉ là vai trò, nên mỗi lần chạy luôn ghi đúng model; model lệch tên làn có chú thích "model khác tên làn" ở chi tiết và tooltip.

Trong làn Claude Code, Sonnet và Opus phân biệt bằng chữ và hoa văn, không chỉ bằng màu: tiền tố "S 5.5" và "O 5.5", viền đôi cho Opus; thẻ ghi số đoạn theo model. Thẻ Claude Code ghi số đoạn theo model trong 24 giờ và **liệt kê cả phiên bản mới nhất của mỗi họ model đã dùng trong 7 ngày** dù chưa có đoạn nào trong khung (số 0, ví dụ "Opus 5.5 x 0"), để thấy Claude còn dùng Opus 5.5; model cũ (Sonnet 5, Opus 4.8) chỉ hiện khi thật sự có đoạn trong khung (`latestPerFamily` trong `public/model-labels.js`, dữ liệu `models7d` ở `/api/state`). Nút gốc của sơ đồ liệt kê model theo đúng quy tắc đó. Bộ lọc **Model** liệt kê tên đẹp kèm số lần ("Sonnet 5.5 (22)") và dùng chung cho cả dòng thời gian và sơ đồ.

## Thẻ trạng thái và bộ đếm thời gian, token

Mỗi làn một thẻ: trạng thái (Đang chạy, Rảnh, Lỗi gần nhất), model và effort, lời nhắc (hai dòng, bẻ được đường dẫn dài; `title` là bản đã che tối đa 200 ký tự), dự án, dòng bộ đếm `.card-counter` và chân thẻ: "Vừa giao N giây trước" khi đang giao, "Đang làm: ..." khi đang làm, "Lần gần nhất: ..." khi rảnh, kèm số lần giao trong 24 giờ (riêng Claude là số đoạn hoạt động, kèm đếm theo model). Thẻ Codex có dòng "Cấu hình hiện tại".

Các phép tính và định dạng bộ đếm nằm chung ở `public/counters.js` (cách lấy dữ liệu gốc và các trường API ở [NGUON-DU-LIEU.md](NGUON-DU-LIEU.md)):

- **Vị trí hiển thị**:
  - **Thẻ trạng thái** (`.card-counter`): `Token 24 giờ: <tổng>` (hoặc `Token: chưa đọc được`) `· chạy <thời lượng>`; `title` liệt kê 6 thành phần (`Vào`, `Cache đọc`, `Cache ghi`, `Ra`, `Suy luận (nằm trong ra)`, `Tổng`) kèm độ phủ `X/Y lần có số liệu`.
  - **Dải chip 24 giờ** (`#counters`): mỗi làn một `.counter-chip` ghi `24 giờ: chạy <thời lượng> · <token>`, thêm `· đang chạy: <tokensRunning> token` khi làn đang chạy và có số liệu.
  - **Dải chip theo khoảng và bộ lọc** (`#range-counters`): cộng token của toàn bộ các lần chạy đang hiển thị và tính thời gian chạy (`busyMs`) bằng hợp các khoảng chồng nhau cắt theo biên khung nhìn `[from, to]`.
  - **Dải chip chỉ sơ đồ** (`#map-counters`): mỗi chip gộp cả dòng 24 giờ và dòng theo khoảng đang chọn (`.counter-range`).
  - **Bóng gốc, làn và dự án trên sơ đồ** (`.map-counter`, `nodeCounters`): hàng thời gian rút gọn (`X giờ`, `X phút`, `X giây`) và token (`· <token>` khi có số liệu; bóng dự án thiếu token chỉ hiện thời gian, và ẩn dòng này nếu `busyMs = 0`). Lá và nút gộp không có dòng bộ đếm trên bóng (lá ghi token trong `title`/`aria-label`).
- **Lý do hiện "chưa đọc được token"**: việc hiện `"chưa đọc được token"` (thay vì `"0 token"`) dựa vào dữ liệu thực (`runsWithTokens === 0` ở thẻ/chip/bóng, hoặc `run.tokens === null` ở từng lần chạy). Câu giải thích đi kèm ở tooltip và panel chi tiết do `unreadTokenReason(lane)` trả về theo làn: với `Opus`/`Argon` là `"chưa có lần gọi model nào hoàn tất để tính token"`, với `Claude`/`Codex` là `"Nguồn chưa cung cấp số liệu token"`.
- **Nhịp sống**: `tickCounters` ở `public/app.js` cập nhật mỗi giây nhưng chỉ đổi `textContent`, cập nhật `aria-label` mỗi 30 giây, và dùng `IntersectionObserver` kết hợp `document.hidden` để tự dừng `setInterval` khi tab ẩn hoặc khi cuộn khuất mọi vùng đếm.

## Dòng thời gian

- Mỗi làn một hàng; mỗi lần giao là một thanh. Mặc định mở 6 giờ; có 24 giờ, 7 ngày, 30 ngày, nút lùi/tiến/hiện tại, phóng to, thanh cuộn ngang và kéo vùng trống. "Phóng to vùng hoạt động" thu về thanh đã chọn hoặc toàn bộ hoạt động đang lọc (khoảng nhỏ nhất 10 phút).
- Trạng thái phân biệt bằng hoa văn: thành công (đặc), lỗi (viền đứt và X), hết quota (sọc chéo), đang chạy (nhấp nháy), chưa rõ (chỉ viền); giờ kết thúc ước lượng có viền đứt mờ và panel chi tiết ghi mốc gốc. Phiên tương tác Codex hiển thị mờ.
- Thanh rộng tối thiểu 6 px; dưới 70 px không in chữ nhưng vẫn có `title`, điều hướng bàn phím và chi tiết. Thanh bắt đầu trước khung bị cắt ở mép trái kèm viền đứt "Tiếp tục từ trước khung nhìn"; `end: null` vẽ tới hiện tại.
- Nhãn trục đo chiều rộng thực trong DOM và bỏ nhãn cách nhãn trước dưới 8 px.
- Bấm thanh hoặc dùng Tab rồi Enter mở panel chi tiết: làn, model, giờ bắt đầu và kết thúc, thời lượng, dự án (và đường dẫn thật), nguồn lời nhắc, nguồn model, kết quả, chứng cứ ghép.

## Sơ đồ (mindmap)

SVG thuần, mọi kích thước tính trong JS (`public/mindmap.js`, `public/mindmap-layout.js`). Gốc "Claude Code" ở giữa, ba làn, rồi dự án, rồi lá là từng lần giao. Phiên tương tác Codex và đoạn hoạt động Claude không tính thành lá.

- Mỗi làn hiện tối đa 8 dự án, mỗi dự án tối đa 10 lần giao (mới nhất trước); "+N dự án" và "+N lần giao" mở thêm; bấm làn hoặc dự án để thu gọn/mở lại và mở chi tiết lần giao mới nhất của nút đó.
- **Thứ bậc bóng và độ đọc**:
  - Bán kính giữ thứ bậc nghiêm ngặt `gốc > làn > dự án > lá` (`NODE_RADII`: gốc `165..190`, làn `126..132`, dự án `74..90` chặn trần bằng `boundedNodeRadius`, lá `7..18` theo log thời lượng, nút gộp `58`; đo thực tế điển hình `165 > 126 > 82,2 > 15,6`; tỉ lệ tối thiểu `gốc >= 1,25 × làn`, `làn >= 1,2 × dự án`, `dự án >= 1,3 × lá`). Độ dày cạnh gốc đến làn theo căn bậc hai số lần giao (2 đến 10); cung làn tối thiểu 70 độ; chừa tối thiểu 4 đơn vị giữa hai vùng dự trữ; nhãn dự án cắt bằng `...` theo ước lượng độ rộng.
  - Cỡ chữ cơ sở (`NODE_FONTS`: gốc `22`, làn `18`, dự án `15`, lá `12`) được bù theo thu phóng (`compensatedFont`): khi thu nhỏ, tiêu đề bóng gốc, làn, dự án được nâng lên để đạt mục tiêu trên màn hình **12 / 12 / 10 px**, nhưng luôn bị chặn bởi trần (`44 / 32 / 26`) và dây cung ngang cùng chiều cao có lề 6 đơn vị để không tràn khỏi vòng tròn.
  - Phụ đề và dòng bộ đếm/đồng hồ (`subtitle`, `counter`, `elapsed`) tự ẩn (`display="none"`) khi cỡ chữ trên màn hình dưới **8 px** (hằng `SUBTITLE_MIN_SCREEN_PX`, hàm `rowVisible`) và hiện lại khi phóng to; tiêu đề không bao giờ ẩn.
  - Kéo nền để pan; lăn chuột hoặc nút để zoom; **"Căn giữa"** (`#map-center`) vừa phần lõi (`coreBounds`: gốc, làn, dự án), **"Xem tất cả"** (`#map-show-all`) vừa cả lá (`bounds`), và **"Sắp xếp lại"**.
  - **Đánh đổi trung thực**: hàng thời gian/token của bóng dự án ở góc nhìn tổng quan dưới ngưỡng 8 px nên tự ẩn và chỉ hiện khi phóng to; khi xem tổng quan thì đọc qua tooltip (`title`) của bóng hoặc trên thẻ/chip.
- **Chế độ toàn màn hình chỉ sơ đồ và giữ màn hình sáng**:
  - Bật bằng nút **"Toàn màn hình"** (`#map-fullscreen`), phím **F11** (bỏ qua khi giữ Ctrl/Alt/Meta hoặc đang ở ô nhập), hoặc khi trình duyệt vào toàn màn hình (`isBrowserFullscreen` lệch tối đa 2 px hoặc `display-mode: fullscreen`). Gọi `requestFullscreen()` trên `#map-stage` và bật `html.map-only`; nếu trình duyệt chặn `requestFullscreen`, vẫn áp dụng bố cục `html.map-only` bằng CSS và hiện thông báo không chặn. Bấm F11 từ tab Dòng thời gian sẽ tự chuyển sang Sơ đồ và khôi phục tab cùng vị trí cuộn khi thoát.
  - Trong `html.map-only`, chỉ hiện `#map-stage` kèm thanh công cụ, bộ đếm `#map-counters`, nút **"Chú giải"** (`#map-legend-toggle`, mặc định thu gọn chú giải thành lớp phủ) và đồng hồ; panel `#details` chỉ mở dạng lớp phủ khi bấm chọn nút.
  - Thoát bằng **Esc** hai bậc: nếu lớp phủ chi tiết đang mở thì Esc lần một đóng chi tiết, lần hai mới thoát toàn màn hình.
  - Giữ màn hình sáng bằng **Screen Wake Lock** (`public/wake-lock.js`, trạng thái ở `#wake-lock-status`): chỉ hoạt động trong chế độ chỉ sơ đồ khi tab đang hiển thị (`!document.hidden`), tự nhả khi ẩn tab (`"đang chờ (tab ẩn)"`) và tự xin lại khi tab hiện lại; nếu bị chặn thì thử lại tối đa 3 lần với độ trễ 1 giây rồi 2 giây. Không chặn khóa máy tay hay đóng nắp máy; chính sách nhàn rỗi của hệ điều hành có thể thắng Wake Lock (**chưa kiểm chứng**).
- Hàm bố cục `layoutMindmap(runs, options)` ở `public/mindmap-layout.js` là hàm thuần, nhập được từ Node để test (có `now` để đo lặp lại, `previous` để giữ vị trí cũ). Cập nhật SSE chỉ đổi thuộc tính phần tử đã có và thêm hoặc bỏ nút khi tập hiển thị đổi; vị trí, pan/zoom và trạng thái mở rộng được giữ nguyên. Tab Sơ đồ ẩn thì không tính bố cục và không vẽ; chuyển sang tab thì vẽ ngay.
- Chọn tab bằng `#dong-thoi-gian` hoặc `#so-do`. Hai tab dùng chung khoảng thời gian, bộ lọc làn, model, dự án, giao chéo.

## Giao chéo dự án

Khi phiên Claude ở dự án A giao việc cho model làm việc ở thư mục của dự án B (cách xác định ở [NGUON-DU-LIEU.md](NGUON-DU-LIEU.md)), giao diện nói rõ cả hai dự án. Nhãn dùng chung một bộ hàm thuần trong `public/model-labels.js` (`crossProjectLabel`, `crossProjectCardText`, `crossProjectDetailText`...), không lặp chuỗi ở nhiều nơi, mỗi câu nêu thông tin một lần.

- **Thẻ trạng thái**: dòng dự án hiện "A → B" khi lần giao gần nhất của làn là chéo; `title` ghi "Giao từ A, làm việc ở B" kèm đường dẫn.
- **Panel chi tiết**: dòng "Giao chéo dự án" ("Phiên Claude ở dự án A giao việc cho `model` làm việc ở dự án B (đường dẫn)"). Dòng "Dự án" vẫn là dự án của phiên giao việc.
- **Dòng thời gian**: thanh giao chéo có mũi tên nhỏ ở đầu trái (dùng `currentColor` nên đủ tương phản trên cả thanh nền sáng lẫn tối, không dựa vào màu của làn); `title` và `aria-label` ghi "giao chéo sang dự án B". Thanh hẹp vẫn có dấu, không có chữ.
- **Sơ đồ và kết nối giao chéo**: lá giao chéo có dấu mũi tên nhỏ (`.map-cross-mark`); tooltip và `aria-label` ghi "giao chéo: làm việc ở dự án B"; tooltip nút dự án nêu "N lần giao chéo sang dự án khác". Khi **bấm vào bóng lá có dấu mũi tên nhỏ**, sơ đồ hiện **đường cong nét đứt** (`.map-cross-link`, có mũi tên ở đầu đích) nối sang dự án khác (bấm lại hoặc bấm nền trống để ẩn); khi lần giao chéo đang chạy (nét đứt đang chạy), đường nối này **tự hiện**. Đường nối ưu tiên nút dự án đích cùng làn, dự phòng nút cùng dự án ở làn khác, hoặc vẽ đoạn cong ngắn kèm thẻ `"→ <tên dự án>"` nếu dự án đích đang ẩn trên sơ đồ. Cây không đổi cấu trúc: lá vẫn nằm dưới dự án của phiên giao việc, và cập nhật SSE không dựng lại nút hay đường nối.
- **Bộ lọc "Giao chéo"** (Tất cả, Chỉ giao chéo, Không giao chéo) dùng chung cho dòng thời gian và sơ đồ; chú giải có mục mũi tên nhỏ và nét cong đứt; chân trang ghi "Giao chéo dự án: X/Y lần giao".

## Đang giao và đang làm

`activityPhase(run, now)` ở `public/activity.js` (dẫn xuất phía giao diện, không nằm trong dữ liệu quét):

| Pha | Điều kiện |
| --- | --- |
| `giao` | run đang chạy và bắt đầu cách đây `DELEGATING_MS` = 45 giây trở lại |
| `làm` | run đang chạy lâu hơn 45 giây |
| `nghỉ` | đã xong |

Hiển thị:

- **Sơ đồ không in chữ `"đang làm"` hay `"đang giao"` trong bóng**: mũi tên và hạt tròn chạy trên nét nối đứt từ gốc = đang giao; vòng tròn halo nhấp nháy lan tỏa quanh bóng gốc, làn, lá = đang làm (nút gốc có halo liên tục khi có đoạn Claude đang chạy, kể cả khi tự làm chưa giao việc; gợn sóng chỉ phát khi có lần giao mới); nút làn có huy hiệu `"N đang chạy"`.
- Hàng đồng hồ sống (`.map-elapsed`, ở bóng gốc và làn) chỉ còn hiển thị **thời lượng** (ô dự trữ chiều rộng cố định bằng `'59 phút 59 giây'`, để trống khi nghỉ nên bán kính bóng và vị trí các dòng không bao giờ nhảy khi đổi trạng thái); `aria-label` và `title` vẫn nêu rõ trạng thái giao/làm bằng lời.
- Dòng thời gian: thanh đang chạy có chấm nhấp nháy ở đầu phải và viền nét đứt chạy, nhãn `"đang giao"`/`"đang làm"` nếu thanh rộng từ 150 px trở lên; nhãn làn và thẻ có chấm nhấp nháy.
- Phần tử hiệu ứng chỉ có ở run đang chạy, chỉ animate `transform` và `opacity`, tạm dừng khi tab ẩn (`data-motion-paused`).

## Trợ năng

- `prefers-reduced-motion: reduce`: không dựa vào animation để phân biệt trạng thái. Trên sơ đồ, bóng đang làm hiện **vòng halo tĩnh dày gấp đôi** (`stroke-width: 4`); cạnh đang giao có **nét đứt tĩnh kèm mũi tên tĩnh và chấm đặc**, còn cạnh đang làm chỉ có nét đứt tĩnh; thẻ và thanh dòng thời gian hiện nhãn chữ `"đang giao"`/`"đang làm"`.
- Không dùng màu làm tín hiệu duy nhất (hoa văn, viền, chữ). Nút và thanh có `tabindex`, `aria-label` nêu cả trạng thái giao/làm; Enter hoặc Space kích hoạt.
- Màn hình hẹp (khoảng 390 px): thẻ một cột, bộ lọc xuống dòng, vùng biểu đồ cuộn ngang trong khung chứ không nới trang, sơ đồ co theo chiều rộng khung.

## Hai bẫy giao diện đã gặp (có test hồi quy)

- Dòng thời gian được dựng lại mỗi giây (`renderChart`), nên animation mới sinh bắt đầu từ 0 và không bao giờ chạy trọn một nhịp. Cách sửa: đặt pha theo đồng hồ thật bằng biến `--phase-<chu kỳ>` trên `#chart` (độ trễ âm `-(Date.now() mod chu kỳ)`), CSS dùng `animation-delay:var(--phase-...)`.
- Bộ chọn CSS hậu duệ `.map-node:hover circle` từng đè lên vòng halo và chấm huy hiệu và thua quy tắc "đang làm" về độ ưu tiên. Nay dùng `> circle:not(.map-halo):not(.map-badge-dot)`.
