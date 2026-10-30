# UNTESTED in my sandbox (no Docker available) - build and verify before relying on it.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY frontend/package.json frontend/
COPY backend/package.json backend/
COPY database/package.json database/
COPY backtest/package.json backtest/
RUN npm ci --no-audit --no-fund
COPY . .
RUN CI=false GENERATE_SOURCEMAP=false npm run build -w tgg-frontend

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN npm prune --omit=dev && mkdir -p /data/fyers && chown -R node:node /data /app
USER node
EXPOSE 9003
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:'+(process.env.PORT||9003)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--max-old-space-size=1536","backend/src/server.js"]
