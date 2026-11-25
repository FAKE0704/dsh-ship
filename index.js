// dsh-ship — 把会话里构建好的静态 web app 一键发布到作者自己的 VPS + 域名。
//
// 语义核在 core.js（shell 模板/解析/校验，keyless 直测）；ssh.js 是 ssh2 懒加载
// 连接池；host-service.js 是服务核（Registry + DeployEngine + /api/dsh-ship 桥）。
// 本文件只做挂载：工具注册、审批门、Web 桥路由。
//
// 审批门（写面 ask，对齐 dsh-local-llm 的 tools/pre-execute 模式）：
// ship_publish / ship_rollback / ship_config_set 每次人工批准；其余免审。
// 凭据永不进对话：目标增删走 Web 桥（/api/dsh-ship targets.add），工具只收 targetId。

import { createShipService } from './host-service.js'

export const name = 'dsh-ship'
export const inject = ['tools']

// Config：不声明 schemastery 面（裸函数模块声明即崩，见 dsh-local-llm 同注释）。
// statePath / remoteRoot / maxVersions / autoRollback 在 createShipService 内
// 归一化并设防；cordis.patch.yml 的 config 可覆写。

/** 需过审批门的写面实名。 */
const GATED_TOOLS = new Set(['ship_publish', 'ship_rollback', 'ship_config_set'])

/** 审批门文案（实名 → 中英 reason）。 */
const GATE_COPY = {
  ship_publish: {
    zh: '发布/更新线上站点（SSH 连接你的服务器：上传构建产物、原子切换版本，可能触发首次 Caddy/HTTPS 配置）',
    en: 'Publish/update the live site (SSH to your server: upload the build, atomically switch release; first run may provision Caddy/HTTPS). Approve?',
  },
  ship_rollback: {
    zh: '回滚线上站点到历史版本（切换服务器上的 current 软链）',
    en: 'Roll the live site back to a previous release (switches the current symlink on your server). Approve?',
  },
  ship_config_set: {
    zh: '热更新线上应用的运行时配置 config.json（不改代码、不重新部署）',
    en: 'Hot-update the live app runtime config config.json (no rebuild, no redeploy). Approve?',
  },
}

/** 审批门决策核（纯函数，keyless 单测面）：写面一律 ask；只读不干预。 */
export function decideShipGate(exec) {
  if (typeof exec?.name !== 'string' || !GATED_TOOLS.has(exec.name)) return null
  const copy = GATE_COPY[exec.name]
  return {
    kind: 'ask',
    reason: `dsh-ship: ${copy.zh}`,
    displayReason: { en: copy.en },
  }
}

/** 工具 canonical value 的输出面（ok/message 双字段 + 文本渲染）。 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
    required: ['ok', 'message'],
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

const TARGET_ID_PARAM = {
  type: 'string',
  description: '发布目标 id（ship_targets 给出，如 "t1"）',
}

/** @param {Context} ctx @param {unknown} config */
export function apply(ctx, config) {
  const svc = createShipService({ ctx, config })

  // ---------- 审批门 ----------
  ctx.on('tools/pre-execute', async (exec, next) => decideShipGate(exec) ?? next())

  // ---------- 工具注册（错误一律折进 ok/message，保持输出 schema 恒定） ----------
  const wrap = (run) => async (args) => {
    try {
      return await run(args)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const registerTool = (name, description, parameters, run) => {
    ctx.tools.register({
      name,
      description,
      parameters,
      output: OUTPUT,
      execute: wrap(run),
    })
  }

  registerTool('ship_targets',
    '查看全部发布目标（无密视图：只含域名/服务器地址/认证方式，绝不含凭据）与各自线上版本、健康状态。只读免审。添加或删除发布目标不走对话——在 Web 设置面板的 dsh-ship 区块操作（凭据经 /api/dsh-ship 提交，不进上下文）。',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const targets = await svc.targetsList()
      if (targets.length === 0) {
        return { ok: true, message: '还没有发布目标。请在 Web 设置面板的 dsh-ship 区块添加（服务器 SSH + 域名），或 POST /api/dsh-ship {"method":"targets.add","args":{...}}' }
      }
      const lines = targets.map((t) => {
        const state = t.currentVersion === null ? '未发布' : `v${t.currentVersion}${t.healthy === true ? ' ✅健康' : t.healthy === false ? ' ⚠️异常' : ''}`
        return `${t.id}｜${t.label}｜https://${t.domain}｜${t.ssh.username}@${t.ssh.host}:${t.ssh.port}（${t.auth}）｜${state}`
      })
      return { ok: true, message: `共 ${targets.length} 个发布目标：\n${lines.join('\n')}`, targets }
    })

  registerTool('ship_publish',
    '把一个已构建好的静态 web app 发布/更新到指定目标（你自己的服务器 + 域名）。distDir 必须是包含 index.html 的产物目录绝对路径（构建由你自己完成，如 pnpm build 后传 dist/）。首次发布会自动完成：Caddy 安装、域名站点配置、DNS 检查、HTTPS 证书、健康检查；之后每次发布 = 上传新版本 + 原子切换 + 健康检查（失败自动回滚上一版）+ 旧版本清理。DNS 未就绪会中止并给出 A 记录指引。写面过审批门。',
    {
      type: 'object',
      properties: {
        targetId: TARGET_ID_PARAM,
        distDir: { type: 'string', description: '构建产物目录的绝对路径（必须含 index.html，如 /path/to/dist）' },
        note: { type: 'string', description: '可选备注（记入部署历史，如 "修复移动端菜单"）' },
      },
      required: ['targetId', 'distDir'],
      additionalProperties: false,
    },
    async (args) => svc.publish(String(args.targetId), String(args.distDir), args.note === undefined ? undefined : String(args.note)))

  registerTool('ship_status',
    '查看一个发布目标的线上状态：当前版本、全部历史版本、HTTP 健康、HTTPS 证书到期日、磁盘占用、最近一次部署结果。只读免审。',
    { type: 'object', properties: { targetId: TARGET_ID_PARAM }, required: ['targetId'], additionalProperties: false },
    async (args) => svc.status(String(args.targetId)))

  registerTool('ship_rollback',
    '把线上站点回滚到历史版本（原子切换 current 软链，秒级生效）。缺省回滚到当前版本的上一版；也可传 version 指定（14 位时间戳版本号，ship_status 的 releases 列表给出）。回滚后自动做健康检查。写面过审批门。',
    {
      type: 'object',
      properties: {
        targetId: TARGET_ID_PARAM,
        version: { type: 'string', description: '要回滚到的版本号（YYYYMMDDHHmmss；缺省=上一版）' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
    async (args) => svc.rollback(String(args.targetId), args.version === undefined ? undefined : String(args.version)))

  registerTool('ship_config_get',
    '读取一个目标的运行时配置 config.json 内容（应用启动时 fetch("/config.json") 的那份；位于 releases 之外的 shared 目录，重新部署不受影响）。只读免审。',
    { type: 'object', properties: { targetId: TARGET_ID_PARAM }, required: ['targetId'], additionalProperties: false },
    async (args) => svc.configGet(String(args.targetId)))

  registerTool('ship_config_set',
    '热更新一个目标的运行时配置 config.json（顶层必须是 JSON 对象）：直接覆写服务器上的 shared/config.json，不重新构建、不重新部署，应用下次加载时生效。适合开关/文案/API 地址等运行时参数；必须烧进构建产物的配置请改代码后走 ship_publish。写面过审批门。',
    {
      type: 'object',
      properties: {
        targetId: TARGET_ID_PARAM,
        content: { type: 'string', description: '完整 JSON 文本（顶层对象，如 {"apiBase":"https://api.example.com"}）' },
      },
      required: ['targetId', 'content'],
      additionalProperties: false,
    },
    async (args) => svc.configSet(String(args.targetId), String(args.content)))

  registerTool('ship_logs',
    '拉取一个目标所在服务器的 Caddy 服务日志尾部（journalctl），排障入口：健康检查失败/DNS/证书问题先看这里。只读免审。',
    {
      type: 'object',
      properties: {
        targetId: TARGET_ID_PARAM,
        tail: { type: 'number', description: '行数（缺省 60，上限 500）' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
    async (args) => svc.logs(String(args.targetId), args.tail))

  // ---------- Web 桥（目标管理；desktop 无 webServer 时自动缺席） ----------
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const disposeRoute = webServer.register({ kind: 'exact', path: svc.WEB_PATH, handler: svc.handleRequest })
    ctx.effect(() => disposeRoute)
  }

  // ---------- 生命周期：插件卸载时收掉全部 SSH 连接 ----------
  ctx.effect(() => () => svc.pool.disposeAll())
}
