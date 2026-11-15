# QualityPilot — Autonomous QualityPilot
# Build:  docker build -t qualitypilot .
# Run:    docker run -p 8080:8080 --env-file .env -v "$(pwd)/data:/app/data" qualitypilot

FROM node:20-slim

WORKDIR /app

# Install native dependencies for SQLite compilation and Playwright dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install npm dependencies (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Shared, non-root-readable location for the Playwright browsers — the
# runtime user (below) must be able to launch them.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Playwright browser + OS dependencies
RUN npx playwright install --with-deps chromium

# App source and scripts
COPY dashboard ./dashboard
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV SQA_DASHBOARD_PORT=8080
# NOTE: SQA_CHROMIUM_NO_SANDBOX is deliberately NOT set — sandboxed Chromium
# is safer. Docker deployments that cannot run the sandbox should enable
# CAP_SYS_ADMIN in docker-compose.yml instead of disabling the sandbox.

# Non-root runtime user; /app/data is the volume mount (SQLite database,
# reports, screenshots, session keys) and must be writable by it.
RUN useradd -m appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app/data /opt/ms-playwright

USER appuser
EXPOSE 8080

# Results and SQLite database persist in the mounted /app/data volume
CMD ["node", "dashboard/server.js"]
