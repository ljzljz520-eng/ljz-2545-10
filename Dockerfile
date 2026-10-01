# 可部署后端镜像
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY db ./db
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
