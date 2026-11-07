# Ghi chú riêng cho Gemini / Antigravity

Antigravity nạp cộng dồn `AGENTS.md` và `GEMINI.md`, nên quy tắc chung nằm ở [AGENTS.md](AGENTS.md); tệp này chỉ chứa phần riêng cho phiên chạy qua `agy`.

- Việc chỉ đọc (rà soát, tra cứu): không sửa, không tạo, không xóa tệp nào, kể cả tệp tạm trong repo. Trả kết quả bằng văn bản trong câu trả lời.
- Lời nhắc dài truyền qua tệp ("Đọc tệp ... và làm theo"); luôn nêu rõ thư mục làm việc, tệp được sửa và việc cấm.
- Chạy `agy` bằng công cụ chạy nền của harness, không dùng `Start-Process -WindowStyle Hidden` (treo, không có đầu ra). `--print-timeout` cần đơn vị, ví dụ `900s`.
- Báo ngay và dừng nếu gặp quota (`RESOURCE_EXHAUSTED`, 429), kèm phần đã xong và chưa xong.
