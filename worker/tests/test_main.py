from __future__ import annotations

import json
import subprocess
import sys
import unittest

from worker.tests.test_protocol import valid_message
from worker.main import build_translation_adapter
from worker.whispersub_worker.gemini_provider import GeminiTranslationAdapter
from worker.whispersub_worker.openai_provider import OpenAITranslationAdapter


class WorkerProcessTest(unittest.TestCase):
    def test_dispatches_translation_adapter_by_provider(self) -> None:
        self.assertIsInstance(build_translation_adapter("openai_api"), OpenAITranslationAdapter)
        self.assertIsInstance(build_translation_adapter("gemini_api"), GeminiTranslationAdapter)
        self.assertIsNone(build_translation_adapter("none"))

    def run_worker(self, line: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "worker.main"],
            input=line,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_ping_round_trip_uses_jsonl_stdout(self) -> None:
        result = self.run_worker('{"type":"ping"}\n')

        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["worker"], "local")
        self.assertEqual(result.stderr, "")

    def test_diagnostics_round_trip_is_jsonl_and_does_not_need_a_job(self) -> None:
        result = self.run_worker('{"type":"diagnostics"}\n')

        self.assertEqual(result.returncode, 0)
        event = json.loads(result.stdout)
        self.assertEqual(event["type"], "diagnostics")
        self.assertEqual(event["runtime"][0]["component"], "yt-dlp")

    def test_invalid_json_returns_typed_error_and_nonzero_exit(self) -> None:
        result = self.run_worker("not-json\n")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["code"], "INVALID_JSON")

    def test_start_job_streams_started_then_input_error(self) -> None:
        message = valid_message()
        message["source"] = {
            "kind": "local_file",
            "inputPath": "/definitely/missing/Bài học.mp4",
        }
        result = self.run_worker(json.dumps(message, ensure_ascii=False) + "\n")

        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[0]["type"], "job_started")
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["code"], "INVALID_INPUT")
        self.assertEqual(
            len([event for event in events if event["type"] in {"completed", "error"}]),
            1,
        )


if __name__ == "__main__":
    unittest.main()
