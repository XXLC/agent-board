# Xử lý sự cố

## Server

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
| --- | --- | --- |
| `agent-board start` báo cổng bị chiếm | tiến trình khác giữ cổng 8090, hoặc có nhiều bản Agent Board chạy chồng | đặt `AGENT_BOARD_PORT` khác; hoặc dừng tay tiến trình `node.exe` có `server.mjs` trong dòng lệnh |
| Trang trống hoặc báo "đang kết nối lại" | server chưa quét xong lần đầu, hoặc đã tắt | `agent-board status`; xem `.cache\server.log` |
| Server tự chết | lỗi chưa bắt ở một nguồn dữ liệu | `server.mjs` đã bắt lỗi mức tiến trình và ghi ra nhật ký; xem `.cache\server.log` |
| Lượt quét đầu rất chậm | máy bận, hoặc một thay đổi làm tăng chi phí mỗi dòng | đo bằng `scripts/perf.mjs`, so hash bằng `scripts/fingerprint.mjs` (xem [KIEM-THU.md](KIEM-THU.md)) |
| `agent-board` không nhận ra | PATH mới chưa vào cửa sổ hiện tại | mở cửa sổ dòng lệnh mới; kiểm thư mục `bin` có trong PATH người dùng |

## Bẫy hệ thống và trình duyệt trên Windows

- **Cổng 8090 so với cổng thử nghiệm 8091/8092**: cổng `8090` dành cho bản `agent-board` chạy nền phục vụ người dùng. Khi phát triển, chạy `scripts/perf.mjs`, `scripts/smoke.mjs` hoặc khởi động server thử nghiệm bằng tay, luôn đặt `AGENT_BOARD_PORT=8091` (hoặc `8092`) để không tắt, chiếm cổng hay làm gián đoạn bản `8090`.
- **Đừng tin `netstat` và `Get-NetTCPConnection` để kết luận một cổng loopback đã tắt**: trên máy phát triển `netstat` không in dòng `LISTENING` cho cổng 8090 và `Get-NetTCPConnection` không liệt kê hết. Lệnh `agent-board` kiểm cổng bận bằng cách thử bind thật (`EADDRINUSE`) và nhận diện tiến trình bằng dòng lệnh.
- **Screen Wake Lock cần tab đang hiển thị**: trình duyệt chỉ cấp khóa giữ màn hình sáng khi đang ở chế độ chỉ sơ đồ (`F11`) và tab đang hiển thị (`!document.hidden`). Khi chuyển sang tab khác hoặc thu nhỏ cửa sổ, khóa tự nhả (trạng thái `"đang chờ (tab ẩn)"`) và tự xin lại khi tab hiện lại. Nếu bị chính sách từ chối quá 3 lần thì dừng ở `"bị chặn"` (thoát rồi vào lại `F11` để thử lại). Wake Lock không chặn khóa máy bằng tay hay đóng nắp máy; việc chính sách nhàn rỗi hệ điều hành có thể thắng Wake Lock là điều chưa kiểm chứng.
- **Edge/Chrome headless ở nền tạm dừng animation và nhịp đếm**: tab mở ở nền có `document.hidden = true`, khiến trang đặt `data-motion-paused="true"` (tạm dừng mọi CSS animation), dừng bộ đếm nhịp sống 1 giây (`tickCounters`) và không xin được Wake Lock. Khi kiểm giao diện tự động phải gọi `Page.bringToFront` kèm `Emulation.setFocusEmulationEnabled` (xem [KIEM-THU.md](KIEM-THU.md)).
- Heredoc của một số shell nuốt dấu `\`: đường dẫn Windows trong test thành `D:Workspace...`. Dùng `/` trong test hoặc ghi tệp bằng công cụ soạn thảo.

## Dữ liệu

- **"Chưa đọc được token" nghĩa là gì**: khác với `"0 token"` (nguồn có số liệu hợp lệ và tổng bằng 0). `"Chưa đọc được token"` hiện khi không có lần chạy nào trong phạm vi có số liệu token (`runsWithTokens = 0`, hoặc `run.tokens = null`). Ở hai làn `Opus`/`Argon` (`agy`), lý do thường là hội thoại chưa có lần gọi model nào hoàn tất để ghi khối `usage` vào `gen_metadata`; ở `Claude`/`Codex`, lý do thường là lệnh giao việc `claude-tool` chưa ghép được với rollout/DB, tệp rollout chưa ghi sự kiện `token_count` / `token_usage_record`, hoặc lần chạy chỉ phát hiện qua tiến trình.
- **Kết thúc ở tương lai, thanh dài bất thường**: mốc giờ agy lấy sai. Mốc chỉ được lấy ở trường đầu `steps.metadata` và bị chặn bởi mtime cộng 60 giây (xem [NGUON-DU-LIEU.md](NGUON-DU-LIEU.md)). Đừng quét byte sâu.
- **Lời nhắc Codex là `2` hoặc `*`**: toán tử chuyển hướng bị lấy làm lời nhắc. Bộ phân tích phải bỏ qua `2>&1`, `*>`, `>`, `|`.
- **Mọi dự án hiện là slug thô (`d--...`)**: gốc project không suy ra được vì cwd lang thang; phải chọn cwd có slug khớp đúng tên thư mục.
- **Làn Gemini Argon có model Flash, làn Antigravity Opus có Sonnet**: không phải lỗi; làn là vai trò, model ghi theo từng lần chạy.
- **Codex "Chưa rõ model" ở một số lần giao**: lệnh trong bản ghi Claude không ghi `-m` và không ghép được rollout; không đoán.
- **Hội thoại agy trạng thái "chưa rõ"**: mã trạng thái cuối của DB không phân biệt thành công và lỗi.
- **Server chạy tay không dừng được bằng `agent-board stop`**: lệnh tìm theo tệp PID rồi theo dòng lệnh; nếu có nhiều bản chạy chồng mà không phân biệt được thì từ chối dừng.

## Quota của các công cụ

Khi Codex hoặc agy báo `usage limit`, `RESOURCE_EXHAUSTED` hay 429, đó là hết quota chứ không phải lỗi của Agent Board; lần chạy hiển thị "hết quota" (sọc chéo). Quota được nhận diện bằng từ khóa trong kết quả nên có thể nhận nhầm khi nội dung chỉ đang bàn về quota.
