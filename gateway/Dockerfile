FROM node:20-slim

ENV NODE_ENV=production \
    OPENCODE_CLI=opencode \
    OPENCODE_AGENT=overlord-model \
    OPENCODE_WORKDIR=/srv/agent-os

# Pin the CLI rather than silently receiving new runtime behavior on rebuild.
RUN npm install --global --no-audit --no-fund opencode-ai@1.19.5

WORKDIR /srv/agent-os
COPY gateway/llm-gateway.js ./gateway/llm-gateway.js
COPY gateway/opencode-client.js ./gateway/opencode-client.js
COPY .opencode/agents/overlord-model.md ./.opencode/agents/overlord-model.md

USER node
EXPOSE 20129
CMD ["node", "gateway/llm-gateway.js"]
