"""Sandbox-safe LibreOffice headless wrapper.

LibreOffice's defaults assume an interactive desktop session: a persistent
user profile under ~/.config/libreoffice with lockfiles, recovery dialogs,
first-start wizards, and dbus integration that depends on /etc/machine-id.
None of that is friendly to a hardened, parallel-invocation sandbox.

The `convert_to_pdf` helper here neutralises those by routing every soffice
invocation through a fresh per-call user profile and suppressing the
interactive cruft.
"""

import os
import subprocess
import tempfile
from pathlib import Path


def convert_to_pdf(src: Path, out_dir: Path, *, timeout: float = 180.0) -> Path:
    """Convert `src` to PDF inside `out_dir`. Returns the resulting PDF path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lo_profile_") as profile:
        env = {
            **os.environ,
            "HOME": profile,
            "SAL_USE_COMMON_ONE_INSTANCE": "1",
            "LC_ALL": os.environ.get("LC_ALL", "en_US.UTF-8"),
        }
        cmd = [
            "soffice",
            "--headless",
            "--norestore",
            "--nofirststartwizard",
            "--nolockcheck",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(out_dir),
            str(src),
        ]
        result = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(
            f"soffice failed (exit {result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    pdf_path = out_dir / (src.stem + ".pdf")
    if not pdf_path.exists():
        raise RuntimeError(
            f"soffice succeeded but expected PDF not found at {pdf_path}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return pdf_path
