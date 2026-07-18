from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.whispersub_worker.protocol import parse_start_job
from worker.whispersub_worker.whisper_engine import WhisperEngine


def start_job_message(input_path: Path, source_language: str) -> dict[str, object]:
    return {
        "type": "start_job",
        "jobId": "job_language_options",
        "inputPath": str(input_path),
        "outputLocationMode": "same_as_input",
        "outputDirectory": None,
        "model": "small",
        "sourceLanguage": source_language,
        "task": "transcribe",
        "translationProvider": "none",
        "device": "auto",
        "outputFormats": ["srt"],
        "overwritePolicy": "suffix",
    }


class FakeModel:
    def __init__(self) -> None:
        self.options: dict[str, object] | None = None

    def transcribe(self, _input_path: str, **options: object) -> dict[str, object]:
        self.options = options
        return {"segments": []}


class WhisperEngineLanguageOptionsTest(unittest.TestCase):
    def test_auto_omits_language_while_explicit_sources_reach_whisper(self) -> None:
        cases = (("auto", None), ("vi", "vi"), ("en", "en"))

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "mixed-language.mp4"
            input_path.write_bytes(b"media fixture")

            for source_language, expected_language in cases:
                with self.subTest(source_language=source_language):
                    model = FakeModel()
                    fake_torch = types.SimpleNamespace(
                        backends=types.SimpleNamespace(
                            mps=types.SimpleNamespace(is_available=lambda: False)
                        )
                    )
                    fake_whisper = types.SimpleNamespace(
                        load_model=lambda _model_name, device: model
                    )
                    request = parse_start_job(
                        start_job_message(input_path, source_language)
                    )

                    with (
                        patch(
                            "worker.whispersub_worker.whisper_engine.shutil.which",
                            return_value="/fake/ffmpeg",
                        ),
                        patch.dict(
                            sys.modules,
                            {"torch": fake_torch, "whisper": fake_whisper},
                        ),
                    ):
                        WhisperEngine().transcribe(request, lambda _event: None)

                    self.assertIsNotNone(model.options)
                    assert model.options is not None
                    self.assertEqual(model.options["task"], "transcribe")
                    if expected_language is None:
                        self.assertNotIn("language", model.options)
                    else:
                        self.assertEqual(
                            model.options["language"], expected_language
                        )


if __name__ == "__main__":
    unittest.main()
