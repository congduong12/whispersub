from __future__ import annotations

import unittest

from worker.whispersub_worker.runtime_diagnostics import collect_youtube_runtime_diagnostics


class RuntimeDiagnosticsTest(unittest.TestCase):
    def test_snapshot_is_ordered_secret_free_and_reports_missing_tools(self) -> None:
        versions = {"yt-dlp": "2026.6.9", "yt-dlp-ejs": "0.8.0"}
        commands: list[list[str]] = []

        def run(command: list[str]) -> str:
            commands.append(command)
            return "ffmpeg version 8.1.2"

        diagnostics = collect_youtube_runtime_diagnostics(
            package_version=versions.__getitem__,
            which=lambda name: "/tools/ffmpeg" if name == "ffmpeg" else None,
            run_command=run,
        )

        self.assertEqual(
            [item.component for item in diagnostics],
            ["yt-dlp", "yt-dlp-ejs", "ffmpeg", "ffprobe", "deno"],
        )
        self.assertEqual([item.status for item in diagnostics], ["ready", "ready", "ready", "missing", "missing"])
        self.assertTrue(all("/tools/ffmpeg" not in repr(item) for item in diagnostics))
        self.assertEqual(commands, [["/tools/ffmpeg", "-version"]])

    def test_mismatch_and_unavailable_command_are_distinct(self) -> None:
        diagnostics = collect_youtube_runtime_diagnostics(
            package_version=lambda _name: "0.0.1",
            which=lambda _name: "/tool",
            run_command=lambda _command: None,
        )

        self.assertEqual(diagnostics[0].status, "mismatch")
        self.assertEqual(diagnostics[2].status, "unavailable")


if __name__ == "__main__":
    unittest.main()
