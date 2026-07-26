#!/bin/bash
set -e

echo "=== Setting up pnpm (writable prefix) ==="
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
mkdir -p "$PNPM_HOME"

# corepack is pre-installed on Render — use it to activate pnpm@9
corepack enable pnpm
corepack prepare pnpm@9.15.9 --activate

echo "=== pnpm version ==="
pnpm --version

echo "=== Installing dependencies ==="
pnpm install --no-frozen-lockfile

echo "=== Building navigated app ==="
PORT=19477 BASE_PATH=/ pnpm --filter @workspace/navigated run build

echo "=== Build complete ==="
ls -la artifacts/navigated/dist/public/ 2>/dev/null || echo "Warning: dist/public not found"
