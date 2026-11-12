# Agent Board

Bảng theo dõi cục bộ cho các phiên AI lập trình đang chạy trên máy: **Claude Code**, **Codex**, **Antigravity Claude** (Claude chạy qua agy), **Gemini** (Gemini chạy qua agy) và **DeepSeek** (Codewhale CLI). Trả lời ba câu hỏi: ai đang làm việc gì ngay lúc này, Claude đã giao việc cho ai và kết quả ra sao, và lịch sử các lần giao việc theo thời gian và theo dự án.

Trang web chạy ở `http://127.0.0.1:8090`, chỉ đọc dữ liệu có sẵn trên máy, không gọi dịch vụ ngoài, không cài gói (Node 24 trở lên, dùng `node:sqlite` có sẵn).

## Có gì trên trang

- **Thẻ trạng thái và bộ đếm** cho từng làn: đang chạy hay rảnh, model và mức suy luận, việc đang làm, dự án, thời lượng và tổng token 24 giờ (kèm dải chip 24 giờ và dải chip theo khoảng/bộ lọc đang chọn). Thẻ Codex có thêm dòng "Cấu hình hiện tại".
- **Dòng thời gian**: mỗi làn một hàng, mỗi lần giao việc là một thanh (thành công, lỗi, hết quota, đang chạy, chưa rõ phân biệt bằng hoa văn chứ không chỉ bằng màu). Khoảng 6 giờ, 24 giờ, 7 ngày, 30 ngày; lọc theo làn, model, dự án, giao chéo.
- **Sơ đồ** kiểu mindmap tỏa tròn: Claude ở giữa, bốn nhánh Codex, Antigravity Claude, Gemini, DeepSeek, rồi dự án, rồi từng lần giao; kích thước bóng theo thứ bậc `gốc > làn > dự án > lá` kèm bộ đếm thời gian/token và cỡ chữ bù theo mức thu phóng. Có nút "Căn giữa" (vừa phần lõi), "Xem tất cả" (vừa cả lá), và chế độ **Toàn màn hình chỉ sơ đồ** (`F11`, thoát bằng `Esc`, giữ màn hình sáng bằng Screen Wake Lock).
- **Giao chéo dự án**: khi Claude ở dự án A giao việc cho model làm việc ở dự án B, thẻ ghi "A → B", thanh và lá có mũi tên nhỏ, sơ đồ hiện đường cong nét đứt nối sang dự án đích (tự hiện khi đang chạy hoặc khi bấm vào lá), panel chi tiết nêu rõ cả hai dự án, và có bộ lọc riêng.
- Cập nhật trực tiếp qua SSE, giao diện sáng/tối, hỗ trợ giảm chuyển động và bàn phím, dùng được trên màn hình hẹp.

Chi tiết từng phần ở [docs/GIAO-DIEN.md](docs/GIAO-DIEN.md).

## Chạy

Cần Windows (quét tiến trình bằng PowerShell), Node 24+, và ít nhất một trong các nguồn: Claude Code, Codex CLI, Antigravity CLI (`agy`).

```powershell
node --version                # 24 trở lên
node server.mjs               # chạy ở foreground, Ctrl+C để dừng
```

Lệnh `agent-board` chạy nền (thêm thư mục `bin` vào PATH người dùng một lần, rồi mở cửa sổ dòng lệnh mới):

```powershell
agent-board start      # chạy nền, nhật ký ở .cache\server.log
agent-board stop       # dừng
agent-board restart
agent-board status     # mã thoát 0 = đang chạy, 3 = không chạy
```

Đổi cổng bằng biến môi trường `AGENT_BOARD_PORT` (mặc định 8090). Lượt quét đầu mất vài giây (khoảng 480 MB bản ghi); trang hiện tiến độ trong lúc quét.

## Dữ liệu và quyền riêng tư

Chỉ đọc, từ thư mục home của người dùng đang chạy:

| Nguồn | Vị trí | Dùng để |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | đoạn hoạt động của Claude, token từng thông điệp, lệnh giao việc `codex exec` / `agy --model` và kết quả |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`, hai khóa trong `~/.codex/config.toml` | giờ, model, effort, lời nhắc, token tích lũy, kết quả của từng lần Codex chạy |
| Antigravity (`agy`) | `~/.gemini/antigravity-cli/conversations/*.db` | model, mốc giờ, thư mục làm việc, token (`gen_metadata`) của từng hội thoại |
| Tiến trình | PowerShell `Get-CimInstance Win32_Process` mỗi 3 giây | tín hiệu "đang chạy" trực tiếp |

Nguyên tắc an toàn (chi tiết ở [docs/KIEN-TRUC.md](docs/KIEN-TRUC.md)): chỉ lắng nghe `127.0.0.1` và từ chối `Host` lạ; lời nhắc được che mẫu bí mật và cắt ngắn, không ghi nội dung hội thoại ra đĩa; dữ liệu từ nguồn đưa vào DOM bằng `textContent`; đường dẫn lấy từ dữ liệu không tin cậy chỉ được đọc trong danh sách cho phép; không giải mã bằng khóa, không đọc keyring, không gọi daemon của agy.

## Giới hạn cần biết

- Nhiều kết luận là **suy luận** từ cấu trúc dữ liệu không có lược đồ chính thức (hội thoại và số token agy, giờ kết thúc của lệnh chạy nền, ghép lệnh Claude với rollout Codex). Mức tin cậy từng suy luận ghi ở [docs/NGUON-DU-LIEU.md](docs/NGUON-DU-LIEU.md).
- Mã trạng thái cuối của hội thoại agy không phân biệt thành công với lỗi, nên các lần agy giữ trạng thái "chưa rõ".
- Làn gắn với hãng, không gắn với một model: làn Gemini chạy mọi model Gemini (Flash là mặc định theo chính sách chọn model, Argon, Carbon, Pro) và làn Antigravity Claude chạy mọi model Claude (Sonnet là mặc định, Opus, Haiku); mỗi lần chạy luôn ghi đúng model của nó, và chỉ model của hãng khác làn mới bị ghi "model khác tên làn".
- Làn DeepSeek: lần giao nhận diện từ lệnh `codewhale exec` (cả `codewhale.cmd`, alias `codew`) trong bản ghi Claude Code; lần làm đọc từ phiên Codewhale ở `~/.codewhale/sessions`. Tệp phiên chỉ có thời điểm tạo (bằng thời điểm cập nhật) nên thời lượng của lần đọc từ tệp phiên là 0, trạng thái cuối là `unknown`, và token lấy từ `metadata.total_tokens` làm số liệu "chỉ tổng" (hiện "Tổng: N token, số liệu gộp, chưa tách vào/ra"; nhiều khả năng là cộng dồn qua các lượt gọi nhưng chưa đối chiếu với hóa đơn DeepSeek). Lần giao qua wrapper `node deepseek-exec.mjs` (dự án từ `--cwd`) cũng được nhận diện; với tác vụ nền, phiên được ghép vào lần giao khi nằm trong khoảng chạy dù thông báo hoàn tất đến muộn. Lần chạy `exec` không công cụ (câu trả lời thuần) không được Codewhale lưu phiên, nên chỉ thấy qua lệnh Claude.
- Chỉ Windows; một số mốc thời gian hiển thị theo giờ Việt Nam (UTC+7).

## Phát triển

```powershell
npm test                                  # hoặc: node --test
node scripts/fingerprint.mjs <ra.json> <mốc_cắt_epoch_ms>   # cổng kiểm hồi quy
```

Bộ kiểm thử dùng dữ liệu tổng hợp, không đụng bản ghi thật. Trước khi sửa phần quét hoặc ghép dữ liệu, chụp "dấu vân tay" kết quả rồi so lại sau khi sửa; xem [docs/KIEM-THU.md](docs/KIEM-THU.md). Quy tắc cho người và agent làm việc trong repo này ở [AGENTS.md](AGENTS.md). Sự cố thường gặp ở [docs/XU-LY-SU-CO.md](docs/XU-LY-SU-CO.md).

## Tài liệu

- [docs/KIEN-TRUC.md](docs/KIEN-TRUC.md): luồng dữ liệu, tiến trình và luồng phụ, API, bảo mật, hiệu năng.
- [docs/NGUON-DU-LIEU.md](docs/NGUON-DU-LIEU.md): từng nguồn, quy tắc ghép, dự án, lời nhắc, model, độ tin cậy.
- [docs/GIAO-DIEN.md](docs/GIAO-DIEN.md): thẻ, dòng thời gian, sơ đồ, trạng thái giao/làm, trợ năng.
- [docs/KIEM-THU.md](docs/KIEM-THU.md): bộ test, cổng hồi quy bằng hash, đo hiệu năng, kiểm giao diện bằng trình duyệt.
- [docs/XU-LY-SU-CO.md](docs/XU-LY-SU-CO.md): các bẫy đã gặp và cách xử lý.
