FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci && npx playwright install --with-deps chromium
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && mkdir -p /app/workspace /app/.browser_profiles /app/playwright/.auth /app/artifacts && chown -R node:node /app
USER node
ENV BROWSER_HEADLESS=true
CMD ["npm", "start", "--", "status"]
