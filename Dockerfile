FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/data/storage

ENV NODE_ENV=production
ENV APP_HOST=0.0.0.0
ENV APP_PORT=3088
ENV DB_DRIVER=sqlite
ENV SQLITE_PATH=/app/data/iso-watcher.db
ENV STORAGE_ROOT=/app/data/storage
ENV SCAN_STARTUP_RECOVERY=interrupt

EXPOSE 3088

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
