"""子服包版本（与 pyproject.toml 对齐）。"""

from __future__ import annotations

try:
    from importlib.metadata import version as _pkg_version

    PACKAGE_VERSION = _pkg_version("xrk-agt-pyserver")
except Exception:
    PACKAGE_VERSION = "1.1.0"
