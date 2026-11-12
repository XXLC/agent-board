# Agent Board: hướng dẫn cho agent và người đóng góp

Bảng web cục bộ theo dõi Claude Code, Codex, Antigravity Opus, Gemini Argon và DeepSeek (Codewhale). Tổng quan ở [README.md](README.md); kiến trúc, nguồn dữ liệu, giao diện, kiểm thử ở [docs/](docs/). Tệp này là bản gốc; `CLAUDE.md` và `GEMINI.md` chỉ trỏ về đây kèm vài ghi chú riêng của từng công cụ.

## Quy tắc bắt buộc

- Chữ, nhận xét mã, thông báo, commit: tiếng Việt có dấu đầy đủ. Không emoji.
- YAGNI, KISS, DRY. Không gói ngoài (zero dependency), không CDN, không font ngoài, không gọi mạng. Node 24 trở lên (dùng `node:sqlite`). Không thêm tính năng ngoài yêu cầu.
- Mã mới không dài dòng bất thường (tránh dòng trên 200 ký tự); CSS định dạng nhiều dòng, một khai báo một dòng.
- Quy tắc chung của workspace nếu có (`AGENTS.md` ở thư mục cha) vẫn áp dụng.

## Bất biến an toàn và quyền riêng tư (không được phá)

1. Mọi nguồn dữ liệu chỉ đọc: `~/.claude`, `~/.codex`, `~/.gemini`. Không ghi, xóa, đổi tên ở đó. SQLite của agy mở bằng `readOnly: true`.
2. Không in, không lưu, không đưa vào test hay báo cáo **nội dung hội thoại hay lời nhắc thật**. Lời nhắc được che mẫu bí mật và cắt ngắn (200 ký tự ở chi tiết, 120 ở thẻ). Test chỉ dùng dữ liệu tổng hợp, không chứa tên người, công ty hay bí mật thật.
3. Không giải mã bằng khóa, không đọc keyring, không gọi daemon Antigravity, không dùng `agy-reader`. Chỉ giải mã trường protobuf có độ dài hợp lệ từ SQLite thường.
4. Dữ liệu từ bản ghi là không tin cậy: đưa vào DOM bằng `textContent`/`setAttribute`, tuyệt đối không `innerHTML`, `eval`, `new Function`. Đường dẫn lấy từ bản ghi chỉ được đọc trong danh sách cho phép (`lib/prompt-files.mjs`).
5. Server chỉ lắng nghe `127.0.0.1`, chỉ `GET`, kiểm `Host`, CSP chặt. Không mở ra mạng, không bật CORS.
6. Cấu hình Codex chỉ đọc hai khóa `model` và `model_reasoning_effort`; không phân tích hay lưu phần còn lại.
7. Không chạy `codex`, `agy`, `claude` để thử chức năng và không đổi cấu hình quyền của bất kỳ agent nào, trừ khi người dùng giao đúng việc đó.

## Cách làm việc

- Chạy kiểm thử: `npm test` (hoặc `node --test`). Phải đạt toàn bộ trước khi báo xong.
- Thử server: dùng `AGENT_BOARD_PORT=8091`. **Không** tắt hay chiếm cổng 8090 (bản người dùng đang dùng). Bản 8090 điều khiển bằng lệnh `agent-board start|stop|restart|status`.
- **Cổng hồi quy**: sửa phần quét, ghép, phân tích thì chụp và so `scripts/fingerprint.mjs` trước và sau với cùng mốc cắt; hash phải trùng. Không "cập nhật mốc" cho khớp. Chi tiết ở [docs/KIEM-THU.md](docs/KIEM-THU.md).
- Sửa lỗi thì thêm test hồi quy và kiểm bằng đột biến rằng test thật sự bắt lỗi cũ.
- Không tin số liệu do agent khác báo: tự đo lại (test, hash, API sống, hiệu năng). Đo hồ sơ CPU thay vì đoán khi chậm.
- Đổi giao diện thì xem trên trình duyệt thật (headless): tab phải ở tiền cảnh khi đo chuyển động. Test DOM mô phỏng không thay thế bước này.
- Suy luận từ dữ liệu không có lược đồ phải ghi rõ mức tin cậy và điều chưa kiểm chứng trong [docs/NGUON-DU-LIEU.md](docs/NGUON-DU-LIEU.md); đừng trình bày suy luận như sự thật.

## Bố cục

| Đường dẫn | Nội dung |
| --- | --- |
| `server.mjs`, `lib/` | máy chủ, quét, ghép, phân tích |
| `public/` | giao diện (thuần HTML, CSS, JS) |
| `bin/` | lệnh `agent-board` |
| `scripts/` | công cụ phát triển (fingerprint, perf, smoke, survey) |
| `test/` | test dùng dữ liệu tổng hợp |
| `docs/` | [KIEN-TRUC.md](docs/KIEN-TRUC.md), [NGUON-DU-LIEU.md](docs/NGUON-DU-LIEU.md), [GIAO-DIEN.md](docs/GIAO-DIEN.md), [KIEM-THU.md](docs/KIEM-THU.md), [XU-LY-SU-CO.md](docs/XU-LY-SU-CO.md) |
| `.cache/` | tệp tạm, nhật ký, báo cáo (không đưa vào git) |

## Khi hoàn tất một việc

Báo ngắn gọn bằng tiếng Việt: tệp đã sửa, kết quả test thật (số đạt/thất bại), số liệu thật, hash hồi quy (trùng hay không), điều **chưa kiểm chứng**, mọi chỗ đã đoán. Không dán nội dung hội thoại thật.

## Git

Commit tiếng Việt, nêu rõ thay đổi và lý do, đúng phạm vi. Không commit `.cache/`, dữ liệu hội thoại, đường dẫn cá nhân hay thông tin định danh. Không push, không tạo hay đổi quyền repo nếu người dùng chưa yêu cầu.
