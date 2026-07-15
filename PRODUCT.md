# WhisperSub — Product

> Trạng thái: Working contract cho Phase 1–2. `docs/product/overview.md` là bản living contract ngắn gọn; `SPEC.md` là input specification chi tiết.

## Register

product

## Platform

macOS desktop qua Tauri; Vite browser mode chỉ dùng để review UI và mock flow.

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
- Secret không nằm trong React state dài hạn, localStorage, log hoặc plain-text file.
- Output chưa hoàn tất không được publish hoặc ghi đè file hợp lệ.

## MVP scope

- Multi-file intake và queue tuần tự.
- Model, source language và device có default an toàn, với tùy chỉnh khi cần.
- SRT bắt buộc; VTT tùy chọn trong Phase 1 scaffold.
- Progress, phase, live segment, cancel và terminal states.
- Browser fallback và mock runtime để review UI trước khi nối Whisper thật.

## Non-goals

- Subtitle timeline editor, diarization hoặc word-level timestamps.
- Parallel transcription trong MVP.
- Mobile, Windows hoặc App Store distribution.
- Tuyên bố transcription/release readiness khi worker thật chưa được nối.

## Success criteria

- First-time user nhận ra hành động đầu tiên trong vài giây và có thể dùng default mà không hiểu model/device.
- Queue luôn cho biết file nào đang xử lý, trạng thái hiện tại và hành động tiếp theo.
- Giao diện keyboard-accessible, không overflow ở breakpoint hẹp và giữ local-first guarantee rõ nhưng không lặp lại như motif trang trí.
- Full verification gate `pnpm check` pass cho mỗi story triển khai.

## Current delivery state

Phase 1 có UI, typed IPC, queue, browser fallback, Rust mock runtime và Python JSONL worker scaffold. Whisper/ffmpeg thật, provider, Keychain, history và release bundle chưa được nối.

## Open questions

- Khi engine thật tồn tại, retry nên chạy lại cùng cấu hình hay mở recovery sheet theo loại lỗi?
- Có cần preset nhanh ngoài default `Small · Auto · Auto` cho power user không?
- Keyboard shortcut nào thuộc MVP: chọn file, chạy queue, cancel hay cả ba?
