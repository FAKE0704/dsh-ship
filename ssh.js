// dsh-ship — SSH 连接池（ssh2 懒加载 + 按目标复用 + exec/SFTP 两个面）。
//
// ssh2 用动态 import：插件模块加载不触碰 ssh2，core 单测与 mock 集成测试
// 无需安装它；运行时缺失则给出可操作报错。连接断开即出池，下次调用重建
// （对齐 dsh-ssh「断开不自动重连，重建即可」的语义）。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONNECT_TIMEOUT_MS = 20000
const KEEPALIVE_INTERVAL_MS = 15000

function expandTilde(path) {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  return path
}

/** 私钥：路径（含 ~）读文件；内容形如 PEM 则原样使用。 */
function resolvePrivateKey(privateKeyPath, logger) {
  const value = String(privateKeyPath ?? '').trim()
  if (value === '') return undefined
  if (value.includes('PRIVATE KEY')) return value.replace(/\\n/g, '\n')
  const expanded = expandTilde(value)
  if (!existsSync(expanded)) {
    throw new Error(`dsh-ship: 私钥文件不存在：${expanded}`)
  }
  try {
    return readFileSync(expanded, 'utf8')
  } catch (error) {
    throw new Error(`dsh-ship: 私钥文件不可读：${expanded}（${error instanceof Error ? error.message : String(error)}）`)
  }
}

/** 单条 SSH 连接（ssh2 Client 的薄包装：exec + putFile + dispose）。 */
class SshConnection {
  constructor(client, spec) {
    this.client = client
    this.spec = spec
  }

  /** 建连：auth=key/password/agent 三选一，字段命名与 dsh-ssh 兼容。 */
  static async create(target, logger = () => {}) {
    const ssh = target.ssh ?? target
    const auth = ssh.auth ?? (ssh.privateKeyPath !== undefined ? 'key' : ssh.password !== undefined ? 'password' : 'agent')
    const cfg = {
      host: ssh.host,
      port: ssh.port ?? 22,
      username: ssh.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: 3,
    }
    if (auth === 'key') cfg.privateKey = resolvePrivateKey(ssh.privateKeyPath, logger)
    else if (auth === 'password') {
      if (ssh.password === undefined) throw new Error(`dsh-ship: 目标 "${target.id ?? ssh.host}" 是 password 认证但未存密码`)
      cfg.password = ssh.password
      if (ssh.passphrase !== undefined) cfg.passphrase = ssh.passphrase
    } else {
      cfg.agent = ssh.agent ?? process.env.SSH_AUTH_SOCK
      if (ssh.passphrase !== undefined) cfg.passphrase = ssh.passphrase
    }
    const { Client } = await import('ssh2').catch(() => {
      throw new Error('dsh-ship: 缺少 ssh2 依赖——请在插件目录执行 npm install（或重装插件以自动装依赖）')
    })
    const client = new Client()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dsh-ship: SSH 连接超时（${CONNECT_TIMEOUT_MS}ms）：${cfg.username}@${cfg.host}:${cfg.port}`)), CONNECT_TIMEOUT_MS + 2000)
      client.once('ready', () => { clearTimeout(timer); resolve() })
      client.once('error', (error) => { clearTimeout(timer); reject(new Error(`dsh-ship: SSH 连接失败 ${cfg.username}@${cfg.host}:${cfg.port} —— ${error.message}`)) })
      client.connect(cfg)
    })
    logger(`dsh-ship: ssh 已连接 ${cfg.username}@${cfg.host}:${cfg.port}`)
    return new SshConnection(client, { host: cfg.host, port: cfg.port, username: cfg.username })
  }

  /** 远端命令：返回 {code, stdout, stderr}；超时即抛。 */
  exec(command, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) { reject(new Error(`dsh-ship: 远端命令执行失败——${error.message}`)); return }
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          stream.close()
          reject(new Error(`dsh-ship: 远端命令超时（${timeoutMs}ms）：${String(command).slice(0, 80)}…`))
        }, timeoutMs)
        stream.on('data', (chunk) => { stdout += String(chunk) })
        stream.stderr.on('data', (chunk) => { stderr += String(chunk) })
        stream.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr })
        })
      })
    })
  }

  /** SFTP 单文件上传（fastPut）。 */
  putFile(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error) { reject(new Error(`dsh-ship: SFTP 通道打开失败——${error.message}`)); return }
        sftp.fastPut(localPath, remotePath, (putError) => {
          if (putError) reject(new Error(`dsh-ship: 上传失败 ${localPath} → ${remotePath}——${putError.message}`))
          else resolve()
        })
      })
    })
  }

  dispose() {
    try { this.client.end() } catch { /* 连接已死则忽略 */ }
  }
}

/** 目标 → 连接的缓存池。 */
export class SshPool {
  constructor(logger = () => {}) {
    this.logger = logger
    this.live = new Map()
  }

  /** 缓存键：持久目标用 id；临时测试目标按坐标。 */
  #keyOf(target) {
    return target.id ?? `ephemeral:${target.ssh?.host ?? target.host}:${target.ssh?.port ?? target.port ?? 22}:${target.ssh?.username ?? target.username ?? ''}`
  }

  async connection(target) {
    const key = this.#keyOf(target)
    const existing = this.live.get(key)
    if (existing !== undefined) return existing
    const connection = await SshConnection.create(target, this.logger)
    this.live.set(key, connection)
    return connection
  }

  async exec(target, command, timeoutMs = 30000) {
    const key = this.#keyOf(target)
    try {
      return await (await this.connection(target)).exec(command, timeoutMs)
    } catch (error) {
      // 断链即出池（下次重建）；测试型临时连接同样处理。
      const connection = this.live.get(key)
      if (connection !== undefined && /超时|失败|ECONNRESET|Socket closed|not open/i.test(error.message)) {
        connection.dispose()
        this.live.delete(key)
      }
      throw error
    }
  }

  async putFile(target, localPath, remotePath) {
    const key = this.#keyOf(target)
    try {
      await (await this.connection(target)).putFile(localPath, remotePath)
    } catch (error) {
      const connection = this.live.get(key)
      if (connection !== undefined && /超时|失败|ECONNRESET|Socket closed|not open/i.test(error.message)) {
        connection.dispose()
        this.live.delete(key)
      }
      throw error
    }
  }

  /** 连接测试（不持久化）：connect → exec true → dispose。对齐 dsh-ssh registry.test。 */
  async test(target) {
    const spec = { id: `test-${Date.now()}`, ...(target.ssh !== undefined ? target : { ssh: target }) }
    const connection = await SshConnection.create(spec, this.logger)
    try {
      const outcome = await connection.exec('true', 10000)
      if (outcome.code !== 0) throw new Error(outcome.stderr.trim() || `远端 true 退出码 ${outcome.code}`)
      return { ok: true, message: `连接成功：${spec.ssh.username}@${spec.ssh.host}:${spec.ssh.port ?? 22}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      connection.dispose()
    }
  }

  dispose(id) {
    const connection = this.live.get(id)
    if (connection !== undefined) {
      connection.dispose()
      this.live.delete(id)
    }
  }

  disposeAll() {
    for (const connection of this.live.values()) connection.dispose()
    this.live.clear()
  }
}
