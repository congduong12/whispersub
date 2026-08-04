from __future__ import annotations

import importlib.metadata
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RuntimeDiagnostic:
    component: str
    status: str
    expected: str
    found: str | None
    required_for: str


PackageVersion = Callable[[str], str]
Which = Callable[[str], str | None]
CommandRunner = Callable[[list[str]], str | None]


def collect_youtube_runtime_diagnostics(
    *,
    package_version: PackageVersion = importlib.metadata.version,
    which: Which = shutil.which,
    run_command: CommandRunner | None = None,
) -> list[RuntimeDiagnostic]:
    """Return a stable, secret-free snapshot of YouTube runtime prerequisites.

    Deno is conditional: yt-dlp only asks for a JavaScript runtime on some
    extraction paths. The diagnostic deliberately reports it without blocking a
    caption-only route that does not need JavaScript.
    """

    runner = run_command or _read_version_line
    diagnostics = [
        _package_diagnostic("yt-dlp", "2026.06.09", "YouTube metadata and downloads", package_version),
        _package_diagnostic("yt-dlp-ejs", "0.8.0", "YouTube JavaScript extraction paths", package_version),
        _tool_diagnostic("ffmpeg", "8.1.2", "local Whisper audio decode", which, runner),
        _tool_diagnostic("ffprobe", "8.1.2", "media inspection and audio fallback", which, runner),
        _tool_diagnostic("deno", "2.8.1", "conditional yt-dlp JavaScript extraction", which, runner),
    ]
    return diagnostics


def diagnostics_event() -> dict[str, object]:
    return {
        "type": "diagnostics",
        "runtime": [asdict(item) for item in collect_youtube_runtime_diagnostics()],
    }


def _package_diagnostic(
    component: str,
    expected: str,
    required_for: str,
    package_version: PackageVersion,
) -> RuntimeDiagnostic:
    try:
        found = package_version(component)
    except importlib.metadata.PackageNotFoundError:
        return RuntimeDiagnostic(component, "missing", expected, None, required_for)
    return RuntimeDiagnostic(
        component,
        "ready" if _versions_match(found, expected) else "mismatch",
        expected,
        found,
        required_for,
    )


def _tool_diagnostic(
    component: str,
    expected: str,
    required_for: str,
    which: Which,
    run_command: CommandRunner,
) -> RuntimeDiagnostic:
    executable = which(component)
    if executable is None:
        return RuntimeDiagnostic(component, "missing", expected, None, required_for)
    version_flag = "-version" if component in {"ffmpeg", "ffprobe"} else "--version"
    found = run_command([executable, version_flag])
    if found is None:
        return RuntimeDiagnostic(component, "unavailable", expected, None, required_for)
    return RuntimeDiagnostic(
        component,
        "ready" if _versions_match(_version_from_line(found), expected) else "mismatch",
        expected,
        _version_from_line(found),
        required_for,
    )


def _read_version_line(command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    output = (completed.stdout or completed.stderr).splitlines()
    return output[0].strip() if completed.returncode == 0 and output else None


def _version_from_line(line: str) -> str:
    for token in line.replace("/", " ").split():
        if token and token[0].isdigit() and any(character.isdigit() for character in token):
            return token.rstrip(",;)")
    return line


def _versions_match(found: str, expected: str) -> bool:
    def numeric(value: str) -> tuple[int, ...] | None:
        pieces = value.split(".")
        if not pieces or any(not piece.isdigit() for piece in pieces):
            return None
        return tuple(int(piece) for piece in pieces)

    found_numbers = numeric(found)
    expected_numbers = numeric(expected)
    return (
        found == expected
        if found_numbers is None or expected_numbers is None
        else found_numbers == expected_numbers
    )
