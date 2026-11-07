# Nguồn dữ liệu và quy tắc suy luận

Tài liệu này ghi từng nguồn, cách ghép các nguồn thành "lần giao việc" (run), và **mức tin cậy** của từng suy luận. Hầu hết cấu trúc dữ liệu ở đây không có lược đồ chính thức; chúng được suy ra từ khảo sát dữ liệu thật nên có thể đổi khi công cụ cập nhật. Số liệu minh họa đo ngày 07/11/2026.

## Khái niệm

Một **run** là một thanh trên dòng thời gian. Có ba loại nguồn:

- `claude-tool`: lệnh `codex exec` hoặc `agy --model ...` trong thông điệp assistant của Claude Code (lời giao việc), ghép với kết quả công cụ.
- `codex-rollout`: một tệp rollout Codex. `originator = codex_exec` là được giao việc; còn lại là phiên tương tác (hiển thị mờ, không tính vào số lần giao).
- `agy-db`: một hội thoại Antigravity.

Ngoài ra làn Claude gồm các **đoạn hoạt động** (không phải lần giao).

## Claude Code (`~/.claude/projects/*/*.jsonl`)

- Mỗi phiên được gộp thành các đoạn hoạt động, cắt khi im lặng quá 10 phút; có sự kiện trong 60 giây là đang chạy.
- Chỉ lệnh `Bash`/`PowerShell` trong thông điệp assistant được tính là lệnh giao việc. Bỏ bản sao ngữ cảnh (cùng bản ghi xuất hiện lại sau nén ngữ cảnh) và khử trùng theo mã công cụ.
- Model agy được phân làn theo họ: `claude-opus|sonnet|haiku-*` thành làn Opus; `gemini-*` với `argon|flash|pro` thành làn Argon. Lệnh kiểm tra "pong" vẫn được tính.
- Kết quả: ghép `tool_result` theo `tool_use_id`. Lệnh chạy nền chỉ trả "đang chạy nền" ngay; kết quả thật ghép bằng mã tác vụ hoặc mã công cụ trong thông báo hoàn tất. Thiếu thông báo thì dùng sự kiện cuối của phiên Claude, ghi rõ là **ước lượng** (`endEstimated: true`, `end` bị chặn tại bắt đầu cộng 60 phút, `endRaw` giữ mốc gốc).
- Quota được nhận diện bằng từ khóa trong kết quả (`quota`, `usage limit`, `rate limit`, `resource exhausted`, 429...), nên có thể nhận nhầm khi kết quả chỉ đang bàn về quota.

### Lời nhắc Codex trong lệnh

Lời nhắc thường đi qua stdin (đối số `-`), nên không nằm trong dòng lệnh. Bộ phân tích bỏ qua toán tử chuyển hướng và ống (`2>&1`, `*>`, `>`, `|`, `&&`...; lỗi cũ lấy `2>&1` thành lời nhắc `2`). Nguồn lời nhắc ghi ở `promptSource`: `lệnh`, `rollout`, `tệp` hoặc `không có`. Khi không còn nguồn nào, `prompt` là câu giải thích ("Lời nhắc truyền qua stdin từ tệp X"), không bao giờ là ký tự vô nghĩa.

## Codex (`~/.codex/sessions/**/rollout-*.jsonl`)

- Mỗi rollout là một run. `session_meta` cho `cwd`, `originator`; `turn_context` cho `model` và `effort`; `event_msg` cho `task_started`/`task_complete` hoặc tương đương.
- Lời nhắc là `response_item` vai `user` đầu tiên có `input_text` không phải khối ngữ cảnh/chỉ dẫn (bỏ phần bắt đầu bằng `<environment_context>`, `<user_instructions>`, `# AGENTS.md`...). Đây là nguồn tin cậy nhất và được ưu tiên.
- Các trường thời gian số trong khoảng 1 đến 10 tỷ được hiểu là giây Unix và đổi sang mili giây (một lỗi cũ hiểu nhầm đã gây 292 mốc kết thúc trước bắt đầu). Đây là quy ước suy ra từ dữ liệu.
- Phiên chưa có sự kiện hoàn tất và tệp sửa trong 90 giây là đang chạy.
- Ghép với lệnh Claude: cùng dự án (hoặc cùng phiên Claude), giờ bắt đầu lệch tối đa 120 giây, một đối một, cặp gần nhất trước. Giờ, model, effort ưu tiên rollout.
- `modelSource`: `rollout`, `lệnh` (`-m`) hoặc `chưa rõ`. Không đoán model; thẻ Codex có dòng "Cấu hình hiện tại" nhưng đó chỉ là mặc định lúc này.

## Antigravity / agy (`~/.gemini/antigravity-cli/conversations/*.db`)

Mỗi tệp `.db` là SQLite thường (không mã hóa) với blob protobuf không có lược đồ. Cách đọc và độ tin cậy:

- **Model**: biểu thức chặt trên chuỗi trong `gen_metadata.data` (ưu tiên hàng mới nhất có model hợp lệ), dự phòng từ `steps.metadata`. Bỏ placeholder và tên tệp có chữ `claude-` như `claude-bridge-setup.md`.
- **Mốc giờ**: chỉ lấy ở **trường đầu** của `steps.metadata` (tag `0x0a`, trong đó tag `0x08` là giây, có thể kèm tag `0x10` nano giây). Chỉ nhận epoch 1,7 đến 1,9 tỷ giây, không vượt `max(mtime .db, mtime .db-wal) + 60 giây`, rồi loại mốc cách trung vị hơn 3 ngày, mới lấy nhỏ nhất và lớn nhất. Còn mốc nào thì mới có run; không mượn mtime hay đoán. Quét byte sâu từng được thử và bỏ vì nhặt nhầm số ngẫu nhiên (kết thúc ở năm 2027). Độ tin cậy trung bình: khớp toàn bộ mẫu khảo sát, độ phân giải một giây, kết thúc là mốc bước cuối chứ chưa chứng minh là lúc tiến trình thoát. Lọc trung vị có thể bỏ lần tiếp tục thật cách xa hơn 3 ngày (đánh đổi bảo thủ).
- **Lời nhắc**: bước loại 14 đầu tiên, lần theo trường protobuf có độ dài hợp lệ và UTF-8 hợp lệ, ưu tiên chuỗi dài nhất có chữ và khoảng trắng; để trống nếu có nhiều ứng viên gần bằng nhau. Loại 14 là giả thiết. Trong 150 cặp có lời nhắc ở cả hai nguồn, 90 cặp khớp hoàn toàn sau che và cắt.
- **Thư mục làm việc**: cột `trajectory_metadata_blob.data` chứa đường dẫn thư mục làm việc (có thể kèm byte thẻ protobuf ở cuối); chọn theo tần suất, độ dài và thứ tự. Dùng để xác định dự án.
- **Trạng thái**: mã bước cuối 3 xuất hiện với cả thành công, lỗi và hết quota (đối chiếu 212 cặp: 149 thành công, 4 lỗi, 15 quota, 41 chưa rõ), nên **không thể** coi 3 là thành công. Mọi kết quả từ DB giữ `unknown`. Mã 3 chỉ là dấu hiệu bước đã kết thúc; mã khác và `.db`/`.db-wal` mới hơn 90 giây là tín hiệu đang chạy có tính suy đoán.
- Ghép với lệnh Claude: cùng làn, model giống hoàn toàn, giờ bắt đầu lệch tối đa 120 giây, cặp gần nhất trước, một đối một. Thanh ghép dùng giờ, model, trạng thái từ DB và giữ lời nhắc, dự án, loại việc từ lệnh. Thanh độc lập ghi "Hội thoại agy, không rõ nguồn giao".

Chỉ chọn các cột `trajectory_meta.trajectory_id`, `gen_metadata.data`, `steps.idx/step_type/status/metadata/step_payload` và `trajectory_metadata_blob.data`. Cache trong bộ nhớ chỉ giữ đường dẫn, kích thước, mtime, cờ lỗi và các trường rút gọn (mã phiên, model, mốc giờ, mã trạng thái, thư mục làm việc, lời nhắc đã che tối đa 200 ký tự).

## Dự án

"Dự án" là **thư mục project của Claude Code** (`~/.claude/projects/<slug>`), không phải `cwd` của từng lệnh. Tên slug là cwd lúc khởi chạy với mọi ký tự không phải chữ hoặc số đổi thành `-`. Vì thế gốc project suy ra bằng cách chọn cwd đã quan sát có slug khớp đúng tên thư mục; không có thì dùng cwd là tiền tố của mọi cwd còn lại. (Cách "tiền tố chung" một mình thất bại ở các project lớn vì cwd trong bản ghi lang thang.)

- Lệnh giao và đoạn hoạt động Claude thuộc slug chứa tệp phiên. Lệnh đã ghép rollout hoặc agy giữ project của Claude.
- Rollout Codex độc lập: nếu cwd là scratchpad `...\Temp\claude\<hash>\<mã phiên>\scratchpad` thì lấy project của phiên Claude có mã đó; ngược lại khớp tiền tố dài nhất với gốc project đã biết.
- Hội thoại agy độc lập: dùng thư mục làm việc trong metadata, khớp tương tự.
- Thư mục thật không thuộc project Claude nào thành dự án riêng, nhãn kèm "(ngoài Claude)" (`outsideClaude`).
- Còn lại là "Không rõ dự án", luôn kèm `unknownReason` (ví dụ "agy: hội thoại không có thư mục làm việc đọc được", "Codex: chạy ở thư mục tạm không rõ phiên Claude", "cwd không khớp thư mục nào").
- Nhãn lấy tên thư mục cuối; trùng thì thêm tên thư mục cha, vẫn trùng thì thêm slug.

Mỗi run và mỗi làn có `projectKey`, `projectLabel`, `projectPath`. Khi agy ghép với lệnh Claude, thư mục làm việc của agy khớp dự án của lệnh ở 161 trên 214 cặp, 17 là thư mục tạm mang slug đúng dự án, 34 làm việc ở thư mục của dự án khác, 2 không đối chiếu được.

**34 trường hợp làm việc ở dự án khác là giao việc chéo dự án, không phải ghép nhầm** (người dùng xác nhận ngày 08/11/2026: một phiên Claude ở dự án này giao agy làm việc ở thư mục của dự án khác). Vì vậy `projectKey` của một lần giao luôn là dự án của **phiên Claude giao việc**, còn thư mục làm việc của agy (`workspace`) cho biết việc thực sự diễn ra ở đâu; hai giá trị khác nhau là bình thường, đừng "sửa" cho khớp và đừng coi sự khác biệt là dấu hiệu ghép sai. Điều này cũng có nghĩa không thể dùng độ khớp giữa hai thư mục để kiểm tra chất lượng ghép lệnh với hội thoại; kiểm chất lượng ghép bằng model, giờ bắt đầu và lời nhắc (90 trên 150 cặp có lời nhắc ở cả hai nguồn khớp hoàn toàn sau che và cắt).

## Giao chéo dự án

Giao chéo dự án là khi phiên Claude ở dự án A giao agy hoặc Codex làm việc ở thư mục của dự án B. Giao diện thể hiện rõ điều này (xem [GIAO-DIEN.md](GIAO-DIEN.md)).

- **Thư mục thực thi** của một run: `workspace` của hội thoại agy; `cwd` của rollout Codex; với lệnh `claude-tool` chưa ghép thì thư mục đích do bộ phân tích lệnh trích ra (ví dụ `-C <thư mục>`), chỉ khi nó khác cwd của phiên Claude.
- Thư mục thực thi được giải thành dự án bằng đúng hàm xác định dự án ở trên (không có logic suy dự án song song).
- `crossProject` là true khi **cả hai** dự án (của lần giao và của thư mục thực thi) đều đã biết và khác nhau. Không tính là chéo: thư mục tạm hoặc scratchpad của phiên, `~/.claude`, dự án không rõ, phiên tương tác Codex và đoạn hoạt động Claude. Run mà dự án được suy ra từ chính thư mục thực thi (agy hoặc Codex độc lập) thì hai khóa trùng nên không chéo.
- Chỉ khi `crossProject` là true run mới có `workProjectKey`, `workProjectLabel`, `workProjectPath`, `workProjectOutsideClaude`. Các trường này được tính ở lớp xuất (`runs()`, `state()`), không nằm trong dữ liệu quét nên không đổi hash kiểm hồi quy. `scan.statistics.crossProjects` có `{count, total}` với `total` là số lần giao đủ thông tin để xét.
- Số liệu mẫu ngày 08/11/2026: 112 trên 663 lần giao đủ thông tin là chéo (Codex 77, Gemini Argon 29, Antigravity Opus 6; theo nguồn: rollout Codex 67, hội thoại agy 35, lệnh có `-C` 10). Trong đó 34 hội thoại agy đã ghép với lệnh Claude khớp đúng 34 trường hợp được người dùng xác nhận là giao chéo.

## Model và làn

Làn là vai trò, model là sự thật. Làn "Gemini Argon" có cả `gemini-*-flash*`, làn "Antigravity Opus" có cả `claude-sonnet-*`. `modelLabel(id)` đổi id thô thành tên đọc được ("Opus 5.5 · high", "Gemini Argon · high", "Gemini 3.5 Flash Lite"); id Codex (`gpt-*`) giữ nguyên, id lạ giữ nguyên, rỗng là "Chưa rõ model". Hậu tố `-low|-medium|-high` là mức suy luận. Model lệch tên làn được đánh dấu `offLabel`.

## Giới hạn

- Lệnh xây động bằng biến, script ngoài hoặc shell phức tạp có thể không phân tích được; model ngoài các họ đã hỗ trợ bị bỏ qua.
- Không biết kết quả của các lần chỉ có tiến trình hoặc chỉ có mã trạng thái DB.
- Nhiều phiên tương tác Codex trong một rollout vẫn là một thanh.
- Che mẫu nhạy cảm là biện pháp đơn giản, không phải bộ phân loại bí mật hoàn chỉnh.
