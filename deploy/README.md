# VPS 部署说明

重复部署可以直接使用 Codex 的 `vps-deploy` Skill。它从本机的 `C:\Users\Administrator\.codex\vps-deploy-config.json` 读取服务器元数据，再通过 SSH 拉取指定分支并重启 Docker Compose，不需要每次重新描述服务器。

当前项目可以拆成两部分部署：

- `designs/food-flow`：静态前端，可放 GitHub Pages
- `server/douyin-api.mjs`：后端接口，放 VPS 或其他 Node.js 云服务

## VPS 拉取并启动

```bash
git clone <你的 GitHub 仓库地址> food-flow
cd food-flow
git checkout codex/vps-deploy
cp .env.example .env
# 编辑 .env，填写经过授权的 DOUYIN_PROVIDER_URL 和 DOUYIN_PROVIDER_TOKEN
node --experimental-sqlite server/douyin-api.mjs
```

仓库当前的远程默认分支可能不是部署分支；生产环境必须明确检出包含部署配置的分支（例如 `codex/vps-deploy`），不要直接依赖 `origin/HEAD`。

生产环境建议用反向代理提供 HTTPS，并把前端的 AI 接口地址设置为：

```text
https://你的域名/api/douyin/parse
```

不要把 `.env`、API Key 或会员密钥提交到 GitHub。当前前端设置页是个人测试 / 会员功能预览，正式版本应把密钥保存到后端数据库或密钥管理服务。

## Docker

```bash
docker build -t foodflow-api -f server/Dockerfile .
docker run --env-file .env -p ${FOODFLOW_HOST_PORT:-4320}:4320 foodflow-api
```

Dockerfile 使用仓库根目录作为构建上下文。使用 Compose 时，从 `deploy` 目录执行 `docker compose --env-file ../.env up -d --build`；Compose 已配置正确的 `context: ..`。
如果本机的 4320 端口被系统保留，可在 `.env` 中设置 `FOODFLOW_HOST_PORT=45555`；容器内 API 仍监听 4320。

小票扫描默认使用容器内的 Tesseract 中文 OCR（`chi_sim`），不配置云端 OCR 也能先识别并进入人工校对；如需更高准确率，再配置 `RECEIPT_OCR_PROVIDER_URL` 和 `RECEIPT_OCR_PROVIDER_TOKEN`。

Skill 的配置只保存主机、用户、端口、仓库、分支和远程目录，不保存 SSH 私钥或 API Key。第一次使用时需要提供这些非敏感信息，之后可直接说“部署到 VPS”。

## Nginx 反向代理

本项目的接口通过 `meishi.musclebank.cn` 代理到 `127.0.0.1:4320`。配置模板位于 `deploy/nginx/meishi.musclebank.cn.conf`；VPS 上安装证书后，将它复制到 `/etc/nginx/conf.d/`，执行 `nginx -t && systemctl reload nginx`。

部署完成后至少验证：

```bash
curl -f https://你的域名/food-flow/index.html
curl -f https://你的域名/health
docker compose -f deploy/docker-compose.yml ps
```
