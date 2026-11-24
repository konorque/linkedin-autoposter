#!/usr/bin/env bash
# Первичная настройка сервера Oracle Cloud (Ubuntu 22.04/24.04).
# Запуск: bash setup.sh
set -euo pipefail

echo "== 1. Swap 2 GB (страховка от нехватки памяти) =="
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "== 2. Открываем порты 80/443 (образы Ubuntu в Oracle блокируют их в iptables) =="
sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save

echo "== 3. Docker =="
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "== 4. Файл .env =="
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^N8N_ENCRYPTION_KEY=.*/N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
fi

if ! grep -q '^N8N_DOMAIN=.\+' .env; then
  echo "Впиши свой домен в .env (строка N8N_DOMAIN=...), затем запусти:"
  echo "  sudo docker compose up -d"
  exit 0
fi

echo "== 5. Запуск =="
sudo docker compose up -d
echo "Готово. Открой https://$(grep '^N8N_DOMAIN=' .env | cut -d= -f2)"
