# Giao diện

Giao diện là HTML, CSS và JS thuần trong `public/`, không framework, không CDN, không font ngoài. Thời gian hiển thị cố định theo Việt Nam (UTC+7). Theo chế độ sáng/tối của hệ thống, mặc định tối.

## Tên làn và model

Mã làn nội bộ (`Claude`, `Codex`, `Opus`, `Argon`) giữ nguyên ở API. Tên hiển thị nằm ở hằng số `LANE_LABELS` trong `public/model-labels.js`: **Claude Code**, **Codex**, **Antigravity Opus** (Claude chạy qua agy), **Gemini Argon** (Gemini chạy qua agy). Tên làn chỉ là vai trò, nên mỗi lần chạy luôn ghi đúng model; model lệch tên làn có chú thích "model khác tên làn" ở chi tiết và tooltip.

Trong làn Claude Code, Sonnet và Opus phân biệt bằng chữ và hoa văn, không chỉ bằng màu: tiền tố "S 5.5" và "O 5.5", viền đôi cho Opus; thẻ ghi số đoạn theo model. Bộ lọc **Model** liệt kê tên đẹp kèm số lần ("Sonnet 5.5 (22)") và dùng chung cho cả dòng thời gian và sơ đồ.

## Thẻ trạng thái

Mỗi làn một thẻ: trạng thái (Đang chạy, Rảnh, Lỗi gần nhất), model và effort, lời nhắc (hai dòng, bẻ được đường dẫn dài; `title` là bản đã che tối đa 200 ký tự), dự án, và một dòng thời gian: "Vừa giao N giây trước" khi đang giao, "Đang làm: ..." khi đang làm, "Lần gần nhất: ..." khi rảnh. Thẻ ghi số lần giao trong 24 giờ (riêng Claude là số đoạn hoạt động, kèm đếm theo model). Thẻ Codex có dòng "Cấu hình hiện tại".

## Dòng thời gian

- Mỗi làn một hàng; mỗi lần giao là một thanh. Mặc định mở 6 giờ; có 24 giờ, 7 ngày, 30 ngày, nút lùi/tiến/hiện tại, phóng to, thanh cuộn ngang và kéo vùng trống. "Phóng to vùng hoạt động" thu về thanh đã chọn hoặc toàn bộ hoạt động đang lọc (khoảng nhỏ nhất 10 phút).
- Trạng thái phân biệt bằng hoa văn: thành công (đặc), lỗi (viền đứt và X), hết quota (sọc chéo), đang chạy (nhấp nháy), chưa rõ (chỉ viền); giờ kết thúc ước lượng có viền đứt mờ và panel chi tiết ghi mốc gốc. Phiên tương tác Codex hiển thị mờ.
- Thanh rộng tối thiểu 6 px; dưới 70 px không in chữ nhưng vẫn có `title`, điều hướng bàn phím và chi tiết. Thanh bắt đầu trước khung bị cắt ở mép trái kèm viền đứt "Tiếp tục từ trước khung nhìn"; `end: null` vẽ tới hiện tại.
- Nhãn trục đo chiều rộng thực trong DOM và bỏ nhãn cách nhãn trước dưới 8 px.
- Bấm thanh hoặc dùng Tab rồi Enter mở panel chi tiết: làn, model, giờ bắt đầu và kết thúc, thời lượng, dự án (và đường dẫn thật), nguồn lời nhắc, nguồn model, kết quả, chứng cứ ghép.

## Sơ đồ (mindmap)

SVG thuần, mọi kích thước tính trong JS. Gốc "Claude Code" ở giữa, ba làn, rồi dự án, rồi lá là từng lần giao. Phiên tương tác Codex và đoạn hoạt động Claude không tính thành lá.

- Mỗi làn hiện tối đa 8 dự án, mỗi dự án tối đa 10 lần giao (mới nhất trước); "+N dự án" và "+N lần giao" mở thêm; bấm làn hoặc dự án để thu gọn/mở lại và mở chi tiết lần giao mới nhất của nút đó.
- Bán kính lá theo log thời lượng (7 đến 18 đơn vị); độ dày cạnh gốc đến làn theo căn bậc hai số lần giao (2 đến 10). Cung làn tối thiểu 70 độ; lá xếp nhiều hàng đồng tâm, chừa tối thiểu 4 đơn vị giữa hai viền; nhãn dự án cắt bằng `...` theo ước lượng độ rộng.
- Kéo nền (chuột hoặc một ngón) để pan; lăn chuột hoặc nút để zoom; "Căn giữa" và "Sắp xếp lại". Panel chi tiết luôn nằm dưới sơ đồ, kể cả màn hình hẹp.
- Hàm bố cục `layoutMindmap(runs, options)` ở `public/mindmap-layout.js` là hàm thuần, nhập được từ Node để test (có `now` để đo lặp lại, `previous` để giữ vị trí cũ). Cập nhật SSE chỉ đổi thuộc tính phần tử đã có và thêm hoặc bỏ nút khi tập hiển thị đổi; vị trí, pan/zoom và trạng thái mở rộng được giữ nguyên. Tab Sơ đồ ẩn thì không tính bố cục và không vẽ; chuyển sang tab thì vẽ ngay.
- Chọn tab bằng `#dong-thoi-gian` hoặc `#so-do`. Hai tab dùng chung khoảng thời gian, bộ lọc làn, model, dự án.

## Đang giao và đang làm

`activityPhase(run, now)` ở `public/activity.js` (dẫn xuất phía giao diện, không nằm trong dữ liệu quét):

| Pha | Điều kiện |
| --- | --- |
| `giao` | run đang chạy và bắt đầu cách đây `DELEGATING_MS` = 45 giây trở lại |
| `làm` | run đang chạy lâu hơn 45 giây |
| `nghỉ` | đã xong |

Hiển thị:

- Cạnh từ Claude ra làn đang giao: nét đứt chạy theo chiều giao, mũi tên ở đầu phía làn, vài hạt tròn chạy dọc cạnh; gợn sóng ở nút Claude chỉ phát khi có lần giao mới.
- Nút làn và lá đang chạy: hai vòng halo lệch pha lan tỏa; cả đường làn, dự án, lá của run đang chạy sáng bằng nét đứt; huy hiệu "N đang chạy" ở nút làn.
- Dòng thời gian: thanh đang chạy có chấm nhấp nháy ở đầu phải và viền nét đứt chạy, nhãn "đang giao"/"đang làm" nếu thanh đủ rộng; nhãn làn và thẻ có chấm nhấp nháy.
- Phần tử hiệu ứng chỉ có ở run đang chạy, chỉ animate `transform` và `opacity`, tạm dừng khi tab ẩn (`data-motion-paused`).

## Trợ năng

- `prefers-reduced-motion: reduce`: không dựa vào animation để phân biệt trạng thái. Halo hiện tĩnh dày gấp đôi; cạnh đang giao có nét đứt tĩnh cùng mũi tên và chấm đặc, cạnh đang làm chỉ có nét đứt tĩnh; huy hiệu và thanh có nhãn chữ "đang giao"/"đang làm".
- Không dùng màu làm tín hiệu duy nhất (hoa văn, viền, chữ). Nút và thanh có `tabindex`, `aria-label` nêu cả trạng thái giao/làm; Enter hoặc Space kích hoạt.
- Màn hình hẹp (khoảng 390 px): thẻ một cột, bộ lọc xuống dòng, vùng biểu đồ cuộn ngang trong khung chứ không nới trang, sơ đồ co theo chiều rộng khung.

## Hai bẫy giao diện đã gặp (có test hồi quy)

- Dòng thời gian được dựng lại mỗi giây (`renderChart`), nên animation mới sinh bắt đầu từ 0 và không bao giờ chạy trọn một nhịp. Cách sửa: đặt pha theo đồng hồ thật bằng biến `--phase-<chu kỳ>` trên `#chart` (độ trễ âm `-(Date.now() mod chu kỳ)`), CSS dùng `animation-delay:var(--phase-...)`.
- Bộ chọn CSS hậu duệ `.map-node:hover circle` từng đè lên vòng halo và chấm huy hiệu và thua quy tắc "đang làm" về độ ưu tiên. Nay dùng `> circle:not(.map-halo):not(.map-badge-dot)`.
