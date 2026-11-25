// dsh-ship — 宿主服务核：TargetRegistry（state 持久化）+ DeployEngine
// （provision/publish/rollback/config/logs/status）+ /api/dsh-ship RPC 桥。
//
// 分层纪律（对齐 dsh-local-llm）：编排只在这里；所有可单测判断在 core.js；
// ssh2 只经 ssh.js 懒加载。RPC 桥形态照抄 dsh-ssh web.js / dsh-local-llm
// handleRequest：POST-only + 同源守卫 + {method, args} 分发 + fail-closed。

import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import * as core from './core.js'
import { SshPool } from './ssh.js'

export const WEB_PATH = '/api/dsh-ship'

const HEALTH_PROVISION = { attempts: 24, delayMs: 5000 } // 首发含证书签发，放宽窗口
const HEALTH_FAST = { attempts: 3, delayMs: 3000 }

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.() })

// ---------- TargetRegistry ----------

class TargetRegistry {
  constructor({ statePath, logger = () => {} }) {
    this.statePath = statePath
    this.logger = logger
    let text = ''
    try { text = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '' } catch { text = '' }
    this.state = core.parseState(text)
    this.writeTail = Promise.resolve()
  }

  /** 序列化写盘（串行化在上一笔写之后；失败仅告警不抛——工具面自恢复）。 */
  persist() {
    const snapshot = core.serializeState(this.state)
    const write = async () => {
      try {
        await mkdir(dirname(this.statePath), { recursive: true })
        await writeFile(this.statePath, snapshot, 'utf8')
      } catch (error) {
        this.logger(`dsh-ship: state 写盘失败 ${this.statePath}：${messageOf(error)}`)
      }
    }
    this.writeTail = this.writeTail.then(write, write)
    return this.writeTail
  }

  /** 等待挂起的写盘完成（测试/优雅退出用）。 */
  flush() { return this.writeTail }

  list() { return this.state.targets }
  get(id) { return this.state.targets.find((t) => t.id === id) }

  require(id) {
    const target = this.get(id)
    if (target === undefined) {
      throw new Error(`dsh-ship: 没有发布目标 "${id}"——先用 ship_targets 查看；添加目标走设置面板（RPC targets.add），凭据不进对话`)
    }
    return target
  }

  add(input) {
    const target = core.normalizeTargetInput(input, this.state.targets)
    this.state.targets.push(target)
    void this.persist()
    return { id: target.id, view: core.secretFreeView(target) }
  }

  remove(id) {
    const index = this.state.targets.findIndex((t) => t.id === id)
    if (index < 0) return false
    this.state.targets.splice(index, 1)
    delete this.state.history[id]
    void this.persist()
    return true
  }

  recordDeployment(id, entry) {
    const history = this.state.history[id] ?? (this.state.history[id] = [])
    history.push({ ...entry, at: entry.at ?? new Date().toISOString() })
    if (history.length > core.HISTORY_KEEP) this.state.history[id] = history.slice(-core.HISTORY_KEEP)
    void this.persist()
  }

  historyOf(id) { return this.state.history[id] ?? [] }
}

// ---------- 服务核 ----------

/**
 * @param {{ ctx?: unknown, config?: object, deps?: { pool?: object } }} host
 * config: { statePath?, remoteRoot?, maxVersions?, autoRollback? }（apply 已归一，这里再设防）
 * deps.pool：测试注入缝（缺省真实 SshPool，ssh2 懒加载）
 */
export function createShipService({ ctx, config, deps } = {}) {
  const logger = (message) => {
    try { ctx?.logger?.info?.(message) } catch { console.log(message) }
  }
  const cfg = {
    statePath: typeof config?.statePath === 'string' && config.statePath.trim() !== '' ? config.statePath : core.defaultStatePath(),
    remoteRoot: typeof config?.remoteRoot === 'string' && /^[-a-zA-Z0-9_/.]+$/.test(config.remoteRoot) && config.remoteRoot.startsWith('/')
      ? config.remoteRoot.replace(/\/+$/, '') : core.DEFAULTS.remoteRoot,
    maxVersions: Number.isInteger(config?.maxVersions) && config.maxVersions >= 1 && config.maxVersions <= 50
      ? config.maxVersions : core.DEFAULTS.maxVersions,
    autoRollback: config?.autoRollback === undefined ? core.DEFAULTS.autoRollback : config.autoRollback === true,
  }
  const registry = new TargetRegistry({ statePath: cfg.statePath, logger })
  const pool = deps?.pool ?? new SshPool(logger)
  const locks = new Set()
  // 测试钩子：config.healthWait 覆盖健康检查节奏（仅测试用，缺省不出现）。
  const healthWaitOverride = (config?.healthWait !== undefined
    && Number.isInteger(config.healthWait?.attempts) && Number.isInteger(config.healthWait?.delayMs))
    ? config.healthWait : null

  // ---- 引擎基础面 ----

  /** 特权包裹：root 直跑；非 root 前置确认免密 sudo，否则给出指引报错。 */
  async function privileged(conn, probe, script, timeoutMs) {
    if (probe.uid === 0) return conn.exec(script, timeoutMs)
    const check = await conn.exec('sudo -n true', 8000)
    if (check.code !== 0) {
      throw new Error('dsh-ship: SSH 账号非 root 且无免密 sudo——请改用 root 登录该 VPS，或为当前账号配置 NOPASSWD sudo')
    }
    return conn.exec(core.withSudo(script, probe.uid), timeoutMs)
  }

  async function waitForHealthy(conn, domain, { attempts, delayMs }) {
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await sleep(delayMs)
      const outcome = await conn.exec(core.healthCheckScript(domain), 15000)
      if (outcome.stdout.trim() === '200') return true
    }
    return false
  }

  /** Provisioning（幂等）：装 Caddy → 主配置 import → 站点 conf → reload → DNS 检查。 */
  async function provision(conn, target, probe) {
    if (!probe.hasCaddy && probe.ports.length > 0) {
      throw new Error(`dsh-ship: 80/443 端口已被占用（${probe.ports.join(' ')}）且未见 Caddy——为不破坏你已有的 Web 服务已中止。请先迁移/停用现有服务，或提供可复用其上的方案（nginx 共存在 M3 规划）`)
    }
    if (!probe.hasCaddy) {
      const installed = await privileged(conn, probe, core.installCaddyScript(), 300000)
      if (!installed.stdout.includes('DSHSHIP_INSTALL_OK')) {
        throw new Error(`dsh-ship: Caddy 安装失败（仅支持 Ubuntu/Debian）——${installed.stderr.trim().slice(-400) || installed.stdout.trim().slice(-400)}`)
      }
    }
    const P = core.sitePaths(cfg.remoteRoot, target.id)
    const imported = await privileged(conn, probe, core.ensureImportScript(), 15000)
    if (!imported.stdout.includes('DSHSHIP_IMPORT_OK')) {
      throw new Error(`dsh-ship: 主 Caddyfile 追加 import 失败——${imported.stderr.trim().slice(-300)}`)
    }
    const caddyfile = core.renderCaddyfile({ domain: target.domain, root: P.currentLink, spa: target.spa === true })
    const conf = await privileged(conn, probe, core.writeSiteConfScript(P.confPath, caddyfile), 30000)
    if (!conf.stdout.includes('DSHSHIP_CONF_OK')) {
      throw new Error(`dsh-ship: 站点配置写入/校验失败——${conf.stderr.trim().slice(-300)}`)
    }
    const reloaded = await privileged(conn, probe, core.reloadCaddyScript(), 30000)
    if (!reloaded.stdout.includes('DSHSHIP_RELOAD_OK')) {
      throw new Error(`dsh-ship: Caddy reload 失败——${reloaded.stderr.trim().slice(-300)}`)
    }
    const dns = core.parseDnsCheck((await conn.exec(core.dnsCheckScript(target.domain), 15000)).stdout, probe.ip)
    if (!dns.ok) {
      const hint = dns.resolved.length === 0
        ? `域名 ${target.domain} 尚未解析出 A 记录`
        : `域名 ${target.domain} 解析到 ${dns.resolved.join(' / ')}，而服务器公网 IP 是 ${dns.serverIp ?? '未知'}`
      throw new Error(`dsh-ship: DNS 未就绪——${hint}。请把 A 记录指到服务器 IP 后重新执行发布（证书签发强依赖 DNS 就绪）`)
    }
  }

  /** 本地产物校验 + tar 打包。 */
  async function packDist(distDir, version) {
    if (typeof distDir !== 'string' || distDir.trim() === '' || !isAbsolute(distDir)) {
      throw new Error('dsh-ship: distDir 必须是产物目录的绝对路径（如 /path/to/dist）')
    }
    const dist = resolve(distDir)
    const st = await stat(dist).catch(() => null)
    if (st === null || !st.isDirectory()) throw new Error(`dsh-ship: 产物目录不存在：${dist}`)
    await access(join(dist, 'index.html')).catch(() => {
      throw new Error(`dsh-ship: ${dist} 里没有 index.html——请先构建（如 pnpm build），把产物目录传给本工具`)
    })
    const tgzLocal = join(tmpdir(), `dsh-ship-${version}.tgz`)
    await rm(tgzLocal, { force: true })
    await new Promise((resolvePromise, reject) => {
      execFile('tar', ['-C', dist, '-czf', tgzLocal, '.'], { timeout: 120000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`dsh-ship: 本地打包失败——${String(stderr).trim() || error.message}`))
        else resolvePromise()
      })
    })
    return tgzLocal
  }

  // ---- 引擎操作面（工具/RPC 共用） ----

  async function publish(targetId, distDir, note, trigger = 'tool') {
    const target = registry.require(targetId)
    if (locks.has(targetId)) throw new Error(`dsh-ship: 目标 ${targetId} 正在部署中——请等当前发布结束`)
    locks.add(targetId)
    const startedAt = Date.now()
    const version = core.versionStamp()
    let tgzLocal = null
    try {
      const conn = await pool.connection(target)
      const probe = core.parseProbe((await conn.exec(core.probeScript(), 20000)).stdout)
      if (!probe.ok) throw new Error('dsh-ship: 环境探测失败（SSH 连上了但探测命令未完成）')
      await provision(conn, target, probe)

      const P = core.sitePaths(cfg.remoteRoot, target.id)
      tgzLocal = await packDist(distDir, version)
      // 切换前记录当前版本（回滚锚点）：readlink 输出形如 releases/<ts>，先剥前缀
      const before = await conn.exec(`readlink ${core.shq(P.currentLink)} 2>/dev/null | sed 's#^releases/##' || true`, 8000)
      const previous = core.isVersion(before.stdout.trim()) ? before.stdout.trim() : null
      await pool.putFile(target, tgzLocal, P.tgzPath(version))
      const published = await conn.exec(core.publishScript(P, version), 60000)
      if (!published.stdout.includes('DSHSHIP_PUBLISH_OK')) {
        throw new Error(`dsh-ship: 发布脚本失败——${published.stderr.trim().slice(-400) || published.stdout.trim().slice(-400)}`)
      }
      const healthy = await waitForHealthy(conn, target.domain, healthWaitOverride ?? HEALTH_PROVISION)
      if (!healthy) {
        if (cfg.autoRollback && previous !== null) {
          await conn.exec(core.rollbackScript(P, previous), 30000)
          registry.recordDeployment(targetId, { version, note, trigger, result: 'failed-rolled-back', detail: '健康检查未通过，已自动回滚' })
          throw new Error(`dsh-ship: 健康检查未通过（${target.domain} 未返回 200）——已自动回滚到 ${previous}。可用 ship_logs 排障后重试`)
        }
        registry.recordDeployment(targetId, { version, note, trigger, result: 'failed', detail: '健康检查未通过' })
        throw new Error(`dsh-ship: 健康检查未通过（${target.domain} 未返回 200）——新版本已上线但可能不可用，可用 ship_logs 排障或 ship_rollback`)
      }
      const releases = core.parseReleases((await conn.exec(core.listReleasesScript(P), 10000)).stdout)
      const doomed = core.gcSelection(releases, version, cfg.maxVersions)
      if (doomed.length > 0) await conn.exec(core.gcScript(P, doomed), 30000)
      const durationMs = Date.now() - startedAt
      registry.recordDeployment(targetId, { version, note, trigger, result: 'ok', durationMs })
      const first = previous === null ? '（首次发布已自动完成 Caddy/HTTPS 配置）' : ''
      return {
        ok: true,
        message: `✅ 已发布 ${target.label} v${version} → https://${target.domain}${first} 耗时 ${(durationMs / 1000).toFixed(1)}s（保留最近 ${cfg.maxVersions} 版，ship_rollback 可回滚）`,
        version,
        url: `https://${target.domain}/`,
        durationMs,
      }
    } finally {
      locks.delete(targetId)
      if (tgzLocal !== null) await rm(tgzLocal, { force: true }).catch(() => {})
    }
  }

  async function rollback(targetId, requestedVersion, trigger = 'tool') {
    const target = registry.require(targetId)
    if (locks.has(targetId)) throw new Error(`dsh-ship: 目标 ${targetId} 正在部署中——请等当前发布结束`)
    locks.add(targetId)
    try {
      const conn = await pool.connection(target)
      const P = core.sitePaths(cfg.remoteRoot, target.id)
      const releases = core.parseReleases((await conn.exec(core.listReleasesScript(P), 10000)).stdout)
      if (releases.length === 0) throw new Error('dsh-ship: 远端还没有任何发布版本')
      const current = (await conn.exec(`readlink ${core.shq(P.currentLink)} 2>/dev/null | sed 's#^releases/##'`, 8000)).stdout.trim() || null
      let version = typeof requestedVersion === 'string' && requestedVersion.trim() !== '' ? requestedVersion.trim() : null
      if (version !== null && !core.isVersion(version)) {
        throw new Error(`dsh-ship: 版本号形状不对："${version}"（14 位时间戳，见 ship_status 的 releases 列表）`)
      }
      if (version === null) {
        const index = current !== null ? releases.indexOf(current) : releases.length - 1
        if (index <= 0) throw new Error(`dsh-ship: 已在最早版本${current === null ? '' : `（${current}）`}，没有更早版本可回滚——可改传 version 指定目标版本`)
        version = releases[index - 1]
      }
      if (!releases.includes(version)) {
        throw new Error(`dsh-ship: 远端没有版本 ${version}（现有：${releases.join(', ')}）`)
      }
      const done = await conn.exec(core.rollbackScript(P, version), 30000)
      if (!done.stdout.includes('DSHSHIP_ROLLBACK_OK')) {
        throw new Error(`dsh-ship: 回滚脚本失败——${done.stderr.trim().slice(-300)}`)
      }
      const healthy = await waitForHealthy(conn, target.domain, healthWaitOverride ?? HEALTH_FAST)
      registry.recordDeployment(targetId, { version, trigger, result: healthy ? 'rolled-back' : 'rolled-back-unhealthy' })
      return {
        ok: true,
        message: healthy
          ? `✅ 已回滚 ${target.label} → v${version}，https://${target.domain} 健康检查通过`
          : `⚠️ 已回滚 ${target.label} → v${version}，但健康检查未通过（${target.domain} 未返回 200）——可用 ship_logs 排障`,
        version,
      }
    } finally {
      locks.delete(targetId)
    }
  }

  async function status(targetId) {
    const target = registry.require(targetId)
    const conn = await pool.connection(target)
    const P = core.sitePaths(cfg.remoteRoot, target.id)
    const parsed = core.parseStatus((await conn.exec(core.statusScript(P, target.domain), 25000)).stdout)
    if (!parsed.ok) throw new Error('dsh-ship: 状态采集失败（远端命令未完成）')
    const last = registry.historyOf(targetId).at(-1) ?? null
    return {
      ok: true,
      message: [
        `📦 ${target.label}（${target.domain}）`,
        `当前版本：${parsed.current ?? '未发布'}`,
        `HTTP：${parsed.http ?? '?'}｜证书到期：${parsed.certEnd ?? '?'}｜磁盘：${parsed.disk ?? '?'}`,
        `版本：${parsed.releases.join(', ') || '无'}`,
        `最近一次部署：${last ? `${last.version} ${last.result}${last.at ? ` @ ${last.at}` : ''}` : '无记录'}`,
      ].join('\n'),
      ...parsed,
    }
  }

  async function logs(targetId, tail) {
    const target = registry.require(targetId)
    const conn = await pool.connection(target)
    const outcome = await conn.exec(core.logScript(tail), 20000)
    return { ok: true, message: outcome.stdout.trim() === '' ? '（日志为空）' : outcome.stdout.trim() }
  }

  async function configGet(targetId) {
    const target = registry.require(targetId)
    const conn = await pool.connection(target)
    const P = core.sitePaths(cfg.remoteRoot, target.id)
    const content = (await conn.exec(core.configGetScript(P), 10000)).stdout
    return { ok: true, message: `config.json（应用启动时 fetch('/config.json')；改它不触发重新部署）：\n${content.trim()}`, content: content.trim() }
  }

  async function configSet(targetId, content) {
    const target = registry.require(targetId)
    core.validateConfigContent(content)
    const conn = await pool.connection(target)
    const P = core.sitePaths(cfg.remoteRoot, target.id)
    const done = await conn.exec(core.configSetScript(P, content), 15000)
    if (!done.stdout.includes('DSHSHIP_CONFIG_OK')) {
      throw new Error(`dsh-ship: 配置写入失败——${done.stderr.trim().slice(-300)}`)
    }
    return { ok: true, message: `✅ 已热更新 ${target.label} 的 config.json（无需重新部署；应用在下次加载时生效）` }
  }

  async function targetsList() {
    const views = []
    for (const target of registry.list()) {
      let currentVersion = null
      let healthy = null
      try {
        const conn = await pool.connection(target)
        const P = core.sitePaths(cfg.remoteRoot, target.id)
        const parsed = core.parseStatus((await conn.exec(core.statusScript(P, target.domain), 25000)).stdout)
        currentVersion = parsed.current
        healthy = parsed.http === '200'
      } catch { /* 单目标失联不打断列表 */ }
      views.push({ ...core.secretFreeView(target), currentVersion, healthy })
    }
    return views
  }

  // ---- RPC 桥（面板/管理面；发布只走会话工具，这里不提供 publish） ----

  const METHODS = {
    'targets.list': async () => ({ ok: true, targets: await targetsList() }),
    'targets.add': async (args) => {
      const added = registry.add(args)
      const target = registry.require(added.id)
      const connectionTest = await pool.test(target).catch((error) => ({ ok: false, message: messageOf(error) }))
      return { ok: true, target: added.view, connectionTest }
    },
    'targets.test': async (args) => {
      const target = core.normalizeTargetInput(args, registry.list())
      return pool.test(target)
    },
    'targets.remove': async (args) => {
      const id = String(args?.id ?? '')
      const removed = registry.remove(id)
      pool.dispose(id)
      return { ok: true, removed }
    },
    'deployments.list': async (args) => ({ ok: true, history: registry.historyOf(String(args?.targetId ?? '')) }),
  }

  async function rpcInvoke(method, params) {
    const fn = Object.hasOwn(METHODS, String(method)) ? METHODS[String(method)] : null
    if (fn === null) {
      return { ok: false, message: `未知方法 "${String(method)}"（支持：${Object.keys(METHODS).join(' / ')}）` }
    }
    return fn(params ?? {})
  }

  function handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    // 同源守卫（对齐 dsh-local-llm）：带 Origin 的请求必须指向本服务 host
    const origin = req.headers.origin
    const host = req.headers.host
    if (origin !== undefined && host !== undefined) {
      try {
        if (new URL(origin).host !== host) {
          res.writeHead(403)
          res.end()
          return
        }
      } catch {
        res.writeHead(403)
        res.end()
        return
      }
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      let rpc = null
      try { rpc = JSON.parse(body === '' ? '{}' : body) } catch { rpc = null }
      const fn = rpc !== null && typeof rpc.method === 'string' ? METHODS[rpc.method] : undefined
      let payload
      if (fn === undefined) {
        payload = { ok: false, message: `未知方法（支持：${Object.keys(METHODS).join(' / ')}）` }
      } else {
        try {
          payload = await fn(rpc.args ?? {})
        } catch (error) {
          payload = { ok: false, message: messageOf(error) }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload ?? { ok: false, message: '空响应' }))
    })
  }

  return {
    WEB_PATH,
    handleRequest,
    rpcInvoke,
    registry,
    pool,
    publish,
    rollback,
    status,
    logs,
    configGet,
    configSet,
    targetsList,
    config: cfg,
  }
}
