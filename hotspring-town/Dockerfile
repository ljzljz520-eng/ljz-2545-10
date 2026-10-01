FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# 无 lockfile 时安装生产依赖（express 与 pg；pg-mem 仅开发/零安装模式用，一并装上以支持 DATABASE_URL 缺省）
RUN npm install --omit=dev || npm install
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# 启动时自动建表；places 已有数据时跳过种子
CMD ["node", "src/server/index.js"]
