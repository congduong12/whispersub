# WhisperSub

WhisperSub là ứng dụng desktop local-first cho macOS Apple Silicon, giúp tạo subtitle từ video bằng Whisper. Video và audio được xử lý trên máy; chỉ transcript text mới có thể được gửi tới translation provider khi người dùng chủ động bật và xác nhận.

Repository hiện chứa **Phase 1 development runtime với local transcription và optional OpenAI/Gemini translation**:

- React 19 + TypeScript + Vite cho UI;
- Tauri v2 + Rust cho desktop shell và typed command/event IPC;
- queue tuần tự, file picker, drag-and-drop, progress, cancel và preview segment;
- browser fallback để review UI không cần native runtime;
- Rust process bridge spawn Python, forward JSONL events và quản lý cancel;
- Python worker dùng `openai-whisper`, ghi SRT/VTT/JSON atomically và giữ media local;
- target-language readiness cho phép `Giữ nguyên theo audio`, English hoặc Tiếng
  Việt; target dịch yêu cầu provider account, model và consent riêng cho batch;
- điều hướng `Dashboard`/`API key` bằng hash route; workspace API key quản lý
  OpenAI và Gemini account qua Rust-owned local JSON store tại `~/.whispersub`,
  gồm thêm/sửa/chọn/xóa mà không trả key về frontend; account active được đồng bộ
  giữa `API key` và `Dashboard`; mỗi account có Base URL tùy chọn với endpoint
  chính thức được điền sẵn và probe kết nối thủ công trước hoặc sau khi lưu;
- unit/integration checks cho TypeScript, Python và Rust;
- Repository Harness core 0.1.7 cho workflow repo-centered và compatibility CLI
  0.1.22 để giữ lịch sử intake/story/proof/decision hiện có.

WS-009 bổ sung nút `Kiểm tra kết nối`: Rust gọi read-only Models API chỉ khi
người dùng chủ động bấm nút, không gửi media, transcript hoặc generation content.
Kết nối thành công chỉ xác nhận key/Base URL phản hồi tại thời điểm kiểm tra và
không thay thế consent dịch. WS-010 nối OpenAI Responses API ở Python worker:
Rust resolve key ngay trước khi spawn worker, worker chỉ gửi segment `id` +
`text`, dùng structured output và `store:false`, retry lỗi tạm thời/rate limit tối
đa ba attempt, rồi ghi subtitle đã dịch với suffix ngôn ngữ như `.vi.srt`.
WS-011 làm provider thành lựa chọn rõ ràng trong batch, tải model theo account qua
Rust và nối Gemini Generate Content adapter với cùng ranh giới consent/payload/retry.
Native worker lifecycle reserve slot atomically trước spawn, đăng ký kill handle
trước khi gửi JSONL và giữ cancel qua cả trạng thái starting/running; terminal event
chỉ được publish sau khi process exit và slot đã được giải phóng.
Gemini catalog chỉ hiện model hỗ trợ `generateContent`; OpenAI catalog hiện model
account nhìn thấy và vẫn cho nhập thủ công cho custom gateway. OpenAI mặc định dùng
`https://api.openai.com/v1`; Gemini mặc định dùng
`https://generativelanguage.googleapis.com`. Remote endpoint phải dùng HTTPS;
HTTP chỉ được phép cho loopback local. API key vẫn được lưu dạng JSON không mã
hóa với quyền file giới hạn; file mới có tiền tố `openai_` hoặc `gemini_`, còn
file WS-006 legacy không bị đổi tên. Bundled Python/ffmpeg sidecar và release
packaging chưa được nối. Development worker
hiện dùng Python virtual environment và ffmpeg có sẵn trên máy; đây chưa phải
release artifact tự chứa. Test tự động dùng provider giả lập; smoke với provider
thật cần credential/quota do người dùng cung cấp.

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
