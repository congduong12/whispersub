from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 4_000_000


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


Transport = Callable[[Request, float], HttpResponse]


class ProviderTransportError(RuntimeError):
    pass


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def header(headers: Mapping[str, str], name: str) -> str | None:
    return next((value for key, value in headers.items() if key.lower() == name), None)


def default_transport(request: Request, timeout: float) -> HttpResponse:
    opener = build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ProviderTransportError("provider response is too large")
            return HttpResponse(response.status, dict(response.headers.items()), body)
    except HTTPError as error:
        body = error.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            body = b""
        return HttpResponse(error.code, dict(error.headers.items()), body)
    except (TimeoutError, URLError, OSError) as error:
        raise ProviderTransportError("provider request failed") from error
