# WhisperSub

WhisperSub là ứng dụng desktop local-first cho macOS Apple Silicon, giúp tạo subtitle từ video bằng Whisper. Video và audio được xử lý trên máy; chỉ transcript text mới có thể được gửi tới translation provider khi người dùng chủ động bật và xác nhận.

Repository hiện chứa **Phase 1 scaffold và WS-003 local worker chạy được trong development**:

- React 19 + TypeScript + Vite cho UI;
- Tauri v2 + Rust cho desktop shell và typed command/event IPC;
- queue tuần tự, file picker, drag-and-drop, progress, cancel và preview segment;
- browser fallback để review UI không cần native runtime;
- Rust process bridge spawn Python, forward JSONL events và quản lý cancel;
- Python worker dùng `openai-whisper`, ghi SRT/VTT/JSON atomically và giữ media local;
- unit/integration checks cho TypeScript, Python và Rust;
- Repository Harness v0.1.14 cho feature intake, story/proof tracking và decision log.

Translation provider, Keychain, bundled Python/ffmpeg sidecar và release packaging chưa được nối. Development worker hiện dùng Python virtual environment và ffmpeg có sẵn trên máy; đây chưa phải release artifact tự chứa.

## Yêu cầu môi trường

- macOS Apple Silicon;
- Node.js `20.19+` hoặc `22.12+`;
- pnpm `11.13.0` (được khóa bằng `packageManager`);
- Rust toolchain và các system dependency của Tauri v2;
- Python `3.11–3.13` và [uv](https://docs.astral.sh/uv/) để tạo worker environment (script mặc định dùng Python 3.12);
- `ffmpeg`/`ffprobe` trong `PATH` cho local development.

## Bắt đầu

```bash
pnpm install
pnpm worker:install
pnpm tauri dev
```

Lần transcription đầu tiên có thể tải model Whisper đã chọn. Model được cache local; media không được upload.

Chỉ review giao diện bằng trình duyệt:

```bash
pnpm dev
```

Browser mode dùng mock IPC trong `src/lib/tauri.ts`; native Tauri mode gọi worker thật qua `src-tauri/src/worker_job.rs`. Có thể chỉ định Python khác bằng biến môi trường `WHISPERSUB_PYTHON`.

## Kiểm tra

```bash
pnpm check
```

Lệnh này chạy typecheck, test TypeScript, test Python, Vite production build và test Rust/Tauri. Có thể chạy riêng:

```bash
pnpm test
pnpm test:worker
pnpm check:rust
pnpm build
```

## Cấu trúc chính

```text
src/                         React UI, queue state, Tauri bridge
src-tauri/                   Tauri v2 shell và mock command/event runtime
worker/                      Python JSONL worker scaffold
docs/product/                Living product contract từ SPEC
docs/stories/                Story packets và backlog
docs/decisions/              Architecture Decision Records
scripts/schema/              Harness SQLite migrations
scripts/bin/harness-cli      Harness CLI cục bộ, được gitignore
```

## Tài liệu

- [PRODUCT.md](./PRODUCT.md) — product notes ban đầu.
- [DESIGN.md](./DESIGN.md) — nguyên tắc thiết kế.
- [SPEC.md](./SPEC.md) — input specification và roadmap kỹ thuật.
- [docs/product/overview.md](./docs/product/overview.md) — living product contract ngắn gọn.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — ranh giới kiến trúc hiện tại.
- [docs/HARNESS_USAGE.md](./docs/HARNESS_USAGE.md) — hướng dẫn dùng Repository Harness trong WhisperSub.
