# VPS 部署说明

当前项目可以拆成两部分部署：

- `designs/food-flow`：静态前端，可放 GitHub Pages
- `server/douyin-api.mjs`：后端接口，放 VPS 或其他 Node.js 云服务

## VPS 拉取并启动

```bash
git clone <你的 GitHub 仓库地址> food-flow
cd food-flow
cp .env.example .env
# 编辑 .env，填写经过授权的 DOUYIN_PROVIDER_URL 和 DOUYIN_PROVIDER_TOKEN
node server/douyin-api.mjs
```

生产环境建议用反向代理提供 HTTPS，并把前端的 AI 接口地址设置为：

```text
https://你的域名/api/douyin/parse
```

不要把 `.env`、API Key 或会员密钥提交到 GitHub。当前前端设置页是个人测试 / 会员功能预览，正式版本应把密钥保存到后端数据库或密钥管理服务。

## Docker

```bash
docker build -t foodflow-api -f server/Dockerfile server
docker run --env-file .env -p 4320:4320 foodflow-api
```
