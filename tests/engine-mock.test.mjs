// dsh-ship 引擎 mock 集成测试：假连接池（不装 ssh2、不连真服务器），
// 走通 publish/rollback/config/status/logs/RPC 全编排与失败路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShipService } from '../host-service.js'

const PREV = '20260101010101'
const OLD_RELEASES = [
  '20260101010101', '20260101010102', '20260101010103',
  '20260101010104', '20260101010105', '20260101010106',
]

/** 真实临时产物目录（含 index.html）——packDist 会实际校验并 tar。 */
function makeDist() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ship-dist-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)')
  return dir
}

/** 假 SSH 连接：按脚本特征回应引擎发出的远端命令，并记录全部命令。 */
function makeConn(options = {}) {
  const conn = { cmds: [], puts: [] }
  const respond = (cmd) => {
    conn.cmds.push(cmd)
    const out = (stdout) => ({ code: 0, stdout, stderr: '' })
    if (cmd.includes('DSHSHIP_PROBE_OK')) {
      return out(['DSHSHIP_UID=0', 'DSHSHIP_OS=ubuntu', 'DSHSHIP_CADDY=yes', 'DSHSHIP_PORTS=', 'DSHSHIP_IP=1.2.3.4', 'DSHSHIP_PROBE_OK'].join('\n'))
    }
    if (cmd.includes('DSHSHIP_STATUS_DONE')) {
      return out(['DSHSHIP_CURRENT=' + (options.current ?? ''), `DSHSHIP_RELEASES=${(options.releases ?? []).join(' ')}`, 'DSHSHIP_DISK=1M', 'DSHSHIP_CERT_END=Jan  1 00:00:00 2027 GMT', `DSHSHIP_HTTP=${options.health ?? '200'}`, 'DSHSHIP_STATUS_DONE'].join('\n'))
    }
    if (cmd.includes('DSHSHIP_ROLLBACK_OK')) return out(`DSHSHIP_ROLLBACK_OK=${options.rollbackTo ?? ''}`)
    if (cmd.includes('DSHSHIP_PUBLISH_OK')) return out('DSHSHIP_PUBLISH_OK')
    if (cmd.includes('DSHSHIP_IMPORT_OK')) return out('DSHSHIP_IMPORT_OK')
    if (cmd.includes('DSHSHIP_CONF_OK')) return out('DSHSHIP_CONF_OK')
    if (cmd.includes('DSHSHIP_RELOAD_OK')) return out('DSHSHIP_RELOAD_OK')
    if (cmd.includes('DSHSHIP_CONFIG_OK')) return out('DSHSHIP_CONFIG_OK')
    if (cmd.includes('DSHSHIP_GC')) return out('DSHSHIP_GC_OK')
    if (cmd.includes('DSHSHIP_DNS=')) return out('DSHSHIP_DNS=1.2.3.4\nDSHSHIP_DNS_DONE')
    if (cmd.startsWith('readlink')) return out(options.current ? `${options.current}\n` : '') // 模拟命令里 sed 已剥掉 releases/ 前缀
    if (cmd.startsWith('curl')) return out(`${options.health ?? '200'}\n`)
    if (cmd.includes('ls -1')) return out(`${(options.releases ?? []).join(' ')}\n`)
    if (cmd.startsWith('cat') && cmd.includes('config.json')) return out(`${options.config ?? '{"a":1}'}\n`)
    if (cmd.includes('journalctl')) return out('log line 1\nlog line 2\n')
    if (cmd === 'true' || cmd === 'sudo -n true') return out('')
    return out('')
  }
  conn.exec = async (cmd) => respond(cmd)
  conn.putFile = async (local, remote) => { conn.puts.push({ local, remote }) }
  return conn
}

/** 假连接池：connection 恒返同一假连接。 */
function fakePool(conn) {
  return {
    connection: async () => conn,
    test: async () => ({ ok: true, message: '连接成功' }),
    putFile: async (_target, local, remote) => { conn.puts.push({ local, remote }) },
    dispose: () => {},
    disposeAll: () => {},
  }
}

function makeService(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ship-state-'))
  const conn = makeConn(options)
  const svc = createShipService({
    ctx: { logger: () => {} },
    config: { statePath: join(dir, 'targets.json'), healthWait: { attempts: 2, delayMs: 10 } },
    deps: { pool: fakePool(conn) },
  })
  return { svc, conn, dir }
}

async function addTarget(svc) {
  const added = await svc.rpcInvoke('targets.add', {
    host: 'vps.example.com', username: 'root', domain: 'a.com', auth: 'password', password: 'pw-secret-123',
  })
  assert.equal(added.ok, true)
  return added.target
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })

test('首次发布全流程：打包上传→发布→健康→GC→记历史', async () => {
  const dist = makeDist()
  const { svc, conn, dir } = makeService({ current: null, releases: OLD_RELEASES })
  try {
    const target = await addTarget(svc)
    assert.equal(target.id, 't1')
    const result = await svc.publish('t1', dist, '首次上线')
    assert.equal(result.ok, true)
    assert.match(result.version, /^\d{14}$/)
    assert.equal(result.url, 'https://a.com/')
    // 上传路径与版本一致
    assert.equal(conn.puts[0].remote, `/tmp/dsh-ship-${result.version}.tgz`)
    // 发布脚本包含原子切换；GC 只删最老 1 个（6 旧 + 新版本，keep=5）
    const publishCmd = conn.cmds.find((c) => c.includes('DSHSHIP_PUBLISH_OK'))
    assert.ok(publishCmd.includes('mv -T'))
    const gcCmd = conn.cmds.find((c) => c.includes('DSHSHIP_GC'))
    assert.ok(gcCmd.includes('/20260101010101'))
    assert.ok(!gcCmd.includes('/20260101010102'))
    // 历史已持久化（等异步写盘完成后读 state 落盘）
    await svc.registry.flush()
    const state = JSON.parse(readFileSync(svc.config.statePath, 'utf8'))
    assert.equal(state.history.t1.at(-1).result, 'ok')
    assert.equal(state.history.t1.at(-1).note, '首次上线')
  } finally {
    cleanup(dir)
    rmSync(dist, { recursive: true, force: true })
  }
})

test('健康检查失败：autoRollback 自动回滚上一版并记失败', async () => {
  const dist = makeDist()
  const { svc, conn, dir } = makeService({ current: PREV, releases: OLD_RELEASES, health: '000' })
  try {
    await addTarget(svc)
    await assert.rejects(svc.publish('t1', dist), /已自动回滚/)
    const rollbackCmd = conn.cmds.find((c) => c.includes('DSHSHIP_ROLLBACK_OK'))
    assert.ok(rollbackCmd.includes(`/releases/${PREV}`))
    await svc.registry.flush()
    const state = JSON.parse(readFileSync(svc.config.statePath, 'utf8'))
    assert.equal(state.history.t1.at(-1).result, 'failed-rolled-back')
  } finally {
    cleanup(dir)
    rmSync(dist, { recursive: true, force: true })
  }
})

test('部署锁：同一目标并发发布被拒', async () => {
  const dist = makeDist()
  const { svc, dir } = makeService({ current: PREV, releases: OLD_RELEASES, health: '000' })
  try {
    await addTarget(svc)
    const first = svc.publish('t1', dist)
    await assert.rejects(svc.publish('t1', dist), /正在部署中/)
    await assert.rejects(first, /已自动回滚/)
  } finally {
    cleanup(dir)
    rmSync(dist, { recursive: true, force: true })
  }
})

test('rollback：缺省回滚上一版；显式版本与非法输入各有明确报错', async () => {
  const { svc, conn, dir } = makeService({ current: '20260101010103', releases: OLD_RELEASES })
  try {
    await addTarget(svc)
    const result = await svc.rollback('t1')
    assert.equal(result.ok, true)
    assert.equal(result.version, '20260101010102')
    const rollbackCmd = conn.cmds.find((c) => c.includes('DSHSHIP_ROLLBACK_OK'))
    assert.ok(rollbackCmd.includes('/releases/20260101010102'))

    await assert.rejects(svc.rollback('t1', '999'), /版本号形状/)
    await assert.rejects(svc.rollback('t1', '20260101010199'), /远端没有版本/)
  } finally {
    cleanup(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config 热更新：本地校验前置，远端原子写', async () => {
  const { svc, conn, dir } = makeService({})
  try {
    await addTarget(svc)
    const result = await svc.configSet('t1', '{"apiBase":"https://api.example.com"}')
    assert.equal(result.ok, true)
    const cmd = conn.cmds.find((c) => c.includes('DSHSHIP_CONFIG_OK'))
    assert.ok(cmd.includes('config.json.tmp') && cmd.includes('mv -T'))
    await assert.rejects(svc.configSet('t1', 'not json'), /JSON/)
    await assert.rejects(svc.configSet('t1', '[]'), /对象/)
    const got = await svc.configGet('t1')
    assert.equal(got.content, '{"a":1}')
  } finally {
    cleanup(dir)
  }
})

test('status 与 logs 编排', async () => {
  const { svc, dir } = makeService({ current: PREV, releases: OLD_RELEASES })
  try {
    await addTarget(svc)
    const st = await svc.status('t1')
    assert.equal(st.ok, true)
    assert.equal(st.current, PREV)
    assert.equal(st.http, '200')
    const logs = await svc.logs('t1', 10)
    assert.ok(logs.message.includes('log line 1'))
    await assert.rejects(svc.status('tX'), /没有发布目标/)
  } finally {
    cleanup(dir)
  }
})

test('RPC 面：targets 增删/列表 fail-closed', async () => {
  const { svc, dir } = makeService({})
  try {
    const view = await addTarget(svc)
    assert.ok(!JSON.stringify(view).includes('pw-secret-123'), '无密视图不应含密码本体')
    const list = await svc.rpcInvoke('targets.list')
    assert.equal(list.targets.length, 1)
    assert.equal(list.targets[0].domain, 'a.com')
    await assert.rejects(() => svc.rpcInvoke('targets.add', { host: 'x', username: 'r', domain: 'bad' }), /域名/)
    const removed = await svc.rpcInvoke('targets.remove', { id: 't1' })
    assert.equal(removed.removed, true)
    const after = await svc.rpcInvoke('targets.list')
    assert.equal(after.targets.length, 0)
    const unknown = await svc.rpcInvoke('nope.nope')
    assert.equal(unknown.ok, false)
    assert.ok(unknown.message.includes('支持'))
  } finally {
    cleanup(dir)
  }
})
