#!/bin/sh
# Установка сервера журнала на чистую виртуальную машину Ubuntu 22.04/24.04.
# Запуск:  sudo sh install.sh journal.example.kz
set -e
DOMAIN="$1"
if [ -z "$DOMAIN" ]; then echo "Укажите домен: sudo sh install.sh journal.example.kz"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "Запустите через sudo"; exit 1; fi
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "== Устанавливаю Docker"
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
  systemctl enable --now docker
fi

echo "== Настройка"
[ -f .env ] || cp .env.example .env
sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" .env
mkdir -p data backups
chown 1000:1000 data backups   # пользователь node внутри контейнера

if command -v ufw >/dev/null 2>&1; then ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null; fi

echo "== Запуск"
docker compose up -d --build
sleep 5
if docker compose exec -T app node cli.js users | grep -q admin; then
  echo "Администратор уже есть."
else
  docker compose exec -T app node cli.js create-admin admin "Администратор"
fi
echo
echo "Готово. Откройте https://$DOMAIN/admin/ и войдите как admin с паролем выше."
echo "Приложение для телефона: https://$DOMAIN/   Журнал: https://$DOMAIN/journal/"
