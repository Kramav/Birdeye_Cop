#!/usr/bin/env bash
#
# Build (first run only) and start a local whisper.cpp server the bot can use.
#
#   npm run whisper                      # foreground, for trying it out
#   bash scripts/whisper-server.sh --build-only
#   WHISPER_MODEL=small.en WHISPER_HOST=0.0.0.0 npm run whisper
#
# On a systemd install, deploy/birdeye-whisper.service runs this instead.
# Then in .env:  STT_PROVIDER=openai  STT_BASE_URL=http://localhost:8080/v1  STT_MODEL=base.en
#
set -euo pipefail

DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
MODEL="${WHISPER_MODEL:-base.en}"
HOST="${WHISPER_HOST:-127.0.0.1}"
PORT="${WHISPER_PORT:-8080}"

if [[ ! -x "$DIR/build/bin/whisper-server" ]]; then
  for tool in git cmake c++; do
    command -v "$tool" >/dev/null || { echo "Missing $tool: sudo apt install -y git cmake build-essential" >&2; exit 1; }
  done
  [[ -d "$DIR" ]] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$DIR"
  cmake -S "$DIR" -B "$DIR/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$DIR/build" -j --config Release --target whisper-server
fi

[[ -f "$DIR/models/ggml-$MODEL.bin" ]] || sh "$DIR/models/download-ggml-model.sh" "$MODEL" "$DIR/models"

[[ "${1:-}" == --build-only ]] && exit 0

# whisper-server serves /inference by default; the bot speaks OpenAI's API.
exec "$DIR/build/bin/whisper-server" \
  --model "$DIR/models/ggml-$MODEL.bin" \
  --host "$HOST" --port "$PORT" \
  --inference-path /v1/audio/transcriptions
