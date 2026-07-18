# WhisperSub — Product

> Trạng thái: Working contract cho Phase 1–2. `docs/product/overview.md` là bản living contract ngắn gọn; `SPEC.md` là input specification chi tiết.

## Register

product

## Platform

web

UI web này được đóng gói trong Tauri cho macOS; Vite browser mode chỉ dùng để review giao diện và mock flow.

## Product vision

WhisperSub giúp người dùng biến nhiều file video/audio thành phụ đề mà không phải tải media lên cloud. Trải nghiệm phải giống một macOS utility đáng tin cậy: mở app, chọn file, dùng default hợp lý và theo dõi queue mà không cần hiểu pipeline kỹ thuật.

## Target users

- Người làm nội dung hoặc học tập cần SRT nhanh cho video cá nhân.
- Người dùng kỹ thuật ưu tiên local processing và muốn kiểm soát model/device khi cần.
- Người dùng macOS Apple Silicon muốn xử lý batch nhưng không muốn UI bị treo.

## Primary job

Chọn một hoặc nhiều file media, tạo phụ đề bằng Whisper chạy local, theo dõi tiến trình từng file và nhận output an toàn cạnh file gốc.

## Trust contract

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

## MVP scope

- Multi-file intake và queue tuần tự.
- Model, ngôn ngữ được nói trong audio và device có default an toàn, với tùy chỉnh khi cần.
- Audio Việt–Anh dùng Auto; phụ đề có thể giữ nguyên hoặc dịch sang English/Tiếng Việt.
- Target dịch chỉ sẵn sàng khi có account đúng provider, model và consent cho batch.
- OpenAI Responses và Gemini Generate Content adapter dùng structured output, kiểm
  tra đủ/đúng segment id, retry lỗi tạm thời có giới hạn và chỉ publish output khi
  mọi chunk đã dịch xong.
- SRT bắt buộc; VTT tùy chọn trong Phase 1 scaffold.
- Progress, phase, live segment, cancel và terminal states.
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

## Non-goals

- Subtitle timeline editor, diarization hoặc word-level timestamps.
- Parallel transcription trong MVP.
- Mobile, Windows hoặc App Store distribution.
- Bundled sidecar hoặc tuyên bố release readiness khi chưa có proof tương ứng.

## Success criteria

- First-time user nhận ra hành động đầu tiên trong vài giây và có thể dùng default mà không hiểu model/device.
- Queue luôn cho biết file nào đang xử lý, trạng thái hiện tại và hành động tiếp theo.
- Giao diện keyboard-accessible, không overflow ở breakpoint hẹp và giữ local-first guarantee rõ nhưng không lặp lại như motif trang trí.
- Full verification gate `pnpm check` pass cho mỗi story triển khai.

## Current delivery state

Phase 1 có UI, typed IPC, queue, browser fallback và native development path qua
Rust process bridge tới Python JSONL worker dùng `openai-whisper`. Worker tạo
transcript local. WS-009 bổ sung read-only Models API probe cho account
OpenAI/Gemini; WS-010 bổ sung consented OpenAI Responses adapter, quota/retry
taxonomy và output suffix theo ngôn ngữ. WS-011 bổ sung catalog model theo account,
provider selector và Gemini Generate Content adapter. Bundled sidecar, history và
release bundle vẫn chưa được nối.

## Open questions

- Khi engine thật tồn tại, retry nên chạy lại cùng cấu hình hay mở recovery sheet theo loại lỗi?
- Có cần preset nhanh ngoài default `Small · Auto · Auto` cho power user không?
- Keyboard shortcut nào thuộc MVP: chọn file, chạy queue, cancel hay cả ba?
