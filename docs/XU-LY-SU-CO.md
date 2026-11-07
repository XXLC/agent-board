# Xử lý sự cố

## Server

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
| --- | --- | --- |
| `agent-board start` báo cổng bị chiếm | tiến trình khác giữ cổng 8090, hoặc có nhiều bản Agent Board chạy chồng | đặt `AGENT_BOARD_PORT` khác; hoặc dừng tay tiến trình `node.exe` có `server.mjs` trong dòng lệnh |
| Trang trống hoặc báo "đang kết nối lại" | server chưa quét xong lần đầu, hoặc đã tắt | `agent-board status`; xem `.cache\server.log` |
| Server tự chết | lỗi chưa bắt ở một nguồn dữ liệu | `server.mjs` đã bắt lỗi mức tiến trình và ghi ra nhật ký; xem `.cache\server.log` |
| Lượt quét đầu rất chậm | máy bận, hoặc một thay đổi làm tăng chi phí mỗi dòng | đo bằng `scripts/perf.mjs`, so hash bằng `scripts/fingerprint.mjs` (xem [KIEM-THU.md](KIEM-THU.md)) |
| `agent-board` không nhận ra | PATH mới chưa vào cửa sổ hiện tại | mở cửa sổ dòng lệnh mới; kiểm thư mục `bin` có trong PATH người dùng |

## Bẫy hệ thống trên Windows

- **Đừng tin `netstat` và `Get-NetTCPConnection` để kết luận một cổng loopback đã tắt**: trên máy phát triển `netstat` không in dòng `LISTENING` cho cổng 8090 và `Get-NetTCPConnection` không liệt kê hết. Lệnh `agent-board` kiểm cổng bận bằng cách thử bind thật (`EADDRINUSE`) và nhận diện tiến trình bằng dòng lệnh.
- Heredoc của một số shell nuốt dấu `\`: đường dẫn Windows trong test thành `D:Workspace...`. Dùng `/` trong test hoặc ghi tệp bằng công cụ soạn thảo.
- Trình duyệt headless mở tab ở nền nên animation tạm dừng; xem mục kiểm giao diện ở [KIEM-THU.md](KIEM-THU.md).

## Dữ liệu

- **Kết thúc ở tương lai, thanh dài bất thường**: mốc giờ agy lấy sai. Mốc chỉ được lấy ở trường đầu `steps.metadata` và bị chặn bởi mtime cộng 60 giây (xem [NGUON-DU-LIEU.md](NGUON-DU-LIEU.md)). Đừng quét byte sâu.
- **Lời nhắc Codex là `2` hoặc `*`**: toán tử chuyển hướng bị lấy làm lời nhắc. Bộ phân tích phải bỏ qua `2>&1`, `*>`, `>`, `|`.
- **Mọi dự án hiện là slug thô (`d--...`)**: gốc project không suy ra được vì cwd lang thang; phải chọn cwd có slug khớp đúng tên thư mục.
- **Làn Gemini Argon có model Flash, làn Antigravity Opus có Sonnet**: không phải lỗi; làn là vai trò, model ghi theo từng lần chạy.
- **Codex "Chưa rõ model" ở một số lần giao**: lệnh trong bản ghi Claude không ghi `-m` và không ghép được rollout; không đoán.
- **Hội thoại agy trạng thái "chưa rõ"**: mã trạng thái cuối của DB không phân biệt thành công và lỗi.
- **Server chạy tay không dừng được bằng `agent-board stop`**: lệnh tìm theo tệp PID rồi theo dòng lệnh; nếu có nhiều bản chạy chồng mà không phân biệt được thì từ chối dừng.

## Quota của các công cụ

Khi Codex hoặc agy báo `usage limit`, `RESOURCE_EXHAUSTED` hay 429, đó là hết quota chứ không phải lỗi của Agent Board; lần chạy hiển thị "hết quota" (sọc chéo). Quota được nhận diện bằng từ khóa trong kết quả nên có thể nhận nhầm khi nội dung chỉ đang bàn về quota.
