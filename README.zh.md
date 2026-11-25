# dsh-ship

[English](README.md) | 中文

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ship"><img src="https://img.shields.io/npm/v/dsh-ship" alt="npm 版本"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node ≥ 20">
  <img src="https://img.shields.io/badge/dsh-0.2.x-4D6BFE" alt="dsh 0.2.x">
  <img src="https://img.shields.io/npm/l/dsh-ship" alt="MIT">
</p>

**DeepSeek Harness 的发布插件**：把会话里构建好的**纯静态前端 web app** 一键发布到**你自己的 VPS + 域名**——Caddy 自动 HTTPS、原子版本切换、秒级回滚、配置热更新。外部用户浏览器打开你的域名即用，全程对话式完成，服务器上**不留任何常驻组件**（每次部署是幂等 SSH 操作）。

> Phase 1 不涉及任何模型 API / agent 后端；构建本身也由你（或会话里的 agent）完成，插件只负责"把产物目录安全送上服务器"。

## 工具（会话内使用）

| 工具 | 说明 | 审批 |
|---|---|---|
| `ship_targets` | 发布目标列表（无密视图）+ 线上版本/健康 | 免审 |
| `ship_publish` | 发布/更新：上传新版本 → 原子切换 → 健康检查（失败自动回滚）→ 旧版本 GC；首次发布自动完成 Caddy 安装、站点配置、DNS 检查、HTTPS 证书 | **每次审批** |
| `ship_status` | 当前版本、全部版本、证书到期、磁盘占用 | 免审 |
| `ship_rollback` | 回滚到上一版或指定版本（原子切换，秒级生效） | **每次审批** |
| `ship_config_get` / `ship_config_set` | 运行时配置 `config.json` 读取/热更新（不重新部署，应用下次加载生效） | set **每次审批** |
| `ship_logs` | 服务器 Caddy 日志尾部（排障入口） | 免审 |

凭据永不进对话：工具只接受 `targetId`；目标的增删走 Web 桥（见下）。

## 添加发布目标

目标 = 一台服务器（SSH）+ 一个域名。当前版本（M1，UI 面板在 M3）通过 Web 桥添加：

```sh
# Web profile 下（本机 DSH Web GUI）：
curl -X POST http://127.0.0.1:<port>/api/dsh-ship -H 'content-type: application/json' -d '{
  "method": "targets.add",
  "args": {
    "host": "vps.example.com", "port": 22, "username": "root",
    "auth": "key", "privateKeyPath": "~/.ssh/id_ed25519",
    "domain": "notes.example.com", "spa": true
  }
}'
```

或直接编辑状态文件 `~/.dsh/dsh-ship-targets.json`（字段同上，改完无需重启，下次工具调用即生效）。

**前置条件**：一台 Ubuntu/Debian VPS（推荐 root 登录）+ 一个已解析到该服务器的域名（发布流程会硬检查 DNS，未就绪会中止并给出指引）+ 80/443 未被其它 Web 服务占用（有占用会中止而不是静默迁移）。

## 远端布局（设计文档 §5）

```
/srv/dsh-ship/sites/<targetId>/
  releases/<YYYYMMDDHHmmss>/   # 不可变版本
    config.json -> ../shared/config.json
  current -> releases/<最新>     # 原子切换的软链，Caddy root 指向这里
  shared/config.json             # 运行时配置（热更新，不随部署丢失）
```

## 配置（cordis.patch.yml / 插件配置，不进 UI）

| 字段 | 默认 | 说明 |
|---|---|---|
| `statePath` | `~/.dsh/dsh-ship-targets.json` | 目标与部署历史持久化文件 |
| `remoteRoot` | `/srv/dsh-ship` | 服务器端根目录 |
| `maxVersions` | `5` | 保留的版本数（GC） |
| `autoRollback` | `true` | 健康检查失败自动回滚上一版 |

## 开发

```sh
npm i            # ssh2（连接层，懒加载——单测不依赖它）
npm test         # node --test tests/：core 单测 + 引擎 mock 集成（25 例，无需真服务器）
npm run check    # 语法检查
```

工程结构对齐 dsh-local-llm：`core.js`（纯逻辑 shell 模板/解析/校验，keyless 直测）、`ssh.js`（ssh2 连接池）、`host-service.js`（Registry + DeployEngine + `/api/dsh-ship` 桥）、`index.js`（工具注册 + 审批门 + 挂载）。设计与决策记录见 `docs/DESIGN.md`。

## 安全须知

- SSH 凭据明文存于 `~/.dsh/dsh-ship-targets.json`（与 dsh-ssh 同策略）；后续版本接 DSH credentials 服务。请确保本机账户安全。
- 默认不做主机指纹校验（对齐 dsh-ssh 缺省）；可在目标里提供 `knownHosts`（M3 起 UI 支持，当前字段已保留）。
- `ship_publish` / `ship_rollback` / `ship_config_set` 走 DSH 审批面；只读工具免审。

## License

MIT

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
