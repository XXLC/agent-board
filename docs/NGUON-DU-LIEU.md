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

## DeepSeek / Codewhale (`~/.codewhale/sessions/*.json`)

- Giao: lệnh `codewhale exec ...` (cũng `codewhale.cmd`, đường dẫn đầy đủ, alias `codew`) trong bản ghi Claude Code, và wrapper `node deepseek-exec.mjs --cwd <thư mục> [--model M] --prompt|--prompt-file ...` (dự án từ `--cwd`; chỉ nhận khi `node` đứng ở đầu lệnh); bỏ qua `--help`, `--version`, lệnh con khác và chuỗi trích dẫn. Model lấy từ `--model`/`-m` hoặc `--set model=...`; không có thì `chưa rõ`, không đoán. Thư mục làm việc đến từ cờ toàn cục `-C`/`--workspace` đặt trước `exec` (đã thử thật) hoặc từ lệnh `cd` trước đó.
- Làm: mỗi tệp phiên là một run (`metadata.id`, `model`, `workspace`, `created_at`, `title`, `mode`). Chỉ các lần `--auto` (có công cụ) hoặc tiếp tục phiên được lưu; `exec` thuần câu trả lời không lưu phiên.
- Hạn chế đã đo ngày 12/11/2026: `created_at` bằng `updated_at` nên thời lượng là 0 (nếu `metadata.cumulative_turn_secs` > 0 thì mã dùng nó làm thời lượng và lùi mốc bắt đầu; chưa quan sát giá trị khác 0 nên ý nghĩa chưa được xác minh); chưa có trạng thái cuối (`unknown`); `metadata.total_tokens` được giữ làm số liệu chỉ-tổng (`totalOnly`, thành phần vào/ra để 0 và giao diện chỉ hiện "Tổng"): phiên 2 tin nhắn ≈ 6 nghìn, phiên 41 tin nhắn ≈ 1,2 triệu nên nhiều khả năng cộng dồn qua các lượt gọi, nhưng chưa đối chiếu với hóa đơn nên coi là gần đúng. Token trong trường `usage` của đầu ra lệnh (nếu có) được đọc theo trường kiểu DeepSeek API (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `output_tokens`, `reasoning_tokens`): chưa quan sát thật.
- Ghép phiên với lần giao: cùng dự án (từ `-C`/`--cwd`/`cd` hoặc thư mục làm việc của phiên) và cùng model, cửa sổ 120 giây quanh thời điểm lưu; riêng lần giao chạy nền (giờ kết thúc chỉ là lúc nhận thông báo, có thể muộn) chấp nhận phiên nằm trong khoảng chạy, xếp sau mọi ứng viên khớp trong cửa sổ. Phiên không ghép được (ví dụ do Argon hay Codex chạy, thư mục tạm) giữ nguyên "Không rõ dự án" hoặc dự án ngoài Claude theo thư mục làm việc.
- Tệp phiên chứa chuỗi giống khóa (diff, tệp đã đọc, khóa giả trong test) KHÔNG bị bỏ: bảng chỉ lấy siêu dữ liệu và lời nhắc đã qua `redact()`.
- Trạng thái hết số dư: `HTTP 402`/`status code: 402`/`insufficient balance` và `429` được tính là `quota`; số 402 trần trong đầu ra không tính (đã gây phân loại nhầm ba lần chạy Codex khi thử).

## Antigravity / agy (`~/.gemini/antigravity-cli/conversations/*.db`)

Mỗi tệp `.db` là SQLite thường (không mã hóa) với blob protobuf không có lược đồ. Cách đọc và độ tin cậy:

- **Model**: biểu thức chặt trên chuỗi trong `gen_metadata.data` (ưu tiên hàng mới nhất có model hợp lệ), dự phòng từ `steps.metadata`. Bỏ placeholder và tên tệp có chữ `claude-` như `claude-bridge-setup.md`.
- **Mốc giờ**: chỉ lấy ở **trường đầu** của `steps.metadata` (tag `0x0a`, trong đó tag `0x08` là giây, có thể kèm tag `0x10` nano giây). Chỉ nhận epoch 1,7 đến 1,9 tỷ giây, không vượt `max(mtime .db, mtime .db-wal) + 60 giây`, rồi loại mốc cách trung vị hơn 3 ngày, mới lấy nhỏ nhất và lớn nhất. Còn mốc nào thì mới có run; không mượn mtime hay đoán. Quét byte sâu từng được thử và bỏ vì nhặt nhầm số ngẫu nhiên (kết thúc ở năm 2027). Độ tin cậy trung bình: khớp toàn bộ mẫu khảo sát, độ phân giải một giây, kết thúc là mốc bước cuối chứ chưa chứng minh là lúc tiến trình thoát. Lọc trung vị có thể bỏ lần tiếp tục thật cách xa hơn 3 ngày (đánh đổi bảo thủ).
- **Lời nhắc**: bước loại 14 đầu tiên, lần theo trường protobuf có độ dài hợp lệ và UTF-8 hợp lệ, ưu tiên chuỗi dài nhất có chữ và khoảng trắng; để trống nếu có nhiều ứng viên gần bằng nhau. Loại 14 là giả thiết. Trong 150 cặp có lời nhắc ở cả hai nguồn, 90 cặp khớp hoàn toàn sau che và cắt.
- **Thư mục làm việc**: cột `trajectory_metadata_blob.data` chứa đường dẫn thư mục làm việc (có thể kèm byte thẻ protobuf ở cuối); chọn theo tần suất, độ dài và thứ tự. Dùng để xác định dự án.
- **Trạng thái**: mã bước cuối 3 xuất hiện với cả thành công, lỗi và hết quota (đối chiếu 212 cặp: 149 thành công, 4 lỗi, 15 quota, 41 chưa rõ), nên **không thể** coi 3 là thành công. Mọi kết quả từ DB giữ `unknown`. Mã 3 chỉ là dấu hiệu bước đã kết thúc; mã khác và `.db`/`.db-wal` mới hơn 90 giây là tín hiệu đang chạy có tính suy đoán.
- Ghép với lệnh Claude: cùng làn, model giống hoàn toàn, giờ bắt đầu lệch tối đa 120 giây, cặp gần nhất trước, một đối một. Thanh ghép dùng giờ, model, trạng thái từ DB và giữ lời nhắc, dự án, loại việc từ lệnh. Thanh độc lập ghi "Hội thoại agy, không rõ nguồn giao".

Chỉ chọn các cột `trajectory_meta.trajectory_id`, `gen_metadata.data`, `steps.idx/step_type/status/metadata/step_payload` và `trajectory_metadata_blob.data`. Cache trong bộ nhớ chỉ giữ đường dẫn, kích thước, mtime, cờ lỗi và các trường rút gọn (mã phiên, model, mốc giờ, mã trạng thái, thư mục làm việc, số token, lời nhắc đã che tối đa 200 ký tự).

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
- Số liệu mẫu ngày 08/11/2026: 112 trên 663 lần giao đủ thông tin là chéo (Codex 77, làn Gemini 29, làn Antigravity Claude 6 (tên cũ lúc đó: Gemini Argon, Antigravity Opus); theo nguồn: rollout Codex 67, hội thoại agy 35, lệnh có `-C` 10). Trong đó 34 hội thoại agy đã ghép với lệnh Claude khớp đúng 34 trường hợp được người dùng xác nhận là giao chéo.

## Bộ đếm thời gian và token

Mỗi run trong `/api/runs` có `tokens` (`{ input, cacheRead, cacheWrite, output, reasoning, total }` với `total = input + cacheRead + cacheWrite + output`; `reasoning` nằm trong `output` nên không cộng lần hai) và `tokenSource` (`'claude' | 'codex' | 'agy' | null`). Khi nguồn chưa có số liệu hợp lệ thì `tokens: null`, `tokenSource: null` (khác với đối tượng có `total: 0`).

- **Claude Code (`tokenSource: 'claude'`)**: lấy `message.usage` từ bản ghi `assistant` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`; `reasoning = 0`). Khử trùng theo `message.id` (khóa `m:<message.id>`, dự phòng `u:<uuid>` khi thiếu `message.id`), lấy giá trị lớn nhất (`max`) từng trường giữa các bản ghi cùng khóa, kể cả khi đọc nối thêm hoặc hợp hai đoạn hoạt động (`mergeActivityUsage`). Token chỉ tính trên đoạn hoạt động (`claude-session`), không gán vào lệnh giao việc `claude-tool`.
- **Codex (`tokenSource: 'codex'`)**: đọc `event_msg` loại `token_count` (`payload.info.total_token_usage`) hoặc `token_usage_record` (`payload.thread_token_usage`), lấy bản ghi hợp lệ **cuối cùng** trong rollout (không cộng dồn các sự kiện, không suy từ `turn_token_usage` hay `total_tokens` rời). Chuẩn hóa: `cacheRead = cached_input_tokens`, `input = max(0, input_tokens - cached_input_tokens)`, `cacheWrite = 0`, `output = output_tokens`, `reasoning = reasoning_output_tokens`, `total = input + cacheRead + output`. Khi ghép với lệnh Claude, run ghép nhận `tokens` và `tokenSource: 'codex'` từ rollout.
- **Antigravity / agy (`tokenSource: 'agy'`)**:
  - Giải mã protobuf trong `gen_metadata.data` (chỉ đọc DB với `readOnly: true`) theo cấu trúc tham khảo từ nguồn mở MIT `agentsview` nhưng tự cài đặt lại trong `lib/agy.mjs` (`extractGenerationTokens`, `readUsage`).
  - Đường chuẩn: trường 1 (`chat_model`, wire 2) → trường 4 (`usage`, wire 2); dự phòng duyệt đệ quy các trường wire 2 (độ sâu tối đa `MAX_DEPTH = 6`, tối đa `MAX_FIELDS = 4000` trường).
  - Trong message `usage`, các trường 1..5 phải có kiểu varint (`wire = 0`): trường 1 là mã `model` bắt buộc thuộc `[1000, 5000)`; trường 2 là `input` (chưa cache, bắt buộc); trường 3 là `output` (gồm cả thinking, bắt buộc); trường 4 (`cacheWrite` trong cấu trúc protobuf) được kiểm tra kiểu và trần nhưng không lưu vào kết quả (`cacheWrite = 0`); trường 5 là `cacheRead` (tùy chọn, mặc định `0`). Mọi trường 2..5 và cả tổng `input + output` đều có trần `2.000.000` (`TOKEN_LIMIT`, giúp loại bỏ khối giả kiểu nano giây).
  - Cộng dồn qua các hàng `gen_metadata` hợp lệ trong hội thoại (`addAgyUsage`, giữ `cacheWrite = 0`, `reasoning = 0`, `total = input + cacheRead + output`); khi ghép với lệnh Claude (`mergeAgy`), run ghép nhận `tokens` và `tokenSource: 'agy'` từ DB.
  - **Kiểm độc lập và độ tin cậy**: đối chiếu bằng bộ giải mã Python riêng trên dữ liệu thật cho **381/381** hội thoại khớp API, **99,2%** hàng `gen_metadata` giải mã được, **98,82%** cặp thế hệ kề nhau có ngữ cảnh (`input + cacheRead`) không giảm. Tuy nhiên vẫn **chưa có sự thật gốc** chính thức từ agy.

Trên từng làn của `/api/state` (`laneTokenMetrics` trong `lib/tokens.mjs`):

- `tokens24h`: `{ input, cacheRead, cacheWrite, output, reasoning, total, runsWithTokens, runsTotal }` tính cho các run của làn bắt đầu trong 24 giờ qua (`now - 86_400_000 <= start <= now`), với `runsWithTokens` là số run có `tokens !== null`.
- `busyMs24h`: tổng thời gian bận (ms) trong cửa sổ 24 giờ qua sau khi hợp các khoảng chồng nhau hoặc liền kề và cắt tại `[now - 86_400_000, now]`.
- `tokensRunning`: tổng `tokens.total` của mọi run đang chạy (`running: true`) trên làn đó, không phụ thuộc giờ bắt đầu.

## Model và làn

Làn gắn với hãng, model là sự thật. Làn "Gemini" có `gemini-*-flash*`, `argon`, `carbon`, `pro`; làn "Antigravity Claude" có `claude-opus-*`, `sonnet`, `haiku` (chính sách chọn model từ 12/11/2026: Gemini chủ yếu Flash, Antigravity Claude chạy Sonnet). `modelLabel(id)` đổi id thô thành tên đọc được ("Opus 5.5 · high", "Gemini Argon · high", "Gemini 3.5 Flash Lite"); id Codex (`gpt-*`) giữ nguyên, id lạ giữ nguyên, rỗng là "Chưa rõ model". Hậu tố `-low|-medium|-high` là mức suy luận. Model của hãng khác làn (Claude ở làn Gemini, Gemini ở làn Antigravity Claude) được đánh dấu `offLabel`; cùng hãng khác họ thì không.

## Giới hạn

- Lệnh xây động bằng biến, script ngoài hoặc shell phức tạp có thể không phân tích được; model ngoài các họ đã hỗ trợ bị bỏ qua.
- Không biết kết quả của các lần chỉ có tiến trình hoặc chỉ có mã trạng thái DB.
- Nhiều phiên tương tác Codex trong một rollout vẫn là một thanh.
- Che mẫu nhạy cảm là biện pháp đơn giản, không phải bộ phân loại bí mật hoàn chỉnh.
