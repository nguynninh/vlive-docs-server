#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"
APP_DIR="${APP_DIR:-/home/vtvlive/vlive-docs}"
PM2_APP="${PM2_APP:-vlive-docs}"

TAG="${TAG#/}"

if [[ ! "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$ ]]; then
  echo "Invalid tag: $TAG"
  exit 2
fi

exec 9>/home/vtvlive/cicd/deploy.lock
flock -n 9 || { echo "Another deploy is running"; exit 3; }

cd "$APP_DIR"

echo "Deploying $TAG in $APP_DIR"
git fetch --tags origin
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null
git checkout --detach "refs/tags/$TAG"
npm ci
npm run build
pm2 restart "$PM2_APP" --update-env
pm2 save
echo "Deployed $TAG"
