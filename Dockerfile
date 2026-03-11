FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && npx playwright install --with-deps chromium \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --production

COPY src/ src/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3001/api/health || exit 1

CMD ["node", "src/server.mjs"]

LABEL org.opencontainers.image.source=https://github.com/rvben/yoobi-api
LABEL org.opencontainers.image.description="Yoobi timesheet API via browser automation"
