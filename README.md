# vlive-docs-server

Dashboard nhỏ chạy tại `api-docs-mobile.vtvlive.vn` để xem GitHub Releases của `nguynninh/vlive-docs` và deploy một tag như `/v1.1.1`.

## Chạy local

```bash
cp .env.example .env
npm run check
npm start
```

Mở `http://127.0.0.1:3001`, nhập `CICD_TOKEN` để login.

## Deploy lên server

```bash
rsync -av --exclude .env --exclude .git ./ root@10.53.10.14:/home/vtvlive/vlive-docs-server/
ssh root@10.53.10.14
cd /home/vtvlive/vlive-docs-server
cp .env.example .env
chmod 600 .env
chmod +x scripts/deploy.sh
cp systemd/vlive-cicd.service /etc/systemd/system/vlive-cicd.service
systemctl daemon-reload
systemctl enable --now vlive-cicd
```

Đổi `CICD_TOKEN` trong `/home/vtvlive/vlive-docs-server/.env` trước khi mở public.
