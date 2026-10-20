# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:ui

# ---- runtime stage ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    AGENT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787 \
    NO_OPEN=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-v2/dist ./web-v2/dist
COPY package.json ./
# headless Chromium + its system libraries
RUN npx playwright install --with-deps chromium \
 && mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
# /data must be a persistent volume: it holds the SQLite DB, settings, and the browser profile
CMD ["node", "dist/src2/server.js"]
