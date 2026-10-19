# Optional. The app is local-first; Docker is only a convenience.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npx tsc && npx playwright install --with-deps chromium
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/server.js"]
