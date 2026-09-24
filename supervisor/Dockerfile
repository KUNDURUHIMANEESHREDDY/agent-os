FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /srv/supervisor
COPY supervisor/server.js supervisor/skills-lock.json ./
COPY supervisor/public ./public
COPY supervisor/.agents ./.agents
COPY supervisor/demos ./demos
USER node
EXPOSE 3000
CMD ["node", "server.js"]
