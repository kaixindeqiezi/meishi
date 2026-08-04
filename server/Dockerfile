FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/douyin-api.mjs ./douyin-api.mjs
COPY server/db.mjs ./db.mjs
COPY server/receipt-service.mjs ./receipt-service.mjs
COPY server/label-service.mjs ./label-service.mjs
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4320
CMD ["node", "--experimental-sqlite", "douyin-api.mjs"]
