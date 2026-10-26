#!/usr/bin/env bash
set -euo pipefail

# Setup target: Linux + NVIDIA CUDA GPU with >=24GB VRAM, as specified by TRELLIS.2.
# Run this on the rented GPU machine, not on an Android phone or static web host.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRELLIS_DIR="${TRELLIS2_ROOT:-$PROJECT_ROOT/TRELLIS.2}"

if ! command -v git >/dev/null 2>&1; then
  echo "Missing git. Install git before running this script." >&2; exit 1
fi
if ! command -v conda >/dev/null 2>&1; then
  echo "Missing conda. Install Miniconda/Anaconda, then open a new shell." >&2; exit 1
fi
if command -v conda >/dev/null 2>&1; then
  CONDA_BASE="$(conda info --base)"
  # Initialize conda for this non-interactive shell before the official setup script.
  # shellcheck disable=SC1091
  source "$CONDA_BASE/etc/profile.d/conda.sh"
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "Warning: nvidia-smi not found. Confirm the host actually provides an NVIDIA GPU." >&2
else
  nvidia-smi
fi

if [[ ! -d "$TRELLIS_DIR/.git" ]]; then
  git clone --recursive https://github.com/microsoft/TRELLIS.2.git "$TRELLIS_DIR"
else
  echo "Using existing TRELLIS.2 checkout: $TRELLIS_DIR"
fi

cd "$TRELLIS_DIR"
# The official setup script creates/uses a conda env named 'trellis2'.
# This compiles CUDA-dependent packages, and can take a while.
source ./setup.sh --new-env --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm

conda run -n trellis2 python -m pip install -r "$PROJECT_ROOT/backend/requirements.txt"

mkdir -p "$PROJECT_ROOT/data/uploads" "$PROJECT_ROOT/data/results"
cat <<EOF

TRELLIS.2 dependencies are installed.
Next:
  1. cd "$PROJECT_ROOT"
  2. cp .env.example .env   # then edit paths and APP_ACCESS_KEY
  3. ./scripts/start_gpu.sh

First generation downloads the TRELLIS.2-4B model weights from Hugging Face if not cached.
EOF
