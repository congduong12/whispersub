from __future__ import annotations

import sys
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.whispersub_worker.protocol import WorkerError, parse_start_job
from worker.whispersub_worker.whisper_engine import WhisperEngine


def start_job_message(input_path: Path, source_language: str) -> dict[str, object]:
    return {
        "type": "start_job",
        "jobId": "job_language_options",
        "source": {"kind": "local_file", "inputPath": str(input_path)},
        "workspacePath": "/tmp/whispersub-test-workspace",
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

    def test_youtube_auto_detects_from_bounded_sample_and_transcribes_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "youtube-audio.webm"
            input_path.write_bytes(b"audio fixture")
            request = parse_start_job(start_job_message(input_path, "auto"))
            calls: dict[str, object] = {"loads": 0, "transcribes": 0}
            events: list[dict[str, object]] = []

            class AutoModel(FakeModel):
                dims = types.SimpleNamespace(n_mels=80)

                def detect_language(self, _mel):
                    return 0, {"vi": 0.91, "en": 0.09}

                def transcribe(self, _input_path: str, **options: object) -> dict[str, object]:
                    calls["transcribes"] = int(calls["transcribes"]) + 1
                    self.options = options
                    return {
                        "language": "vi",
                        "segments": [{"id": 0, "start": 0, "end": 1, "text": "Xin chào"}],
                    }

            model = AutoModel()

            def load_model(_model_name: str, device: str):
                calls["loads"] = int(calls["loads"]) + 1
                calls["device"] = device
                return model

            fake_torch = types.SimpleNamespace(
                backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
            )
            fake_whisper = types.SimpleNamespace(
                load_model=load_model,
                load_audio=lambda _path: self.fail(
                    "YouTube language detection must not load the entire input file"
                ),
                pad_or_trim=lambda audio, *, length: calls.update(
                    {"sample_source": audio, "sample_length": length}
                ) or "bounded-audio",
                log_mel_spectrogram=lambda audio, *, n_mels, device: calls.update(
                    {"mel_source": audio, "n_mels": n_mels, "mel_device": device}
                ) or "mel",
                audio=types.SimpleNamespace(SAMPLE_RATE=16_000, N_SAMPLES=480_000),
            )

            with (
                patch("worker.whispersub_worker.whisper_engine.shutil.which", return_value="/fake/ffmpeg"),
                patch(
                    "worker.whispersub_worker.whisper_engine.subprocess.run",
                    return_value=types.SimpleNamespace(stdout=b"", stderr=b""),
                ) as run,
                patch.dict(sys.modules, {"torch": fake_torch, "whisper": fake_whisper}),
            ):
                segments, language, origin = WhisperEngine().transcribe_youtube_audio(
                    request,
                    input_path,
                    source_language="auto",
                    emit=events.append,
                )

            self.assertEqual((calls["loads"], calls["transcribes"]), (1, 1))
            command = run.call_args.args[0]
            self.assertEqual(command[0], "/fake/ffmpeg")
            self.assertEqual(command[command.index("-t") + 1], "30")
            self.assertEqual(command[command.index("-ar") + 1], "16000")
            self.assertEqual(calls["sample_length"], 480_000)
            self.assertEqual(model.options["task"], "transcribe")
            self.assertEqual(model.options["language"], "vi")
            self.assertEqual((language, origin, segments[0].text), ("vi", "whisper_transcribe", "Xin chào"))
            self.assertEqual(sum(event.get("type") == "segment" for event in events), 1)

    def test_youtube_auto_translates_non_vietnamese_in_one_full_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "youtube-audio.webm"
            input_path.write_bytes(b"audio fixture")
            request = parse_start_job(start_job_message(input_path, "auto"))
            model = FakeModel()
            model.dims = types.SimpleNamespace(n_mels=80)
            model.detect_language = lambda _mel: (0, {"ja": 0.88, "en": 0.12})
            fake_torch = types.SimpleNamespace(
                backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
            )
            fake_whisper = types.SimpleNamespace(
                load_model=lambda _model_name, device: model,
                load_audio=lambda _path: "full-audio",
                pad_or_trim=lambda _audio, *, length: "bounded-audio",
                log_mel_spectrogram=lambda _audio, *, n_mels, device: "mel",
                audio=types.SimpleNamespace(SAMPLE_RATE=16_000, N_SAMPLES=480_000),
            )

            with (
                patch("worker.whispersub_worker.whisper_engine.shutil.which", return_value="/fake/ffmpeg"),
                patch(
                    "worker.whispersub_worker.whisper_engine.subprocess.run",
                    return_value=types.SimpleNamespace(stdout=b"", stderr=b""),
                ),
                patch.dict(sys.modules, {"torch": fake_torch, "whisper": fake_whisper}),
            ):
                _segments, language, origin = WhisperEngine().transcribe_youtube_audio(
                    request, input_path, source_language="auto", emit=lambda _event: None
                )

            self.assertEqual(model.options["task"], "translate")
            self.assertEqual(model.options["language"], "ja")
            self.assertEqual((language, origin), ("en", "whisper_translate_to_english"))

    def test_youtube_auto_rejects_low_confidence_without_full_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "youtube-audio.webm"
            input_path.write_bytes(b"audio fixture")
            request = parse_start_job(start_job_message(input_path, "auto"))
            model = FakeModel()
            model.dims = types.SimpleNamespace(n_mels=80)
            calls = {"detects": 0}

            def detect_language(_mel):
                calls["detects"] += 1
                return 0, {"vi": 0.79, "en": 0.21}

            model.detect_language = detect_language
            fake_torch = types.SimpleNamespace(
                backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
            )
            fake_whisper = types.SimpleNamespace(
                load_model=lambda _model_name, device: model,
                load_audio=lambda _path: self.fail(
                    "YouTube language detection must not load the entire input file"
                ),
                pad_or_trim=lambda _audio, *, length: "bounded-audio",
                log_mel_spectrogram=lambda _audio, *, n_mels, device: "mel",
                audio=types.SimpleNamespace(SAMPLE_RATE=16_000, N_SAMPLES=480_000),
            )

            with (
                patch("worker.whispersub_worker.whisper_engine.shutil.which", return_value="/fake/ffmpeg"),
                patch(
                    "worker.whispersub_worker.whisper_engine.subprocess.run",
                    return_value=types.SimpleNamespace(stdout=b"", stderr=b""),
                ),
                patch.dict(sys.modules, {"torch": fake_torch, "whisper": fake_whisper}),
                self.assertRaises(WorkerError) as raised,
            ):
                WhisperEngine().transcribe_youtube_audio(
                    request, input_path, source_language="auto", emit=lambda _event: None
                )

            self.assertEqual(raised.exception.code, "SOURCE_LANGUAGE_UNDETERMINED")
            self.assertEqual(calls["detects"], 1)
            self.assertIsNone(model.options)

    def test_youtube_auto_maps_bounded_decode_failure_to_retryable_language_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "youtube-audio.webm"
            input_path.write_bytes(b"audio fixture")
            request = parse_start_job(start_job_message(input_path, "auto"))
            model = FakeModel()
            fake_torch = types.SimpleNamespace(
                backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
            )
            fake_whisper = types.SimpleNamespace(
                load_model=lambda _model_name, device: model,
                audio=types.SimpleNamespace(SAMPLE_RATE=16_000, N_SAMPLES=480_000),
            )

            with (
                patch("worker.whispersub_worker.whisper_engine.shutil.which", return_value="/fake/ffmpeg"),
                patch(
                    "worker.whispersub_worker.whisper_engine.subprocess.run",
                    side_effect=subprocess.CalledProcessError(1, ["/fake/ffmpeg"]),
                ),
                patch.dict(sys.modules, {"torch": fake_torch, "whisper": fake_whisper}),
                self.assertRaises(WorkerError) as raised,
            ):
                WhisperEngine().transcribe_youtube_audio(
                    request, input_path, source_language="auto", emit=lambda _event: None
                )

            self.assertEqual(raised.exception.code, "SOURCE_LANGUAGE_UNDETERMINED")
            self.assertTrue(raised.exception.retryable)
            self.assertIsNone(model.options)


if __name__ == "__main__":
    unittest.main()
