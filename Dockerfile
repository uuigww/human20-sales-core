FROM node:24-alpine

WORKDIR /app

# Сначала манифесты (для кэша слоёв и линковки workspace-пакета)
COPY package.json package-lock.json ./
COPY packages/ssot/package.json packages/ssot/package.json
RUN npm ci

# Затем исходники
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Запуск через tsx (TS без сборки)
CMD ["npm", "start"]
