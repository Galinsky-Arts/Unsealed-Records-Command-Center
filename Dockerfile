FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src/ ./src/
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node src/bff/ ./src/bff/
COPY --chown=node:node src/server/ ./src/server/
COPY --chown=node:node scripts/start-production.mjs scripts/production-config.mjs ./scripts/
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "scripts/start-production.mjs"]
