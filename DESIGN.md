# WhisperSub — Design

> Trạng thái: Foundation được chấp nhận cho Phase 1; tiếp tục harden/polish khi có engine và native states thật.

## Design direction

Một người dùng đang ngồi trước Mac trong thời gian làm việc, muốn thả vài video và quay lại công việc khác mà không phải học cách vận hành Whisper. Vì vậy UI dùng dark product surface yên tĩnh, density vừa phải và một accent xanh cho action/state; không dùng ngôn ngữ landing page hoặc decoration để chứng minh rằng app “công nghệ”.

Color strategy: **Restrained**. Tinted neutral surfaces chiếm phần lớn giao diện; accent chỉ dành cho primary action, focus, progress và success.

## Design principles

1. Task trước marketing: queue và file intake là điểm nhìn chính.
2. Safe defaults trước technical choices: cấu hình nâng cao dùng progressive disclosure.
3. Trust bằng hành vi và copy cụ thể: local-first guarantee rõ, không glow hoặc lặp slogan.
4. Familiar macOS affordances: native select/details/checkbox, hit target đủ lớn, motion 150–250ms chỉ để báo state.
5. Impeccable product register dùng cho shape, critique, audit, harden và polish; Apple HIG vẫn là chuẩn nền cho native shell.

## Information architecture

```text
Topbar: identity + local-processing guarantee
Sidebar: application destinations
  Dashboard (current)
    Compact intro: primary job + local-media guarantee
    Desktop workspace (42/58): compact queue -> expanded processing options
    Queue: compact file intake -> job state -> primary action
    Processing options: open by default, collapsible -> basic settings -> provider -> output
    API Keys (current)
    Plaintext storage notice -> OpenAI/Gemini tabs -> provider account list/form
  Future destinations are added only when their behavior exists
Main footer: platform + bilingual Auto reminder
```

Sidebar có label trên desktop và control để người dùng chủ động chuyển thành icon
rail 76px; preference này được lưu cục bộ. Dưới 760px, sidebar luôn là drawer và
không hiển thị desktop collapse control. Topbar không chứa destination link để
tránh hai nguồn điều hướng cùng cấp. Ở desktop trên 900px, queue chiếm khoảng 42% và processing options
khoảng 58% để provider/account/model xuất hiện sớm hơn khi section được mở. Các
field cơ bản và provider/account dùng hai cột khi đủ rộng. Ở breakpoint từ 900px
trở xuống, queue luôn xuất hiện trước processing options; dưới 600px, các field
trở về một cột. Không đưa cấu hình kỹ thuật lên trước file intake.

## Typography

- Một system sans stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif.
- Dashboard h1 cố định 24px; API Keys h1 dùng 32px desktop / 27px compact. Không dùng fluid display typography.
- Supporting text tối thiểu 11px trong dense UI; body/helper ưu tiên 12–14px.
- Heading dùng `text-wrap: balance`; prose dùng `text-wrap: pretty` khi phù hợp.
- Letter spacing display không nhỏ hơn `-0.04em`.

## Color tokens

- `--surface-base`: app background.
- `--surface-raised`: primary workspace surface.
- `--surface-muted`: secondary/settings surface.
- `--surface-control`: native control fill.
- `--text-primary`, `--text-secondary`, `--text-tertiary`: semantic text ramp.
- `--accent`, `--accent-hover`, `--accent-muted`: action/state only.
- `--danger`, `--danger-muted`: cancel/failure only.
- `--border-subtle`, `--border-strong`, `--focus-ring`: structure and accessibility.

Không dùng gradient text, decorative glow, glassmorphism, numbered section markers, hero metric hoặc side-stripe callout.

## Components

### Application shell

Topbar giữ waveform brand trong rounded-square dark ở trái và local-processing
guarantee ở phải. Tauri/Dock icon dùng cùng silhouette và color treatment. Sidebar
là nguồn duy nhất cho destination cấp ứng dụng; active row dùng icon, text và
`aria-current`. Desktop có control `Thu gọn menu` / `Mở rộng menu`; icon rail vẫn
giữ accessible name/title và preference được persist local. Dưới 760px sidebar
trở thành drawer có backdrop, Escape close và focus restoration. Chỉ destination
có behavior thật mới xuất hiện. Provider selector nằm trong API Keys page và tiếp
tục dùng tab semantics.
Visual reference và các khác biệt có chủ đích được lưu tại
`design/WS-015-sidebar-app-shell.md`.

### Drop zone

Là primary first-run affordance. Có default, hover, focus-visible và disabled state; copy cho phép cả click và drag/drop.

### Queue row

Hiển thị file name, textual status, progress và remove action có accessible label. Progress dùng `role="progressbar"`; dynamic list dùng polite live region. Failed row phải có diagnosis và next action khi engine thật được nối.

Khi batch đi vào terminal state, row cuối không tự vẽ divider nếu completed footer
đã có divider. Footer đổi sang kết quả thực tế: all-completed dùng `N file đã hoàn
tất`, còn failed/cancelled dùng outcome tương ứng. `Xóa lịch sử` chỉ dọn các row
terminal khỏi session queue và không xóa SRT/VTT; `Chọn thêm file` là primary
continuation sau khi batch kết thúc. Mixed queue chỉ dọn terminal rows, không tác
động queued/active job.

### Processing options

Dùng native `details/summary`, mở mặc định để người mới thấy ngay workflow cấu
hình nhưng vẫn cho phép thu gọn. Summary luôn phản ánh
model/spoken language/device/target hiện tại. Source-language control phải được
gọi là ngôn ngữ được nói, không phải ngôn ngữ phụ đề đích. Auto là default cho
audio Việt–Anh. Trên desktop, model/spoken language/target/device dùng grid hai
cột; khi chọn English hoặc Tiếng Việt, hiển thị một section phẳng với
provider/account cùng hàng và model full-width, sau đó là endpoint hiệu lực và
consent. Account/model chỉ thuộc
provider đang chọn; model catalog có loading/error/refresh và nhập thủ công khi
cần. Với Gemini, Models API chỉ dùng để giao catalog account nhìn thấy với một
allowlist dịch đã xác minh; Rust không trả toàn bộ catalog qua IPC và React chỉ
giữ intersection cuối cùng. Native select dùng các `optgroup` `Đề xuất`,
`Tương thích`, `Preview`; `gemini-3.1-flash-lite` đứng đầu và là mặc định khi
account hỗ trợ. Mỗi option có suffix ngắn mô tả trade-off. Không probe
`generateContent` tự động và không cache catalog đầy đủ; refresh vẫn là một hành
động metadata rõ ràng, không gửi prompt hoặc transcript. Helper phải phân biệt account
đã lưu với batch đã được phép gửi transcript; consent reset khi target, account
hoặc model đổi. Trạng thái provider dùng copy cụ thể và controls bị disabled khi
queue chạy.

Affordance của summary dùng nhãn rõ nghĩa `Thu gọn` / `Mở tùy chỉnh` với chevron,
không dùng dấu cộng xoay thành dấu X. Job list chỉ được cuộn dọc khi vượt chiều
cao giới hạn; overflow ngang phải bị chặn để tên file/progress không sinh nested
horizontal scrollbar. File mới luôn append ở cuối để thứ tự hiển thị khớp FIFO.
Khi người dùng đang ở gần cuối và queue không chạy, list tự reveal batch mới; nếu
người dùng đang đọc vị trí khác hoặc queue đang chạy, hiển thị action
`N file mới ở cuối` thay vì cướp vị trí cuộn. Mixed queue summary phải tách riêng
file đang chạy, file chờ xử lý và terminal history.

### Provider account manager

Đặt trong destination `API Keys`, tách khỏi processing options. Page hiển thị cảnh
báo plaintext/path đúng một lần, rồi dùng tab thật cho OpenAI/Gemini và một
capability section phẳng; không dùng modal hoặc card lồng nhau. Danh sách là các
row có divider; add/edit dùng form inline. Create editor nằm ngay sau provider
status và trước account list; edit editor nằm liền kề row được chọn. Khi editor mở,
focus chuyển tới tên hiển thị và được trả về action đã mở editor sau Save/Cancel.
Hai trường cốt lõi dùng layout hai cột trên desktop và stack một cột dưới 600px.
Luôn phân biệt rõ “đã chọn account” với “translation đã sẵn sàng” và khóa toàn bộ
mutation khi queue đang chạy.

Mỗi provider có disclosure `Cách lấy … API key` mở mặc định với ba bước ngắn và
link chính thức mở bằng Tauri opener trong trình duyệt mặc định. Base URL nằm trong
disclosure `Tùy chọn nâng cao` đóng mặc định, kèm endpoint hiệu lực và helper copy
nói rõ remote URL cần HTTPS, HTTP chỉ dành cho loopback local. Danh sách vẫn hiển
thị endpoint hiệu lực để người dùng biết key sẽ được định tuyến tới đâu. Form có
secondary action `Kiểm tra kết nối` cạnh Save/Cancel. Probe loading phải chặn
duplicate action; success, rate-limit warning và error dùng text cùng ARIA
semantics. Kết quả cũ bị xóa khi key, Base URL hoặc provider thay đổi. Save không
phụ thuộc probe vì custom gateway hoặc outage có thể tạo false negative.
Dưới 600px heading, row actions và form actions stack/wrap mà không overflow.
Empty, loading, error, warning, confirm-delete và success feedback đều phải có
text/ARIA semantics, không chỉ dùng màu.

### Actions

Một primary action “Tạo phụ đề”; cancel là danger-secondary. `Xóa lịch sử` là
outlined danger-secondary và chỉ xuất hiện khi có terminal job. Sau khi toàn bộ
batch kết thúc, primary continuation đổi thành `Chọn thêm file`.

## Interaction states

- Idle: drop zone prominent, primary action disabled và giải thích “Chọn video để bắt đầu”.
- Ready: queue có file, action enabled, current defaults vẫn hiển thị ở settings summary.
- Running: settings disabled, active file/phase/progress/cancel rõ.
- Success: textual completion state, output-retention helper và `Xóa lịch sử` xuất hiện.
- Failure: error text + recovery action; retry đầy đủ được defer tới engine story.
- Cancel: status phải phân biệt cancelling và cancelled.

## Accessibility

- Mọi interactive element có `:focus-visible` ring rõ.
- Primary controls cao ít nhất 44px; compact secondary target không nhỏ hơn 36–40px trong desktop utility.
- Status không truyền tải chỉ bằng màu; luôn có label text.
- Dynamic queue/progress/transcript dùng ARIA semantics và polite live announcements phù hợp.
- Layout không horizontal overflow ở 320px trở lên và vẫn dùng được khi zoom 200%.
- `prefers-reduced-motion` rút transition xuống gần như tức thời.

## Deferred design work

- Recovery UI chi tiết cho codec, permission, disk, output collision và quota.
- Native macOS keyboard shortcuts và menu commands.
- Real performance states, model download/loading và provider usage/cost surfaces.
- Lộ trình nâng cấp plaintext JSON sang Keychain/Stronghold nếu threat model thay đổi.
- Final Impeccable polish sau khi real Whisper states và native window smoke tồn tại.
