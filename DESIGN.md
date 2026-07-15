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
App bar: identity + local-processing guarantee
Compact intro: primary job + honest preview limitation
Workspace
  Queue: file intake -> job state -> primary action
  Processing options: collapsed by default -> model/language/device/output/privacy
Footer: platform + preview output limitation
```

Ở breakpoint dưới 900px, queue luôn xuất hiện trước processing options. Không đưa cấu hình kỹ thuật lên trước file intake.

## Typography

- Một system sans stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif.
- Product h1 cố định 32px desktop / 27px compact; không dùng fluid display typography.
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

### App bar

Brand ở trái, local-processing guarantee ở phải. Privacy dot không có glow và không phải nguồn duy nhất truyền tải meaning.

### Drop zone

Là primary first-run affordance. Có default, hover, focus-visible và disabled state; copy cho phép cả click và drag/drop.

### Queue row

Hiển thị file name, textual status, progress và remove action có accessible label. Progress dùng `role="progressbar"`; dynamic list dùng polite live region. Failed row phải có diagnosis và next action khi engine thật được nối.

### Processing options

Dùng native `details/summary`, collapsed mặc định. Summary luôn phản ánh model/language/device hiện tại. Controls bị disabled khi queue chạy.

### Actions

Một primary action “Tạo phụ đề”; cancel là danger-secondary. Clear-finished chỉ xuất hiện khi có file hoàn tất.

## Interaction states

- Idle: drop zone prominent, primary action disabled và giải thích “Chọn video để bắt đầu”.
- Ready: queue có file, action enabled, current defaults vẫn hiển thị ở settings summary.
- Running: settings disabled, active file/phase/progress/cancel rõ.
- Success: textual completion state; clear-finished xuất hiện.
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

- Retry/recovery taxonomy cho codec, permission, disk và output collision.
- Native macOS keyboard shortcuts và menu commands.
- Real performance states, model download/loading, provider consent và Keychain surfaces.
- Final Impeccable polish sau khi real Whisper states và native window smoke tồn tại.
