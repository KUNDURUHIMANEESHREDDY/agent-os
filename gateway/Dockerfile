FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /srv/gateway
COPY gateway/llm-gateway.js ./
USER node
EXPOSE 20129
CMD ["node", "llm-gateway.js"]
