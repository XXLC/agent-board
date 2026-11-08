# Kiểm thử, hiệu năng và kiểm giao diện

## Bộ test

```powershell
npm test                      # tương đương: node --test
node --disable-warning=ExperimentalWarning --test    # ẩn cảnh báo node:sqlite thử nghiệm
```

Test dùng dữ liệu tổng hợp (JSONL và SQLite tạo tạm trong `.cache`), không đụng bản ghi thật và không chứa bí mật hay tên thật. Hiện bộ kiểm thử có **245 kiểm thử đạt, 0 lỗi** khi chạy `node --test`. Mỗi lỗi đã sửa có test hồi quy; khi sửa một lỗi, nên kiểm tra bằng đột biến rằng test mới thật sự thất bại với mã cũ (đặt lại logic cũ, chạy test, rồi khôi phục).

Các tệp kiểm thử trong `test/`:

- Quét, phân tích, ghép và hiệu năng: `board.test.mjs` (quét, API, Host), `agy.test.mjs` (SQLite, mốc giờ, ghép, cache), `agy-tokens.test.mjs` (giải mã protobuf `gen_metadata`, kiểm trần 2.000.000, cộng dồn và ghép token agy), `tokens.test.mjs` (khử trùng `message.id` của Claude, tích lũy cuối của Codex, `tokens24h`, `busyMs24h`, `tokensRunning`), `codex-prompts.test.mjs` (lời nhắc), `projects.test.mjs` (gom dự án, giao chéo), `performance.test.mjs` (nhường vòng lặp).
- Giao diện, sơ đồ và bộ đếm: `model-labels.test.mjs`, `activity.test.mjs`, `counters.test.mjs` (định dạng thời lượng, đơn vị triệu/tỷ token, độ phủ, hợp khoảng thời gian), `wake-lock.test.mjs` (vòng đời Screen Wake Lock, ẩn/hiện tab, thử lại tối đa 3 lần), `mindmap.test.mjs` và `mindmap-ui.test.mjs` (hình học, SSE, chuyển pha), `node-text.test.mjs` (dòng chữ trong bóng, dự trữ ô đồng hồ, bỏ chữ pha, bộ đếm bóng dự án), `mindmap-sizing.test.mjs` (thứ bậc bán kính gốc > làn > dự án > lá, trần bán kính dự án, bù cỡ chữ theo thu phóng, ẩn dòng phụ dưới 8 px, kiểm đột biến), `fullscreen.test.mjs` (chế độ chỉ sơ đồ `map-only`, phím F11/Esc hai bậc, phát hiện toàn màn hình trình duyệt, đường nối giao chéo), `ui.test.mjs` (DOM mô phỏng cho dòng thời gian, thẻ, chip và nhịp sống).

Test giao diện chạy trong `node:vm` với DOM tối thiểu, nên **không thay thế** việc xem trên trình duyệt thật (font, hoạt ảnh, cảm ứng).

## Cổng hồi quy bằng hash

Trước khi sửa phần quét, ghép hay phân tích, chụp "dấu vân tay" kết quả rồi so lại sau khi sửa:

```powershell
$cut = [DateTimeOffset]::UtcNow.AddMinutes(-30).ToUnixTimeMilliseconds()
node --disable-warning=ExperimentalWarning scripts/fingerprint.mjs .cache/truoc.json $cut
# ... sửa mã ...
node --disable-warning=ExperimentalWarning scripts/fingerprint.mjs .cache/sau.json $cut   # cùng mốc cắt
```

Hash `sha256` bao phủ id, làn, nguồn, trạng thái, `projectKey`, `promptSource`, `start`, `end`, `model` của các run **đã xong** và bắt đầu trước mốc cắt. Trùng nghĩa là hành vi không đổi; khác là đã đổi hành vi (hoàn nguyên hoặc giải thích, không được cập nhật mốc so sánh cho khớp). Chạy hai lần liên tiếp phải cho cùng hash. Dùng mốc cắt cách hiện tại vài chục phút vì phiên đang ghi thêm dữ liệu. Tệp ra không chứa lời nhắc hay nội dung.

Đổi giao diện thuần tuý không được làm đổi hash; thêm trường mới vào run (như `tokens`, `tokenSource`, `crossProject`) thì không đổi hash, nhưng đổi giá trị trường đã nằm trong hash thì đổi. Mốc kiểm đã xác nhận trên dữ liệu phát triển hiện tại: mốc cắt `1794071641107` cho `2358` run đã xong, mã băm `sha256` `ccf32280b89248e1...`.

## Đo hiệu năng

`scripts/perf.mjs` đo trên nguồn thật và dữ liệu nối thêm tổng hợp (thời gian quét đầu, độ trễ vòng lặp bằng `monitorEventLoopDelay`, lượt quét tăng dần, RSS); `AGENT_BOARD_PERF_API=1` đo thêm HTTP ở cổng 8091. Chạy mỗi phép đo ít nhất hai lần vì máy có nhiễu. Mục tiêu đã dùng: quét đầu khoảng 10 giây trở xuống, độ trễ vòng lặp p99 dưới 100 ms, lượt không đổi dưới 50 ms.

Khi một thay đổi làm quét chậm, đo hồ sơ CPU (`node --cpu-prof`) rồi tóm tắt thời gian tự thân theo hàm thay vì đoán; hai thủ phạm đã gặp là `JSON.parse` với che bí mật cho mọi dòng và chuẩn hóa chuỗi đường dẫn lặp trong vòng ghép.

## Công cụ khác

- `scripts/smoke.mjs`: tự khởi động `node server.mjs`, dùng `curl.exe` kiểm tra trang chủ, hai API, `Host` không hợp lệ và một lượt quét tăng dần, rồi dừng server. Cần cổng đang trống.
- `scripts/survey.mjs`: khảo sát nguồn thật, chỉ in thống kê, tên trường và tên model, không in bản ghi hay lời nhắc.

Khi thử server trong lúc phát triển, dùng `AGENT_BOARD_PORT=8091` để không đụng bản đang chạy ở 8090.

## Kiểm giao diện bằng trình duyệt thật

1. Chạy Edge hoặc Chrome headless với cổng gỡ lỗi loopback (`--headless=new --remote-debugging-port=<cổng> --remote-debugging-address=127.0.0.1 --user-data-dir=<thư mục tạm>`), mở trang bằng `PUT /json/new?<url>`. Phần sau dấu `#` bị cắt khi truyền qua HTTP; muốn mở tab Sơ đồ thì điều hướng bằng CDP `Page.navigate` tới URL có `#so-do`.
2. **Đưa tab lên tiền cảnh** (`Page.bringToFront` cộng `Emulation.setFocusEmulationEnabled`) trước khi đo chuyển động; tab nền có `document.hidden = true` nên trang tự tạm dừng animation và không dựng lại dòng thời gian.
3. Đo hoạt ảnh qua `getAnimations()` bằng thời gian tuyến tính `(localTime - delay) mod duration`, không dùng `progress` (đã qua hàm làm mượt) và không dùng bộ đếm giờ trong trang ở tab nền (bị giảm tốc). Pha đúng thì bám `Date.now() mod chu kỳ` trong vài chục ms.
4. Chụp màn hình qua `Page.captureScreenshot`; tệp base64 nằm trong kết quả. Cuộn trang bằng `Runtime.evaluate`.
5. Đóng trình duyệt tạm và xóa thư mục hồ sơ tạm sau khi xong.
