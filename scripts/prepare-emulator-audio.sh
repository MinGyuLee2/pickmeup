#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${PICKMEUP_ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
PYTHON="${PICKMEUP_PYTHON:-python3}"
VENV="$ROOT/.local/audio-venv"
if [ ! -x "$VENV/bin/python" ]; then "$PYTHON" -m venv "$VENV"; fi
"$VENV/bin/python" -m pip install -r "$ROOT/scripts/audio-requirements.txt"
mkdir -p "$ROOT/.local/emulator-proto"
"$VENV/bin/python" - "$SDK" "$ROOT" <<'PY'
from pathlib import Path
import grpc_tools
import subprocess
import sys
sdk, root = map(Path, sys.argv[1:])
subprocess.run([sys.executable, '-m', 'grpc_tools.protoc',
    '-I'+str(sdk/'emulator/lib'), '-I'+str(Path(grpc_tools.__file__).parent/'_proto'),
    '--python_out='+str(root/'.local/emulator-proto'),
    '--grpc_python_out='+str(root/'.local/emulator-proto'),
    str(sdk/'emulator/lib/emulator_controller.proto')], check=True)
PY
