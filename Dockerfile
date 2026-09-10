# syntax=docker/dockerfile:1

# ── build ────────────────────────────────────────────────────────────────────
# The toolchain lives here so native modules (@discordjs/opus, better-sqlite3,
# @snazzah/davey) never have to compile on the deployment host. On an older
# machine that is the difference between a working install and an afternoon of
# build errors.
FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies but keep the compiled native modules.
RUN npm prune --omit=dev


# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Never run as root: this process handles other people's voice data.
RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin birdeye

COPY --from=build --chown=birdeye:birdeye /app/node_modules ./node_modules
COPY --from=build --chown=birdeye:birdeye /app/dist ./dist
COPY --chown=birdeye:birdeye package.json ./
COPY --chown=birdeye:birdeye config/moderation.example.json ./config/moderation.example.json
COPY --chown=birdeye:birdeye docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data /app/violation-audio \
    && chown -R birdeye:birdeye /app/data /app/violation-audio /app/config \
    && chmod 700 /app/data /app/violation-audio

USER birdeye

# No ports are exposed. Evidence audio is deliberately never reachable over
# HTTP; the bot serves nothing.

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
