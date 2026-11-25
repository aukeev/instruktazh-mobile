# Сервер журнала инструктажей. Сборка из корня репозитория:
#   docker compose -f server/docker-compose.yml up -d --build
FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Almaty \
    DB_FILE=/data/journal.sqlite BACKUP_DIR=/backups \
    PUBLIC_DIR=/app/public ADMIN_DIR=/app/admin AI_DIR=/app/public/ai PORT=8080
WORKDIR /app
# библиотека Anthropic для ИИ-помощника (единственная внешняя зависимость)
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/store.js server/server.js server/cli.js server/ai.js ./
COPY server/admin ./admin
# мобильное приложение и журнал раздаются этим же сервером
COPY index.html app.js sigex.js sw.js manifest.webmanifest icon.svg icon-192.png icon-512.png ./public/
COPY journal ./public/journal
# ИИ-помощник: тестовая страница /ai/, обезличивание, база знаний (Правила № 1019)
COPY ai ./public/ai
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
EXPOSE 8080
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--no-warnings", "server.js"]
