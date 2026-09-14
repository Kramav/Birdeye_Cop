#!/usr/bin/env bash
#
# One-shot installer for a Debian/Ubuntu host or Proxmox LXC.
#
# Idempotent: safe to re-run to upgrade an existing install.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/Birdeye_Cop/main/scripts/install.sh | sudo bash
# or, from a clone:
#   sudo ./scripts/install.sh
#
set -euo pipefail

APP_USER="${APP_USER:-birdeye}"
APP_DIR="${APP_DIR:-/opt/birdeye-cop}"
NODE_MAJOR="${NODE_MAJOR:-22}"
REPO_URL="${REPO_URL:-https://github.com/kramav/Birdeye_Cop.git}"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[90m'; RESET=$'\033[0m'
step() { echo -e "\n${BOLD}==> $*${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root (it creates a system user and a systemd unit)." >&2
  echo "Re-run with: sudo $0" >&2
  exit 1
fi

step "Checking the base system"
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer targets Debian/Ubuntu. On another distro, follow the manual" >&2
  echo "steps in the README's Deployment section." >&2
  exit 1
fi
ok "apt-based system detected"

step "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# git/curl to fetch; build-essential+python3 so that if a prebuilt binary is
# missing for this platform, the native modules can still compile rather than
# failing the install outright.
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git build-essential python3 pkg-config cmake
ok "base packages installed"

step "Ensuring Node.js >= ${NODE_MAJOR}.12"
needs_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -p 'process.versions.node')"
  major="${current%%.*}"
  minor="$(echo "$current" | cut -d. -f2)"
  if (( major > NODE_MAJOR )) || { (( major == NODE_MAJOR )) && (( minor >= 12 )); }; then
    needs_node=0
    ok "Node v${current} already present"
  else
    warn "Node v${current} is too old (@discordjs/voice requires >= 22.12)"
  fi
fi

if (( needs_node )); then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
  ok "Node $(node -p 'process.versions.node') installed"
fi

step "Creating the service user"
if id "$APP_USER" >/dev/null 2>&1; then
  ok "user ${APP_USER} already exists"
else
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
          --shell /usr/sbin/nologin "$APP_USER"
  ok "created system user ${APP_USER}"
fi

step "Fetching the application into ${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  # As the owner: git refuses to operate on another user's checkout as root.
  runuser -u "$APP_USER" -- git -C "$APP_DIR" pull --ff-only
  ok "updated existing checkout"
elif [[ -f "${APP_DIR}/package.json" ]]; then
  ok "existing non-git install found; leaving files alone"
else
  mkdir -p "$APP_DIR"
  if [[ -f "$(dirname "$0")/../package.json" ]]; then
    cp -r "$(dirname "$0")/../." "$APP_DIR/"
    ok "copied from the local checkout"
  else
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
    ok "cloned ${REPO_URL}"
  fi
fi

step "Installing dependencies and building"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
ok "built to ${APP_DIR}/dist"

# The optional native modules are the usual failure point. Say plainly which
# ones are active rather than letting the operator discover it at runtime.
step "Verifying native modules"
node -e "
for (const m of ['@snazzah/davey','prism-media','@discordjs/opus','better-sqlite3','opusscript']) {
  try { require.resolve(m); console.log('  ✓ ' + m); }
  catch { console.log('  ! ' + m + ' unavailable (a fallback will be used)'); }
}" || true

step "Preparing runtime directories"
mkdir -p "${APP_DIR}/data" "${APP_DIR}/violation-audio" "${APP_DIR}/config"
if [[ ! -f "${APP_DIR}/config/moderation.json" ]]; then
  cp "${APP_DIR}/config/moderation.example.json" "${APP_DIR}/config/moderation.json"
  ok "seeded config/moderation.json (placeholder rules only)"
fi
chown -R "${APP_USER}:${APP_USER}" "$APP_DIR"
chmod 700 "${APP_DIR}/data" "${APP_DIR}/violation-audio"
ok "runtime directories ready"

step "Installing the systemd unit"
install -m 0644 "${APP_DIR}/deploy/birdeye-cop.service" /etc/systemd/system/birdeye-cop.service
install -m 0644 "${APP_DIR}/deploy/birdeye-whisper.service" /etc/systemd/system/birdeye-whisper.service
systemctl daemon-reload
ok "birdeye-cop.service installed"

# Local speech-to-text: opt in with WITH_WHISPER=1; upgrades keep it once enabled.
if [[ "${WITH_WHISPER:-0}" == 1 ]] || systemctl is-enabled --quiet birdeye-whisper 2>/dev/null; then
  step "Building local whisper.cpp (the first build takes a few minutes)"
  runuser -u "$APP_USER" -- env WHISPER_DIR="${APP_DIR}/whisper.cpp" \
    bash "${APP_DIR}/scripts/whisper-server.sh" --build-only
  systemctl enable birdeye-whisper
  ok "birdeye-whisper.service enabled — starts, stops, and restarts with the bot"
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo
  echo -e "${BOLD}Almost there — the bot is not configured yet.${RESET}"
  echo
  echo "  1. Configure it:"
  echo -e "       ${DIM}cd ${APP_DIR} && sudo -u ${APP_USER} npm run setup${RESET}"
  echo "  2. Check it:"
  echo -e "       ${DIM}sudo -u ${APP_USER} npm run doctor${RESET}"
  echo "  3. Start it:"
  echo -e "       ${DIM}sudo systemctl enable --now birdeye-cop${RESET}"
  echo
  echo -e "${YELLOW}Read the README's \"Legal and consent\" section before pointing this at"
  echo -e "real users.${RESET}"
  echo
else
  chmod 600 "${APP_DIR}/.env"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
  systemctl restart birdeye-cop 2>/dev/null || true
  echo
  ok "Existing .env kept. Service restarted."
  echo -e "  ${DIM}journalctl -u birdeye-cop -f${RESET}"
  echo
fi
