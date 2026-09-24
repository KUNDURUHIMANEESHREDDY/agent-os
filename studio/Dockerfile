# Studio API isolation image. Unverified here (no Docker daemon on this host):
# build with `docker build -f studio/Dockerfile agent-os` on a machine with Docker.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /srv/studio

# Prod deps only; sqlite3 ships prebuilds for linux/x64 (no toolchain needed).
COPY studio/server/package.json studio/server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY studio/server/src ./src

# Drop root: use the image's built-in unprivileged user.
USER node

EXPOSE 5000
# Fail closed without AGENT_OS_TOKEN (compose passes it via env_file).
CMD ["node", "src/server.js"]
