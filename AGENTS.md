# Agent Instructions

IMPORTANT: When applicable, prefer using webstorm-index MCP tools for code navigation and refactoring.

## Tài liệu học tập

Sau mỗi nhiệm vụ triển khai, hãy tạo:

`docs/learning-notes/<YYYY-MM-DD>-<ten-ngan-gon-cua-nhiem-vu>.md`

Sử dụng cấu trúc sau:

- `# Nhiệm vụ`
- `# Những gì tôi đã thay đổi`
- `# Vấn đề thực sự`
- `# Tại sao chọn giải pháp này`
- `# Hình thái triển khai thực tế`
- `# Các phương án khả thi khác`
- `# Tại sao tôi không chọn các phương án thay thế đó`
- `# Các khái niệm chính cần học`
- `# Những lỗi thường gặp`
- `# Ví dụ nhỏ`
- `# Cách tư duy về vấn đề này trong lần tới`

Đối với công việc không đơn giản, hãy đưa ra ít nhất hai phương án thay thế và
giải thích trường hợp nào phù hợp để áp dụng từng phương án.

## Remote Git Policy

Do not run `git push`, `git push --force`, or any other remote-write git
command from this repo unless the human explicitly asks for that exact action.

## Sub-agent Delegation

- Every call that spawns a sub-agent must explicitly set `model = "gpt-5.6-terra"`, `reasoning_effort = "medium"`, `service_tier = "priority"`, and `fork_turns = "none"`.
- Do not rely on inherited or default values for any of these four settings.
- Before spawning, verify that the active harness exposes and accepts all four settings. If any setting is unavailable, unsupported, rejected, or cannot be verified, do not spawn; report the capability blocker instead.
- Because `fork_turns = "none"` passes no parent conversation history, every sub-agent prompt must be self-contained and include the objective, relevant repository context and paths, constraints, expected output, and verification requirements.
- The root agent remains responsible for orchestration, reviewing sub-agent results, resolving conflicts, and producing the final answer.

<!-- HARNESS:BEGIN -->
## Harness

This repo uses Harness. Before work, read:

- `README.md`
- `docs/HARNESS.md`
- `docs/FEATURE_INTAKE.md`
- `docs/ARCHITECTURE.md`
- `docs/CONTEXT_RULES.md`
- `docs/TOOL_REGISTRY.md`
- `scripts/bin/harness-cli query matrix` on macOS/Linux, or `.\scripts\bin\harness-cli.exe query matrix` on Windows
<!-- HARNESS:END -->

## WhisperSub Project Notes

- Product intent and MVP boundaries start in `SPEC.md`; the concise living contract is `docs/product/overview.md`.
- Current implementation is Phase 1 only. Do not claim real transcription, translation, packaged sidecars, or release readiness.
- Preserve the boundary `React UI -> Tauri commands/events -> Python JSONL worker`.
- Video/audio must remain local. Provider work is high-risk and requires explicit consent, secret handling, and proof that media is never uploaded.
- Use pnpm 11. Run `pnpm check` before closing implementation work.
- Record normal or high-risk work in Harness before coding. See `docs/HARNESS_USAGE.md` for project examples.
