# Сервер журнала инструктажей. Сборка из корня репозитория:
#   docker compose -f server/docker-compose.yml up -d --build
FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Almaty \
    DB_FILE=/data/journal.sqlite BACKUP_DIR=/backups \
    PUBLIC_DIR=/app/public ADMIN_DIR=/app/admin PORT=8080
WORKDIR /app
COPY server/store.js server/server.js server/cli.js ./
COPY server/admin ./admin
# мобильное приложение и журнал раздаются этим же сервером
COPY index.html app.js sigex.js sw.js manifest.webmanifest icon.svg icon-192.png icon-512.png ./public/
COPY journal ./public/journal
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
EXPOSE 8080
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--no-warnings", "server.js"]
