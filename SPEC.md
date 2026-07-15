# WhisperSub — Product & Technical Specification

**Trạng thái:** Draft v0.4  
**Nền tảng mục tiêu:** macOS Apple Silicon, ưu tiên M1  
**Tên tạm:** WhisperSub

## 1. Tóm tắt sản phẩm

WhisperSub là ứng dụng desktop chạy local, dùng Tauri + React để tạo subtitle từ file video bằng OpenAI Whisper. Người dùng chọn hoặc kéo thả video, chọn model/ngôn ngữ, bắt đầu xử lý và nhận file subtitle ở cùng thư mục hoặc thư mục đầu ra đã chọn.

Nguyên tắc chính:

- Video và audio luôn được xử lý local. Chỉ transcript text được gửi ra ngoài khi người dùng chủ động bật một external translation provider.
- Giao diện không bị treo trong lúc xử lý model.
- Có thể hủy job, xem tiến trình và biết lỗi rõ ràng.
- Output được ghi an toàn, không làm hỏng file cũ nếu job thất bại.
- Engine transcription được tách khỏi UI để sau này có thể thay bằng whisper.cpp hoặc faster-whisper.
- Translation provider được tách khỏi Whisper để có thể đổi provider mà không đổi subtitle pipeline.

## 2. Phạm vi và giả định ban đầu

### 2.1. Quyết định mặc định cho MVP

| Hạng mục | Quyết định mặc định |
|---|---|
| OS | macOS Apple Silicon; kiểm thử chính trên M1 |
| UI | React + TypeScript |
| Desktop shell | Tauri v2 + Rust |
| Speech engine | Python sidecar dùng openai-whisper |
| Media dependency | ffmpeg/ffprobe được đóng gói cùng app |
| Chế độ xử lý | Transcription offline; translation qua provider chỉ khi người dùng bật |
| Input MVP | Chọn một hoặc nhiều video; đưa vào queue và xử lý tuần tự |
| Output MVP | .srt bắt buộc; .vtt và .json là tùy chọn |
| Ngôn ngữ | Tự nhận diện hoặc chọn thủ công |
| Translation provider | Provider tab; OpenAI API là provider đầu tiên, local provider để mở rộng |
| Technical translation | Có chế độ giữ nguyên thuật ngữ software engineering và glossary |
| Ngôn ngữ v1 | English và Vietnamese cho source/target |
| Subtitle editor | Không nằm trong MVP; chỉ preview, mở file và export |
| Diarization | Không nằm trong MVP |
| Word-level timestamp | Không cam kết trong MVP |
| Phân phối | Chỉ dùng cá nhân trên Mac; không yêu cầu App Store, có thể tạo DMG local |

### 2.2. Ngoài phạm vi MVP

- Đồng bộ subtitle theo từng từ.
- Nhận diện và gán tên nhiều speaker.
- Dịch đa ngôn ngữ ngoài English/Vietnamese.
- Batch folder watcher.
- Chạy song song nhiều video.
- Tự động gửi transcript lên provider khi chưa có sự đồng ý của người dùng.
- Mobile app.
- Chỉnh sửa timeline nâng cao như Aegisub.

## 3. Mục tiêu thành công

MVP đạt khi người dùng có thể:

1. Mở app trên Mac M1.
2. Chọn hoặc kéo thả một hoặc nhiều video thông dụng.
3. Chọn model, ngôn ngữ nguồn và ngôn ngữ đích nếu cần.
4. Chọn translation provider nếu muốn dịch.
5. Chạy transcription mà UI vẫn phản hồi.
6. Theo dõi được trạng thái, tiến trình và log cơ bản.
7. Hủy job đang chạy.
8. Mở được file .srt trong phần mềm subtitle/video phổ biến.
9. Theo dõi từng file trong queue và biết file nào thành công/thất bại.
10. Chạy lại với cấu hình khác mà không tự động ghi đè file cũ nếu chưa xác nhận.

## 4. Use case chính

### UC-01 — Tạo subtitle từ video

1. Người dùng mở app.
2. Chọn một hoặc nhiều video bằng file picker hoặc kéo thả.
3. App đọc metadata từng file: tên, duration, kích thước và định dạng.
4. Người dùng chọn model, ngôn ngữ nguồn, ngôn ngữ đích, vị trí lưu output và format.
5. Người dùng bấm Generate subtitles.
6. App tải model nếu model chưa tồn tại.
7. App đưa các file vào queue và xử lý tuần tự.
8. App cập nhật progress cho file hiện tại và tổng quan queue.
9. App ghi output atomically cho từng file.
10. App hiển thị kết quả thành công/thất bại của từng file.

### UC-02 — Hủy xử lý

1. Người dùng bấm Cancel.
2. App gửi lệnh hủy tới worker.
3. Worker dừng tiến trình con trong thời gian ngắn nhất có thể.
4. App đánh dấu job là cancelled.
5. File output chưa hoàn thiện bị xóa hoặc không được publish.

### UC-03 — Chạy lại

Người dùng có thể chạy lại job với model hoặc cấu hình khác. Output mới phải được đặt tên an toàn, ví dụ:

- lesson.srt
- lesson (1).srt
- lesson-small-vi.srt

## 5. Yêu cầu chức năng

### FR-001 — Chọn input

- Hỗ trợ file picker của macOS.
- Hỗ trợ kéo thả file vào cửa sổ app.
- Kiểm tra extension và khả năng đọc media trước khi chạy.
- MVP nên hỗ trợ .mp4, .mov, .mkv, .webm, .avi, .m4v, .mp3, .wav, .m4a.
- Nếu file không đọc được, hiển thị lỗi có hướng xử lý thay vì stack trace.

### FR-002 — Chọn model

MVP hiển thị:

| Model | Mục đích |
|---|---|
| tiny | Test nhanh, chất lượng thấp hơn |
| base | Máy yếu hoặc video đơn giản |
| small | Cân bằng chất lượng/tốc độ, lựa chọn mặc định ban đầu |
| medium | Chất lượng cao hơn, cần nhiều thời gian và RAM |
| turbo | Ưu tiên tốc độ; không dùng làm mặc định cho translation |

Yêu cầu:

- Hiển thị Not downloaded, Downloading, Ready, Error.
- Có progress khi tải model.
- Chỉ cho phép một download model tại một thời điểm.
- Lưu model vào thư mục Application Support của app.
- Download lỗi phải có retry và không để lại file model hỏng được coi là hợp lệ.

### FR-003 — Cấu hình transcription và translation

Các field MVP:

- sourceLanguage: auto, en hoặc vi trong phiên bản đầu.
- targetLanguage: none, en hoặc vi trong phiên bản đầu.
- translationProvider: none, openai_api hoặc local_future.
- translationMode: none, native_whisper hoặc technical_context.
- technicalTranslation: bật/tắt chế độ dịch theo ngữ cảnh software engineering.
- glossary: danh sách thuật ngữ cần giữ nguyên hoặc mapping riêng.
- providerModel: model được chọn trong Provider tab.
- model.
- device: auto, mps, hoặc cpu.
- outputFormats: srt bắt buộc; vtt và json tùy chọn.
- outputLocationMode: same_as_input hoặc custom_directory; mặc định same_as_input.
- outputDirectory: null khi dùng same_as_input; là absolute directory path khi dùng custom_directory.
- overwritePolicy: ask, suffix, hoặc overwrite.

Quy tắc:

- device=auto ưu tiên đường chạy ổn định đã benchmark.
- Khi chạy CPU, worker đặt fp16=false.
- Whisper native chỉ hỗ trợ task translate về English. Với targetLanguage là Vietnamese, app dùng translation provider riêng.
- Chế độ technical translation phải giữ nguyên code identifiers, tên API/SDK/CLI, file path, URL, command flag, error code và các thuật ngữ software engineering đã có trong glossary.
- Timestamp của bản dịch phải kế thừa từ segment gốc; không được làm lệch timeline chỉ vì câu dịch dài hơn.
- Với provider chưa được cấu hình hoặc chưa hỗ trợ target language, UI phải disable lựa chọn đó và giải thích lý do.
- Khi translationProvider là openai_api, chỉ gửi transcript text, segment ID và glossary cần thiết; không gửi video/audio.
- Khi outputLocationMode là same_as_input, output của mỗi job được lưu cùng thư mục với input tương ứng.
- Khi outputLocationMode là custom_directory, một thư mục được chọn bằng macOS folder picker và áp dụng cho toàn bộ job trong batch.
- MVP không hỗ trợ chọn output directory riêng cho từng file trong cùng batch.
- Tất cả SRT, VTT và JSON của cùng một job được lưu trong cùng output directory.
- App phải kiểm tra thư mục tồn tại và có quyền ghi trước khi bắt đầu queue. Nếu validation thất bại, không job nào trong batch được bắt đầu.
- Custom output directory không cần được ghi nhớ sau khi app restart trong MVP. Nếu lưu để truy cập lại trong sandboxed app, phải dùng security-scoped bookmark.

### FR-003A — Technical translation

Technical translation là bước sau transcription, không phải một tùy chọn đơn giản của Whisper:

1. Whisper tạo transcript gốc và timestamp.
2. Translation engine dịch text của từng segment hoặc nhóm segment có context.
3. App giữ nguyên start/end của segment gốc.
4. App áp dụng glossary để giữ nguyên hoặc chuẩn hóa các thuật ngữ kỹ thuật.
5. App xuất bản dịch thành file riêng, ví dụ lesson.vi.srt hoặc lesson.en-tech.srt.

Trong MVP, OpenAI API là provider translation tùy chọn. Nếu người dùng không bật provider, app vẫn tạo transcript/SRT local bình thường. Khi bật OpenAI provider, chỉ transcript text được gửi đi sau khi app hiển thị cảnh báo và người dùng xác nhận.

### FR-003B — Provider tab

Provider tab là nơi cấu hình các AI provider, không phải một luồng xử lý riêng. MVP có:

- Local Whisper: provider transcription mặc định, không cần API key.
- OpenAI API: provider translation cho English và Vietnamese.
- Local translation: hiển thị là future provider, chưa cần triển khai trong MVP.

OpenAI provider cần có:

- Input API key.
- Nút Save, Remove và Test connection.
- Lựa chọn model.
- Hiển thị trạng thái Configured, Not configured hoặc Connection failed.
- Không hiển thị đầy đủ API key sau khi lưu.
- Không ghi API key vào React state lâu dài, localStorage, log hoặc file plain text.
- Lưu API key trong macOS Keychain; biến môi trường chỉ dùng cho development.
- Gọi OpenAI từ Rust/Python sidecar, không gọi trực tiếp từ React.
- Có cảnh báo rằng API usage được tính phí riêng và transcript text sẽ được gửi tới OpenAI khi translation được bật.

Provider interface tối thiểu:

    translate(segments, sourceLanguage, targetLanguage, glossary, style)
      -> translatedSegments

Provider phải trả lại đúng segment ID và translated text để app giữ timestamp local.

### FR-004 — Xử lý job

Job có các trạng thái:

    queued -> preparing -> loading_model -> extracting_audio -> transcribing
           -> translating -> writing_output -> completed

    queued/preparing/loading_model/extracting_audio/transcribing/translating -> cancelling -> cancelled
    queued/preparing/loading_model/extracting_audio/transcribing/translating -> failed

Yêu cầu:

- Mỗi job có jobId duy nhất.
- Một batch có nhiều job; MVP chạy một job active tại một thời điểm.
- Queue phải hiển thị trạng thái từng job: queued, processing, completed, failed, cancelled.
- Có thể hủy job hiện tại và xóa các job đang chờ.
- Không chạy song song mặc định vì có thể làm tăng RAM và giảm throughput trên M1.
- Nếu dùng OpenAI provider, hiển thị riêng trạng thái translating và lỗi network/rate limit.
- Worker chạy ngoài UI process.
- UI nhận event theo stream thay vì polling log text.
- Chỉ publish output khi worker hoàn thành thành công.

### FR-005 — Progress và log

UI hiển thị:

- Tên file input.
- Trạng thái hiện tại.
- Phần trăm tiến trình ước tính.
- Thời gian đã chạy.
- Model, language, device.
- Thông báo đang tải model hay transcription.
- Error message thân thiện.
- Nút xem log kỹ thuật dành cho debug.

Progress transcription có thể tính theo segment_end / media_duration. Progress tải model lấy theo bytes đã tải. Nếu engine không cung cấp tiến trình chính xác, UI ghi rõ là tiến trình ước tính.

### FR-006 — Xuất subtitle

#### SRT

- Encoding UTF-8.
- Timestamp HH:MM:SS,mmm.
- Index bắt đầu từ 1.
- Một segment tương ứng một cue.
- Loại bỏ khoảng trắng đầu/cuối.
- Không để timestamp kết thúc nhỏ hơn hoặc bằng timestamp bắt đầu.
- Xử lý newline trong text nhất quán.

#### VTT

- Encoding UTF-8.
- Có header WEBVTT.
- Timestamp HH:MM:SS.mmm.

#### JSON

JSON dùng cho debug hoặc tích hợp về sau, tối thiểu gồm metadata job và segments:

    {
      "schemaVersion": 1,
      "jobId": "job_20260715_001",
      "input": "lesson1.mp4",
      "sourceLanguage": "en",
      "targetLanguage": "vi",
      "translationProvider": "openai_api",
      "model": "small",
      "durationSeconds": 612.4,
      "segments": [
        { "id": 0, "start": 0.12, "end": 3.84, "text": "Xin chào mọi người." }
      ]
    }

### FR-007 — Preview, không phải subtitle editor

MVP chỉ preview danh sách cue:

- STT.
- Start/end.
- Text.
- Copy text.
- Mở file output.
- Mở thư mục output.

Subtitle editor nghĩa là một màn hình cho phép sửa text, start/end time, merge/split cue và lưu lại file SRT mới. Tính năng này không nằm trong MVP; người dùng có thể mở output bằng công cụ bên ngoài. Nếu bổ sung sau này, phải lưu bản đã chỉnh sửa riêng và không làm mất raw transcription.

### FR-008 — Hủy và recovery

- Hủy phải idempotent: bấm nhiều lần không tạo lỗi mới.
- Khi app đóng giữa chừng, job đánh dấu interrupted ở lần mở sau hoặc xóa khỏi active state.
- Temp directory của job được cleanup khi completed, cancelled hoặc failed.
- Lỗi phân loại ít nhất: input, ffmpeg, model download, model load, transcription, permission, output.

### FR-009 — Lịch sử tối thiểu

MVP có thể lưu local metadata của 20 job gần nhất:

- jobId, input basename, thời gian chạy, model, language, status, output paths.
- Không lưu video/audio hoặc toàn bộ transcript vào database.
- Có nút Clear history.

### FR-010 — Batch queue

- File picker cho phép chọn nhiều video.
- Drag-and-drop nhiều file tạo nhiều job trong cùng batch.
- Mỗi file có progress, status, error và output riêng.
- Xử lý tuần tự theo thứ tự trong queue.
- Một file lỗi không làm dừng các file còn lại.
- Có nút Cancel current và Clear pending.
- Có tổng progress theo số file hoàn thành và progress của file hiện tại.
- Parallel processing chỉ xem xét sau khi có benchmark; không thuộc MVP.

## 6. Kiến trúc đề xuất

    React + TypeScript UI
            │ Tauri invoke/events
            ▼
    Tauri Rust Core
      - file picker / path validation
      - job lifecycle
      - sidecar process management
      - provider configuration and secure key access
      - output open/show-in-folder
            │ newline-delimited JSON over stdin/stdout
            ▼
    Python Worker and Provider Layer
      - load openai-whisper model
      - ffmpeg audio preparation
      - transcribe
      - call selected translation provider
      - local technical glossary
      - emit progress and segments
            │
            ├── bundled ffmpeg/ffprobe
            ├── local model cache
            └── temp job directory

### 6.1. React layer

Đề xuất module:

    src/
      components/
      features/job/
      features/models/
      features/providers/
      features/settings/
      lib/tauri.ts
      lib/types.ts
      stores/

Frontend không tự chạy Python, đọc process stdout hoặc quản lý đường dẫn hệ thống. Frontend chỉ gọi command/event đã định nghĩa.

### 6.2. Tauri/Rust layer

- Validate request từ frontend.
- Tạo jobId và temp directory.
- Spawn worker sidecar.
- Ghi request JSON vào stdin.
- Đọc từng dòng event từ stdout.
- Forward event sang React bằng Tauri event.
- Hủy worker và child process.
- Mở file/thư mục bằng API hệ thống an toàn.
- Quản lý quyền sidecar trong Tauri capabilities.
- Đọc API key từ macOS Keychain khi cần gọi provider.
- Không gửi API key hoặc transcript vào event log của frontend.

Không nên dùng lệnh CLI whisper rồi parse output text cho đường chạy chính. Worker Python nên gọi API Python để lấy segment có cấu trúc; CLI chỉ dùng cho spike/debug.

### 6.3. Python worker

Đề xuất module:

    worker/
      main.py                 # stdin/stdout protocol
      engine.py               # abstraction over Whisper
      whisper_engine.py       # openai-whisper implementation
      provider.py              # provider interface
      openai_provider.py       # OpenAI Responses API adapter
      local_provider.py        # future local adapter
      media.py                # duration, ffmpeg, temp audio
      subtitles.py            # SRT/VTT/JSON formatter
      models.py               # model cache/download state
      glossary.py              # preserve software terms
      errors.py

Worker phải:

- Chỉ ghi protocol event vào stdout.
- Ghi log kỹ thuật vào stderr hoặc file log riêng.
- Không ghi progress dạng text tự do vào stdout.
- Trả exit code khác 0 khi thất bại.
- Nhận một request rồi kết thúc ở MVP, hoặc hỗ trợ nhiều request tuần tự về sau.
- Khi gọi OpenAI, chỉ gửi các segment cần dịch và nhận structured result theo segment ID.

## 7. IPC contract

### 7.1. Request

Mỗi request là một JSON line:

    {
      "type": "start_job",
      "jobId": "job_01HXYZ",
      "inputPath": "/path/to/lesson1.mp4",
      "outputLocationMode": "custom_directory",
      "outputDirectory": "/path/to/output",
      "model": "small",
      "sourceLanguage": "vi",
      "targetLanguage": "en",
      "task": "transcribe",
      "translationProvider": "openai_api",
      "translationMode": "technical_context",
      "technicalTranslation": true,
      "glossary": "software-engineering-default",
      "providerModel": "configured-in-provider-tab",
      "device": "auto",
      "outputFormats": ["srt", "vtt", "json"],
      "overwritePolicy": "suffix"
    }

Lệnh điều khiển:

    { "type": "cancel_job", "jobId": "job_01HXYZ" }
    { "type": "ping" }

### 7.2. Event

Các event tối thiểu:

    { "type": "job_started", "jobId": "job_01HXYZ" }
    { "type": "phase_changed", "jobId": "job_01HXYZ", "phase": "transcribing" }
    { "type": "progress", "jobId": "job_01HXYZ", "phase": "transcribing", "percent": 42.1 }
    { "type": "segment", "jobId": "job_01HXYZ", "segment": { "id": 12, "start": 80.4, "end": 84.1, "text": "..." } }
    { "type": "completed", "jobId": "job_01HXYZ", "outputs": ["/path/lesson.srt"] }
    { "type": "cancelled", "jobId": "job_01HXYZ" }
    { "type": "error", "jobId": "job_01HXYZ", "code": "MODEL_LOAD_FAILED", "message": "...", "retryable": true }

### 7.3. Error codes

    INVALID_INPUT
    UNSUPPORTED_MEDIA
    PERMISSION_DENIED
    FFMPEG_NOT_FOUND
    FFMPEG_FAILED
    MODEL_NOT_FOUND
    MODEL_DOWNLOAD_FAILED
    MODEL_LOAD_FAILED
    TRANSCRIPTION_FAILED
    OUTPUT_WRITE_FAILED
    CANCELLED
    UNKNOWN_ERROR

## 8. Quản lý file, model và quyền macOS

### 8.1. Model cache

Đường dẫn logic:

    ~/Library/Application Support/WhisperSub/models/<model-name>/
    ~/Library/Application Support/WhisperSub/history.json
    ~/Library/Logs/WhisperSub/

Trong app sandbox, dùng thư mục Application Support do app cấp thay vì hard-code đường dẫn ngoài container.

Model download phải có:

- file tạm trong lúc tải;
- kiểm tra tính toàn vẹn tối thiểu;
- rename atomic khi tải xong;
- retry;
- thông báo rõ là lần đầu cần internet.

### 8.2. Input/output permission

- Input được chọn bằng file picker hoặc drag-and-drop.
- Mặc định output của mỗi job được lưu cùng thư mục với input tương ứng.
- Người dùng có thể chọn Custom folder bằng macOS folder picker; thư mục này áp dụng cho toàn bộ batch.
- App phải preflight output directory trước khi chạy: tồn tại, là directory và có quyền ghi.
- Nếu custom directory không hợp lệ hoặc mất quyền truy cập, app không bắt đầu queue và hướng dẫn người dùng chọn thư mục khác.
- Chọn custom output directory không được di chuyển hoặc thay đổi input.
- Nếu nhiều input có cùng basename trong custom directory, áp dụng overwritePolicy để tạo tên output an toàn.
- Không yêu cầu quyền đọc toàn bộ ổ đĩa nếu không cần.
- Custom directory chỉ cần có hiệu lực trong session hiện tại ở MVP. Nếu phát hành sandboxed app và cần truy cập lại sau restart, phải dùng security-scoped bookmark.
- Không lưu nội dung video/audio trong history.

### 8.3. Sidecar và binary

- Bundle Python worker cho aarch64-apple-darwin.
- Bundle ffmpeg và ffprobe tương thích arm64.
- Bản release không phụ thuộc Python hoặc ffmpeg cài sẵn trên máy user.
- Tauri capability chỉ cấp quyền cần thiết để spawn/execute sidecar.
- Khi phát hành cần thử code signing, Developer ID, notarization và Gatekeeper.

## 9. UX đề xuất

### Màn hình chính

1. Vùng drag-and-drop lớn.
2. Nút Choose video.
3. Metadata file và nút Remove.
4. Model/language/task/device.
5. Output location:
   - Same folder as each input file, được chọn mặc định.
   - Custom folder, kèm nút Choose folder và đường dẫn hiện tại.
6. Output formats:
   - SRT được chọn bắt buộc và không thể bỏ chọn.
   - VTT là tùy chọn.
   - JSON nằm trong mục Advanced/Debug.
7. Nút Generate subtitles.

### Màn hình đang chạy

- Phase hiện tại.
- Progress bar.
- Elapsed time.
- Preview segment mới nhất.
- Cancel.

### Màn hình hoàn thành

- Số segment.
- Thời gian xử lý.
- Danh sách output.
- Open subtitle.
- Show in Finder.
- Generate again.

Thông báo lỗi phải trả lời:

1. Chuyện gì đã xảy ra?
2. Có ảnh hưởng đến file gốc không?
3. Người dùng nên làm gì tiếp theo?

## 10. Kế hoạch triển khai

### Phase 0 — Spike kỹ thuật

Deliverables:

- Chạy openai-whisper trên video tiếng Việt và tiếng Anh.
- Đo tiny, base, small, turbo trên Mac M1.
- Kiểm tra cpu và mps nếu PyTorch hỗ trợ ổn định.
- Xác nhận model download, ffmpeg, Unicode và timestamp.
- Xác nhận native Whisper translation về English.
- Kiểm tra OpenAI API translation cho English và Vietnamese.
- Đánh giá prompt/glossary cho transcript software engineering.
- Xác định cách lưu API key trong macOS Keychain.
- Tạo glossary mặc định cho software engineering.
- Chốt model mặc định dựa trên benchmark thực tế.

Exit criteria: có bảng benchmark, worker Python trả về JSON segments và OpenAI provider dịch đúng schema cho English/Vietnamese.

### Phase 1 — Scaffold desktop app

Deliverables:

- Tạo Tauri v2 + React + TypeScript project.
- File picker, drag-and-drop và types dùng chung.
- Tauri command/event skeleton.
- Mock worker phát progress giả.

Exit criteria: UI chạy end-to-end với mock event, chưa cần Whisper thật.

### Phase 2 — Worker và engine

Deliverables:

- Python worker dùng stdin/stdout JSONL.
- Model manager.
- Media metadata và ffmpeg preparation.
- Whisper transcription.
- Cancel signal.
- SRT/VTT/JSON writer.
- Translation provider interface.
- OpenAI Responses API adapter cho English/Vietnamese.
- Technical translation prompt và glossary.

Exit criteria: worker chạy độc lập bằng fixture video, tạo output hợp lệ và trả lỗi có mã.

### Phase 3 — Tích hợp UI thật

Deliverables:

- Job state machine.
- Progress mapping.
- Preview segments.
- Output collision policy.
- Output location selector với same_as_input và custom_directory.
- Preflight quyền ghi cho output directory trước khi bắt đầu batch.
- History tối thiểu.
- Batch queue nhiều file, xử lý tuần tự.
- Provider tab với OpenAI API configuration.
- Target language dropdown chỉ enable English/Vietnamese trong phiên bản đầu.
- Consent message trước khi gửi transcript ra ngoài.

Exit criteria: UC-01 đến UC-03 và batch 3 file chạy trên Mac M1 với video dài tối thiểu 30 phút.

### Phase 4 — Đóng gói và QA

Deliverables:

- Build arm64.
- Bundle worker, ffmpeg và model bootstrap.
- Test trên clean machine hoặc user account sạch.
- Code signing/notarization nếu cần phát hành.
- Local error logging.

Exit criteria: cài từ artifact release mà không cần Python, Node hoặc ffmpeg global.

### Phase 5 — P1

- Subtitle editor.
- Local translation provider hoặc provider khác.
- Các target language ngoài English/Vietnamese.
- Line wrapping nâng cao.
- Word-level timestamp.
- Speaker diarization.
- Backend thứ hai như whisper.cpp hoặc faster-whisper.
- Parallel processing tùy chọn sau benchmark.
- Universal binary hoặc Windows support nếu có nhu cầu.

## 11. Kiểm thử và acceptance criteria

### Unit test

- SRT/VTT timestamp conversion.
- Newline và Unicode handling.
- Segment rỗng, overlap và duration không hợp lệ.
- Output collision policy.
- IPC schema validation.
- Error mapping.

### Integration test

- Worker nhận request và trả event đúng thứ tự.
- Model cache hit/miss.
- ffmpeg success/failure.
- Cancel trước và trong transcription.
- Output không publish khi job failed.
- Input path có khoảng trắng, Unicode và ký tự đặc biệt.
- Same folder as each input lưu output cạnh đúng input tương ứng.
- Custom output directory áp dụng cho toàn bộ file trong batch.
- Custom output path có khoảng trắng và Unicode.
- Output directory không tồn tại, không phải directory hoặc không có quyền ghi phải bị chặn trước khi queue bắt đầu.
- Hai input trùng basename trong custom directory không được ghi đè lẫn nhau.
- Batch có một file lỗi nhưng các file còn lại vẫn chạy.
- Queue cancel current và clear pending.
- OpenAI provider trả về đúng segment ID và giữ timestamp local.
- API timeout/rate limit có retry có giới hạn và lỗi thân thiện.
- Translation bị tắt thì không có network request nào chứa transcript.

### End-to-end test

- Video tiếng Việt.
- Video tiếng Anh.
- Video không có audio.
- Audio-only input.
- File dài.
- File lỗi hoặc bị từ chối quyền.
- Chạy lại tạo suffix đúng.
- App đóng giữa job rồi mở lại.

### Acceptance criteria MVP

- [ ] Tạo subtitle thành công từ MP4 có audio trên Mac M1.
- [ ] SRT mở được bằng ít nhất một video player hoặc subtitle editor phổ biến.
- [ ] UI không bị treo khi model load/transcribe.
- [ ] Có progress, cancel, completed và failed state.
- [ ] Có thể chọn nhiều video và xử lý tuần tự trong một batch.
- [ ] Một file lỗi không làm dừng các file còn lại.
- [ ] SRT là output bắt buộc; VTT là tùy chọn.
- [ ] Video/audio không được gửi tới OpenAI; chỉ transcript text được gửi khi user bật translation.
- [ ] API key không xuất hiện trong frontend, log hoặc file plain text.
- [ ] Translation English/Vietnamese giữ nguyên code identifier và thuật ngữ trong glossary.
- [ ] Người dùng phải xác nhận trước lần gửi transcript đầu tiên.
- [ ] Bản release không cần Python/ffmpeg global.
- [ ] Model chưa tải báo rõ và có retry.
- [ ] Output thất bại không ghi đè file hợp lệ.
- [ ] Input/output path có Unicode được xử lý đúng.
- [ ] Mặc định output của mỗi job được lưu cùng thư mục với input tương ứng.
- [ ] Người dùng có thể chọn một custom output directory bằng macOS folder picker.
- [ ] Custom output directory áp dụng cho toàn bộ batch.
- [ ] App kiểm tra thư mục tồn tại và quyền ghi trước khi bắt đầu queue.
- [ ] Chọn custom output directory không di chuyển hoặc thay đổi input.
- [ ] SRT, VTT và JSON của cùng job được lưu trong cùng output directory.
- [ ] Khi nhiều input trùng basename trong custom directory, output được đặt tên an toàn và không ghi đè lẫn nhau.

## 12. Rủi ro và giảm thiểu

| Rủi ro | Ảnh hưởng | Giảm thiểu |
|---|---|---|
| PyTorch/Whisper bundle lớn | Installer lớn, build khó | Sidecar; cache model ngoài installer; tách engine abstraction |
| MPS không ổn định | Crash hoặc chậm hơn CPU | auto theo benchmark; có fallback CPU |
| Segment timestamp chưa đủ đẹp | Subtitle cần chỉnh tay | MVP chỉ cam kết segment-level; editor/forced alignment là P1 |
| ffmpeg sai hoặc thiếu | Không đọc được media | Bundle binary arm64 và health check |
| App Sandbox hạn chế file | Không đọc/ghi được sau restart | File picker, bookmark và test signed app |
| Model download lỗi | User không chạy lần đầu | Progress, retry, temp file và cache validation |
| File quá dài/RAM cao | App chậm hoặc bị kill | Benchmark, giới hạn song song và cleanup |
| Dịch đa ngôn ngữ không đủ ngữ cảnh tech | Thuật ngữ bị dịch sai | Translation engine pluggable, glossary, giữ nguyên code token và benchmark bằng transcript tech thật |
| API key bị lộ | Phát sinh chi phí hoặc mất quyền kiểm soát tài khoản | Keychain, không lưu localStorage/log, không hard-code, chỉ gọi provider từ sidecar |
| API phát sinh chi phí | User không dự đoán được chi phí | Hiển thị provider đang bật, số segment/token ước tính và yêu cầu xác nhận |
| Mất mạng hoặc rate limit | Translation thất bại | Retry có giới hạn, giữ transcript gốc và cho phép chạy lại translation |

## 13. Các yêu cầu đã chốt

- Chỉ dùng cá nhân trên Mac Apple Silicon/M1.
- SRT là output bắt buộc.
- VTT là output tùy chọn.
- Có target language option cho translation.
- Phiên bản đầu hỗ trợ English và Vietnamese.
- Ưu tiên technical translation và giữ nguyên thuật ngữ software engineering.
- Có Provider tab; OpenAI API là translation provider đầu tiên.
- Người dùng chủ động bật provider; video/audio không được gửi ra ngoài.
- Hỗ trợ chọn nhiều video, nhưng xử lý tuần tự trong MVP.
- Không cần subtitle editor trong phiên bản đầu.
- Không cần App Store.

## 14. Các quyết định còn lại

1. Model OpenAI nào sẽ làm mặc định sau khi benchmark chất lượng và chi phí.
2. Video dài và dung lượng tối đa dự kiến là bao nhiêu?
3. Có cần cho phép người dùng tự chỉnh sửa glossary trong UI ngay từ MVP hay dùng glossary mặc định trước?
4. Có muốn lưu API key chỉ trong Keychain hay hỗ trợ thêm biến môi trường cho production.

## 15. Khuyến nghị cấu hình để bắt đầu

Nếu chưa có quyết định khác:

- macOS arm64 only.
- Tauri v2 + React/TypeScript.
- Rust quản lý lifecycle và sidecar.
- Python worker dùng openai-whisper.
- small làm model mặc định sau benchmark.
- sourceLanguage=auto, task=transcribe, device=auto.
- SRT là output bắt buộc; VTT và JSON là tùy chọn.
- Cho phép chọn nhiều file nhưng chỉ một active job tại một thời điểm.
- task=transcribe là mặc định để giữ nguyên nội dung gốc.
- OpenAI API là provider dịch đầu tiên cho English/Vietnamese.
- Technical translation dùng prompt, glossary và context chunk.
- Không gửi video/audio; chỉ gửi transcript khi user xác nhận.
- Không có editor, diarization hoặc target language ngoài English/Vietnamese trong MVP.
- Model tải on-demand và lưu local.

## 16. Tài liệu tham khảo

- OpenAI Whisper: https://github.com/openai/whisper
- OpenAI text generation: https://developers.openai.com/api/docs/guides/text
- OpenAI Responses API migration: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI API key safety: https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
- ChatGPT subscription and API billing: https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api
- OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- Tauri v2 sidecar: https://v2.tauri.app/develop/sidecar/
- Tauri v2 project structure: https://v2.tauri.app/start/project-structure/
- Apple App Sandbox file access: https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox
