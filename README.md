# 台球奇招

[![CI](https://github.com/czy666chen/taiqiu-qizhao/actions/workflows/ci.yml/badge.svg)](https://github.com/czy666chen/taiqiu-qizhao/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/czy666chen/taiqiu-qizhao)](https://github.com/czy666chen/taiqiu-qizhao/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

面向台球朋友局的开源 Web 应用，支持标准 15 红斯诺克、中八双人赛、2–8 人追分、奇招牌和基于 Cloudflare Durable Objects/WebSocket 的多人实时房间。当前版本为 `v6.1.0`。

## 功能

- 中八逐局计分、赛制与开球规则、战绩导出
- 斯诺克逐球计分、单杆与 147/155 路线、犯规/自由球/重置黑球、Best of 局分和实时房间
- 多人追分、可配置规则、排名、撤销和统一流水
- 独立奇招牌、斯诺克兼容白名单、手牌隐私、抽取/使用/跳过与下一轮重发
- 账号、跨设备同步、云端战绩和实时房间
- 离线本地存储、JSON/长图/PDF 数据导出、深浅主题和移动端布局

斯诺克本机模式可完全离线使用。登录后才会同步云端；实时房间中的房主、玩家和观战者按角色获得不同权限，其他玩家的私有手牌不会出现在其快照中。账户页可导出或删除云端数据，战绩页可导出单场 JSON、长图和 PDF。启用奇招牌的斯诺克对局会明确标为变体局。

## 技术栈

- React 19、Next.js 16、vinext、Vite 8、TypeScript
- Cloudflare Workers、D1、Durable Objects、WebSocket
- Vitest、Playwright、ESLint

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
git clone https://github.com/czy666chen/taiqiu-qizhao.git
cd taiqiu-qizhao
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Windows PowerShell 可使用 `Copy-Item .dev.vars.example .dev.vars`。

`.dev.vars` 只能填写开发环境值，禁止复用生产密钥。项目不会提交环境变量、构建产物或本地数据库状态。

## 验证

```bash
npm run lint
npm run test:all
npm run test:e2e
npm run build:production
```

## 部署

项目支持 Cloudflare Workers + D1 + Durable Objects。部署自己的实例前，请在 `wrangler.jsonc` 中配置独立 Worker、D1 数据库和环境，并通过 Wrangler 设置以下 secrets：

- `REGISTRATION_INVITE_CODE`
- `PASSWORD_HMAC_KEY`
- `SESSION_HMAC_KEY`

不要复用本项目生产资源或密钥。部署前请创建自己的 D1 数据库、更新 `wrangler.jsonc` 中的资源配置、应用 `migrations/`，再运行 `npm run deploy:production`。

## 参与贡献

请阅读 [贡献指南](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md) 和 [安全政策](SECURITY.md)。功能建议与普通缺陷可提交 Issue；安全漏洞请使用 GitHub 私密漏洞报告。

## 许可证

本项目采用 [MIT License](LICENSE)。
