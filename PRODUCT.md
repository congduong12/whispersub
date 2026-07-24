# WhisperSub — Product

<!-- impeccable:product-schema 1 -->

> Trạng thái: Working contract cho Phase 1–2. `docs/product/overview.md` là bản living contract ngắn gọn; `SPEC.md` là input specification chi tiết.

## Platform

web

UI web này được đóng gói trong Tauri cho macOS; Vite browser mode chỉ dùng để review giao diện và mock flow.

## Users

- Người làm nội dung hoặc học tập cần SRT nhanh cho video cá nhân.
- Người dùng kỹ thuật ưu tiên local processing và muốn kiểm soát model/device khi cần.
- Người dùng macOS Apple Silicon muốn xử lý batch nhưng không muốn UI bị treo.

## Product Purpose

WhisperSub giúp người dùng biến nhiều file video/audio thành phụ đề mà không phải tải media lên cloud. Trải nghiệm phải giống một macOS utility đáng tin cậy: mở app, chọn file, dùng default hợp lý và theo dõi queue mà không cần hiểu pipeline kỹ thuật.

Thành công nghĩa là người dùng có thể chọn một hoặc nhiều file media, tạo phụ đề bằng Whisper chạy local, theo dõi tiến trình từng file và nhận output an toàn tại vị trí dễ dự đoán.

## Positioning

WhisperSub khác các dịch vụ subtitle cloud ở cơ chế local-first: media được xử lý trên máy, queue vẫn phản hồi trong lúc Whisper chạy và việc gửi transcript text tới provider dịch chỉ xảy ra sau consent rõ ràng.

## Operating Context

- Người dùng làm việc trên macOS Apple Silicon với video/audio có thể nằm ở nhiều thư mục khác nhau.
- Luồng chính là chọn hoặc kéo thả nhiều file, kiểm tra default/tùy chỉnh cho batch, chọn nơi lưu, bắt đầu queue và theo dõi từng job.
- Mặc định mỗi output được lưu cạnh input tương ứng. Người dùng có thể chọn một custom directory áp dụng cho toàn bộ job trong batch.
- Custom directory được chọn bằng macOS folder picker, không cần persist qua app restart trong MVP và phải được kiểm tra tồn tại/quyền ghi trước khi queue bắt đầu.
- Vite browser mode cung cấp mock flow để review UI; native Tauri runtime là authority cho filesystem picker và validation.

## Capabilities and Constraints

### Trust contract

- Video và audio không rời khỏi máy.
- Translation provider mặc định tắt và chỉ nhận transcript text sau consent rõ ràng.
- Probe kết nối chỉ chạy khi người dùng bấm nút, gọi Models API không có content;
  kết quả không được hiểu là consent hoặc translation readiness.
- OpenAI/Gemini translation gửi từng chunk chỉ gồm segment id/text và target language;
  không gửi media path hoặc timestamp. Consent bị reset khi target, account hoặc
  model thay đổi.
- API key không nằm trong React state dài hạn, localStorage hoặc log. Trong WS-006,
  người dùng chấp nhận lưu key dưới dạng JSON không mã hóa tại
  `~/.whispersub/accounts`, với thư mục `0700` và file `0600` trên Unix.
- Output chưa hoàn tất không được publish hoặc ghi đè file hợp lệ.

### MVP capabilities

- Multi-file intake và queue tuần tự.
- Model, ngôn ngữ được nói trong audio và device có default an toàn, với tùy chỉnh khi cần.
- Audio Việt–Anh dùng Auto; phụ đề có thể giữ nguyên hoặc dịch sang English/Tiếng Việt.
- Target dịch chỉ sẵn sàng khi có account đúng provider, model và consent cho batch.
- OpenAI Responses và Gemini Generate Content adapter dùng structured output, kiểm
  tra đủ/đúng segment id, retry lỗi tạm thời có giới hạn và chỉ publish output khi
  mọi chunk đã dịch xong.
- SRT bắt buộc; VTT tùy chọn trong Phase 1 scaffold.
- Progress, phase, live segment, cancel và terminal states.
- Output location có hai mode: `same_as_input` mặc định và `custom_directory`
  dùng chung cho batch. Tất cả format của một job nằm trong cùng output directory.
- Output directory phải tồn tại và có quyền ghi trước khi queue bắt đầu; validation
  thất bại không được chuyển bất kỳ job nào sang trạng thái chạy.
- Collision dùng suffix an toàn, không tự ghi đè output hợp lệ.
- Browser fallback và mock runtime để review UI độc lập với native worker.
- Sidebar là điều hướng cấp ứng dụng duy nhất: Dashboard giữ queue/processing
  options và API Keys là destination riêng. Desktop cho phép lưu preference mở
  đầy đủ hoặc icon rail; mobile dùng drawer. Topbar không lặp destination links.
- Quản lý nhiều OpenAI/Gemini account local: thêm, đổi label/key, chọn account
  đang dùng và xóa. File mới có provider prefix và suffix chống trùng; file
  legacy cùng filename vẫn được hỗ trợ và không bị đổi tên.
- Mỗi account có Base URL tùy chọn: bỏ trống dùng endpoint chính thức của
  provider; remote override phải dùng HTTPS, còn HTTP chỉ dùng được với
  loopback local.
- Form account có probe kết nối thủ công cho OpenAI/Gemini. Probe chỉ đọc danh
  sách model, có timeout, chặn redirect và không bắt buộc pass trước khi lưu.
- Dashboard tải model theo account qua Rust. Gemini chỉ hiện model hỗ trợ
  `generateContent`; OpenAI hiện catalog account nhìn thấy và cho nhập thủ công khi
  custom gateway không có catalog phù hợp.

### Non-goals

- Subtitle timeline editor, diarization hoặc word-level timestamps.
- Parallel transcription trong MVP.
- Chọn output directory riêng cho từng file trong cùng batch.
- Persist custom output directory qua app restart hoặc security-scoped bookmark trong MVP.
- Mobile, Windows hoặc App Store distribution.
- Bundled sidecar hoặc tuyên bố release readiness khi chưa có proof tương ứng.

## Brand Commitments

- Tên sản phẩm là WhisperSub.
- Copy ưu tiên tiếng Việt rõ ràng, có thể giữ thuật ngữ kỹ thuật quen thuộc như Whisper, model, provider, batch và queue khi chúng chính xác hơn bản dịch gượng ép.
- Local-first là hành vi có thể kiểm chứng, không phải khẩu hiệu trang trí.
- Brand mark trong app và Dock dùng cùng waveform silhouette.

## Evidence on Hand

- `docs/product/overview.md`: living product contract.
- `SPEC.md`: field contract, functional requirements và acceptance criteria.
- `DESIGN.md`: visual/interaction foundation đã được chấp nhận cho Phase 1.
- `src/`: React UI, typed IPC và browser mock.
- `src-tauri/`: native command bridge, provider account store và worker lifecycle.
- `worker/`: Python JSONL worker, Whisper transcription, translation adapters và atomic output publishing.
- Chưa có bundled sidecar, release artifact, external testimonials, benchmark công khai hoặc bằng chứng App Store distribution; future work không được tự tạo các claim này.

## Product Principles

1. Media local theo mặc định; mọi network boundary phải cụ thể và có consent.
2. Safe defaults trước technical choices; người mới không cần hiểu pipeline để hoàn thành tác vụ.
3. Queue phải luôn cho biết trạng thái, hành động tiếp theo và không làm UI bị treo.
4. Output phải dễ dự đoán, kiểm tra được trước khi chạy và không ghi đè file hợp lệ.
5. Repository behavior, tests và runtime proof quan trọng hơn tuyên bố release.

## Accessibility & Inclusion

- First-time user nhận ra hành động đầu tiên trong vài giây và có thể dùng default mà không hiểu model/device.
- Queue luôn cho biết file nào đang xử lý, trạng thái hiện tại và hành động tiếp theo.
- Giao diện keyboard-accessible, không overflow ở breakpoint hẹp và giữ local-first guarantee rõ nhưng không lặp lại như motif trang trí.
- Mọi status/error có text và ARIA semantics, không chỉ truyền đạt bằng màu.
- Layout dùng được từ 320px và ở zoom 200%; motion tôn trọng `prefers-reduced-motion`.
- Full verification gate `pnpm check` pass cho mỗi story triển khai.

## Current Delivery State

Phase 1 có UI, typed IPC, queue/session history, browser fallback và native
development path qua Rust process bridge tới Python JSONL worker dùng
`openai-whisper`. Worker tạo transcript local và publish SRT/VTT/JSON atomically.
WS-009 bổ sung read-only Models API probe cho account OpenAI/Gemini; WS-010 bổ
sung consented OpenAI Responses adapter, quota/retry taxonomy và output suffix
theo ngôn ngữ. WS-011 bổ sung catalog model theo account, provider selector và
Gemini Generate Content adapter. Bundled sidecar, persistent history và release
bundle vẫn chưa được nối.

## Open Decisions

- Retry nên chạy lại cùng cấu hình hay mở recovery sheet theo từng loại lỗi?
- Có cần preset nhanh ngoài default `Small · Auto · Auto` cho power user không?
- Keyboard shortcut nào thuộc MVP: chọn file, chạy queue, cancel hay cả ba?
