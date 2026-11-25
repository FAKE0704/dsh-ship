# dsh-ship 设计文档（v0.2 定稿）

> 定名 `dsh-ship`。Phase 1 只做**纯静态前端 web app** 的一键发布与快速迭代；不涉及任何模型 API / agent 后端。
>
> 已拍板：① 默认 Web 服务器 **Caddy**；② 发布操作**只走会话对话**（面板不做发布按钮）；③ 多应用按**子域名**隔离，路径前缀留 Phase 2；④ UI **极简**——只保留目标管理与部署历史，不做其它配置 UI。

## 1. 定位与范围

**一句话**：作者在 DSH 会话里构建好前端 web app，对插件说「发布」→ 插件通过 SSH 连上作者自带的 VPS，自动完成产物上传、Web 服务器配置、域名绑定、HTTPS 证书 → 外部用户浏览器打开 `https://域名` 即用。此后改代码 → 重新部署、改配置 → 热更新、出问题 → 回滚，全程对话式完成，作者不需要懂运维。

**明确不做（Phase 1）**：
- ❌ 带 agent / 模型 API 的应用（未来扩展）
- ❌ 服务器常驻组件（每次部署是幂等 SSH 操作）
- ❌ 第三方静态托管平台（Netlify / OSS 等）
- ❌ 构建本身 —— 插件不管 `pnpm build`，构建由会话里的 agent 自己跑完，把 **产物目录**（如 `dist/`）交给插件。插件与前端框架解耦。

**前提假设**：作者有一台 VPS（Phase 1 支持 Ubuntu/Debian 系）+ 一个域名 + SSH 凭据（推荐 root 登录，非 root 走 sudo 并前置检测）。

## 2. 参考对象与可复用模式

| 模式 | 来源（已核实源码） | 在 dsh-ship 中的落点 |
|---|---|---|
| 连接注册表：JSON 持久化 + 懒建立 + 无密视图 | `dsh-ssh` `lib/registry.js`（`SshRegistry`，状态存 `~/.dsh/dsh-ssh-connections.json`，`viewOf` 输出无密视图 #L384） | 发布目标注册表 `~/.dsh/dsh-ship-targets.json`，同样永不向工具/UI 回显凭据 |
| 连接测试：connect → `exec('true')` → dispose | `dsh-ssh` `registry.js` `test()` #L241 | 「添加发布目标」表单的「测试连接」按钮 |
| Web RPC 通道：单通道 + JSON endpoint + 错误词汇表 | `dsh-ssh` `lib/web.js`（挂 `/dsh-ssh`，`wireError` 映射 bad-request/internal/connection-failed #L83） | `/api/dsh-ship` 通道，目标管理走它 |
| SSH 认证字段命名与 `~/.ssh/config` 别名解析 | `dsh-ssh` `registry.js` `readSshConfig` / `resolveAgainst`（#L43–#L343） | 字段命名保持兼容；别名解析逻辑移植（M3） |
| SFTP 远端文件操作 | `dsh-ssh` `connection.getSftp()` | 上传产物 tar 包、远端目录巡检 |
| 插件工程形态：平铺模块 + `dsh.bundle.patch` + `client.inject` | `dsh-local-llm`（`package.json` 的 `dsh` 字段、`core.js` 纯逻辑 / `host-service.js` 服务核 / `client.js` UI 分层） | dsh-ship 采用同构工程结构（见 §9） |

选型决策：**自带精简 ssh2 连接层**（不硬依赖 dsh-ssh 包）。理由：dsh-ssh 是面向「远程开发」的第三方插件且当前停用，dsh-ship 是独立产品插件；但字段命名与 ssh-config 解析保持兼容，将来可互通。

## 3. 总体架构

```
┌─ DSH 会话（agent）────────────┐   ┌─ Web GUI（极简）──────────┐
│  ship_* 工具族                 │   │  设置页一个区块：           │
│  (publish/rollback/config/…)  │   │   · 目标列表 + 添加表单     │
│        │ 只收 targetId        │   │   · 部署历史               │
└────────┼──────────────────────┘   └────────┬──────────────────┘
         │                                    │ /api/dsh-ship
         ▼                                    ▼
┌─ host-service.js（唯一服务核）────────────────────────────────┐
│ TargetRegistry（JSON 持久化，无密视图）                        │
│ SshPool（ssh2 连接，懒建立/复用，exec + SFTP）                  │
│ DeployEngine（provision / publish / rollback / config / logs） │
└──────────────────────────┬────────────────────────────────────┘
                           │ SSH (exec + SFTP)
                           ▼
                  作者的 VPS + 域名（Caddy + releases 目录）
```

外部用户只碰 `https://域名`，与 DSH 零关联。

## 4. 数据模型

### 4.1 发布目标（Target）

```jsonc
// ~/.dsh/dsh-ship-targets.json
{
  "targets": [{
    "id": "t1",
    "label": "我的记事本",
    "domain": "notes.example.com",
    "ssh": {
      "host": "vps.example.com", "port": 22, "username": "root",
      "auth": "key",            // key | password | agent（字段名与 dsh-ssh 兼容）
      "privateKeyPath": "~/.ssh/id_ed25519",
      "password": "***", "passphrase": "***"   // 明文持久化，风险同 dsh-ssh，见 §11
    },
    "spa": true                 // SPA fallback: try_files → /index.html（服务器固定 Caddy）
  }]
}
```

工具与 UI 只能看到**无密视图**（`auth` 字段标注认证方式，不含密钥本体），照抄 dsh-ssh `viewOf` 模式。

### 4.2 部署版本（Deployment）

远端 `releases/` 目录是版本事实源；本地在 state 文件里附一份部署历史（时间、版本号 ts、产物摘要、触发方式、结果），用于面板展示与审计。版本号 = 部署时刻 `YYYYMMDDHHmmss`。

## 5. 远端布局与原子部署

```
/srv/dsh-ship/sites/<targetId>/
  releases/<ts>/          # 不可变构建产物（一次上传，永不覆盖）
    index.html assets/…
    config.json -> ../shared/config.json   # 部署脚本补的软链，见 §7.3
  current -> releases/<ts>                  # symlink，原子切换
  shared/config.json                        # 运行时配置（热更新）
```

- **上传**：本地 `tar czf` 打包产物目录 → SFTP put 单文件 → 远端 `mkdir releases/<ts> && tar xzf -C`。单流传输，快且保留目录结构。
- **切换**：`ln -sfn` 到临时名 + `mv -T` 原子替换 `current`。Caddy root 指向 `current`，切换瞬间生效，无窗口期。
- **GC**：保留 `maxVersions`（默认 5）个 release，超出删最老；`shared/` 永不清理。

## 6. 首次发布（provisioning）流程

依次执行，每步失败即中止并输出**给作者的可操作指引**：

1. **连通与权限**：复用 dsh-ssh 的 test 模式（`exec true`）；`id -u` 确认 root（非 root 则 `sudo -n true` 探测，失败 → 指引配置免密 sudo 或改用 root）。
2. **环境探测**：`/etc/os-release`（Phase 1 仅 Ubuntu/Debian）、`command -v caddy`、`ss -ltn` 检查 80/443 占用。已装 nginx 且占用端口 → 中止并说明（不静默迁移，避免破坏已有站点；M3 再评估复用现有 nginx）。
3. **安装 Caddy**：有 `apt` → 走官方 apt 源；失败兜底静态二进制 + systemd unit。已装则跳过。
4. **写入站点配置**：渲染 Caddyfile 片段：
   ```
   notes.example.com {
       root * /srv/dsh-ship/sites/t1/current
       encode gzip zstd
       file_server
       try_files {path} /index.html    # spa: true 时
   }
   ```
   写入 `/etc/caddy/dsh-ship/<targetId>.caddy`（conf.d 风格），`caddy validate` 通过后 reload。
5. **DNS 检查**：远端 `getent hosts <domain>` 对比本机公网 IP。不匹配 → **中止并提示**：「请把 A 记录指到 <IP>，生效后重新发布」（证书申请强依赖 DNS，前置检查避免 Caddy 反复重试）。
6. **证书**：Caddy 自动申请（HTTP-01，依赖 80 端口可达）。发布流程等待首页 HTTPS 探测通过。
7. **健康检查**：`curl -fsS https://<domain>/` 期望 200 且含 `index.html` 标记。失败 → 自动回滚上一版（`autoRollback` 默认开）并报告。

## 7. 迭代操作

| 操作 | 流程 | 备注 |
|---|---|---|
| 重新部署 | 上传新 release → 补 config.json 软链 → 原子切 `current` → 健康检查 → GC | 全程不动 `shared/` 与服务器配置 |
| 回滚 | `current` 指回指定/上一版 → 健康检查 | symlink 切换无需 reload；默认上一版 |
| **配置热更新** | `ship_config_set` 直接覆写 `shared/config.json` → 健康检查 | 应用启动时 `fetch('/config.json')`；**无需重新构建/部署**。必须烧进构建的配置走重新部署路径 |
| 日志 | `journalctl -u caddy -n` / access log 尾部 | 排障入口 |
| 状态 | current 版本、证书有效期（`openssl s_client`）、磁盘占用、HTTP 探测 | |

并发保护：同一 target 同时只允许一个部署（本地 registry 内互斥标志 + 部署超时强释放）。

## 8. Agent Tools（工具族）

| 工具 | 入参 | 副作用 | 说明 |
|---|---|---|---|
| `ship_targets` | — | 只读 | 无密视图列表 + 各自线上版本 |
| `ship_publish` | `targetId, distDir, note?` | **写远端** | 校验 `distDir/index.html` 存在 → 走 §5/§6 流程；返回 `{version, url, durationMs}` |
| `ship_status` | `targetId` | 只读 | §7 状态汇总 |
| `ship_rollback` | `targetId, version?` | **写远端** | 默认上一版 |
| `ship_config_get` | `targetId` | 只读 | 返回 shared/config.json 内容 |
| `ship_config_set` | `targetId, content` | **写远端** | 热更新；JSON 语法校验后覆写 |
| `ship_logs` | `targetId, tail?` | 只读 | 服务端日志尾部 |

**安全边界**：所有工具只接受 `targetId`，凭据永不出现在对话上下文；添加/删除目标走 Web 表单（凭据由 UI 经 `/api/dsh-ship` 提交，等价 dsh-ssh 的 connections.add 路径）。写远端工具依赖 DSH 审批面把关。

## 9. 插件工程结构（对照 dsh-local-llm）

```
dsh-ship/
  package.json        # "dsh": { bundle.patch, client: { platform: web, inject: [ui-settings] } }
  cordis.patch.yml    # - insert: [{ id: dsh-ship, name: dsh-ship, config: {} }]
  index.js            # 入口：挂载 host-service
  core.js             # 纯逻辑（keyless 直测缝，零依赖）：部署计划生成、Caddyfile/systemd 模板、
                      #   registry 序列化、版本命名与 GC 选择、ssh-config 别名解析（M3 移植）
  host-service.js     # 服务核：TargetRegistry + SshPool + DeployEngine
                      #   + /api/dsh-ship RPC（照 dsh-ssh web.js 的 endpoint 派发模式）
                      #   + ship_* 工具注册（照 dsh-local-llm 的 typert 方式）
  client.js           # 极简设置页：目标表单（host/port/认证/域名/SPA + 测试连接）、部署历史。
                      #   不做其它任何配置 UI——插件级参数只走 cordis 配置文件
  locale/zh.json en.json
  icon.svg  README.md README.zh.md
```

依赖：`ssh2`（连接/SFTP）、`zod`（照 dsh-local-llm 的 `@deepseek-ai/dsh-typert-protocol` + `zod` 组合）。

插件级 Config（Service 静态 schema，仅 cordis 配置面，不进 UI）：

```js
{ stateFile: string,        // 默认 ~/.dsh/dsh-ship-targets.json
  remoteRoot: string,       // 默认 /srv/dsh-ship
  maxVersions: number,      // 默认 5
  autoRollback: boolean }   // 默认 true
```

## 10. RPC endpoints（/api/dsh-ship）

`targets.list / targets.add / targets.test / targets.remove`、`deployments.list`。
发布触发**只走会话工具**（已拍板）；面板不做发布按钮。

## 11. 安全与已知风险

1. **凭据明文持久化** —— 与 dsh-ssh 同一现实（其源码注释明示 secret persisted verbatim）。Phase 1 接受，文档标注；后续版本接 DSH credentials 服务（base bundle 已含 `dsh-credentials-local`）。
2. **主机指纹** —— 沿用 dsh-ssh 默认 `strictHostKeyChecking: false`，但表单提供可选 knownHosts 指纹校验，README 建议生产勾选。
3. **80/443 冲突** —— provisioning 第 2 步硬检查，冲突即中止（不静默迁移，避免破坏作者已有站点）。
4. **部署原子性** —— symlink 切换保证无中间态；健康检查失败自动回滚兜底。
5. **工具审批** —— publish/rollback/config_set 标记为变更类操作，靠 DSH 权限预设拦截误触发。

## 12. 里程碑

- **M1（骨架可用）**：core.js 计划生成 + Registry + SshPool + provision（Caddy/Ubuntu）+ publish，单 target 跑通「构建 → 一句话发布 → 外网可访问」。UI 缺位不影响（目标可先经 state 文件或临时 RPC 建立）。
- **M2（迭代闭环）**：rollback / config 热更新 / logs / status 工具齐全，部署历史持久化，并发锁 + autoRollback。
- **M3（极简面板）**：设置页目标表单 + 部署历史（仅此两块，无其它配置 UI）、nginx 支持、`~/.ssh/config` 别名解析、非 root + sudo、发行版探测友好化。
- **未来**：带后端/agent 应用（薄网关层）、凭据接 credentials、一台服务器多 target 子域名编排。

## 13. 决策记录（已拍板）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 默认 Web 服务器 | **Caddy**（自动 HTTPS、单配置文件） |
| 2 | 发布触发方式 | **只走会话对话**，面板不提供发布按钮 |
| 3 | 多应用隔离 | **子域名**；路径前缀留 Phase 2 |
| 4 | 包名 | **dsh-ship** |
| 5 | UI 原则 | **极简**：仅目标管理 + 部署历史，不做非必要配置 UI；插件参数只走 cordis 配置 |
