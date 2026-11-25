// dsh-ship core.js 单元测试（keyless 直测缝）：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../core.js'

test('versionStamp 输出 14 位数字', () => {
  const stamp = core.versionStamp(new Date(2026, 10, 25, 18, 30, 5))
  assert.equal(stamp, '20261125183005')
  assert.ok(core.isVersion(stamp))
  assert.ok(!core.isVersion('2026112518300'))
})

test('shq 单引号包裹与转义', () => {
  assert.equal(core.shq('abc'), "'abc'")
  assert.equal(core.shq("O'Brien"), `'O'\\''Brien'`)
  assert.equal(core.shq('a b;c'), "'a b;c'")
})

test('sitePaths 布局齐备', () => {
  const P = core.sitePaths('/srv/dsh-ship', 't1')
  assert.equal(P.releasesDir, '/srv/dsh-ship/sites/t1/releases')
  assert.equal(P.currentLink, '/srv/dsh-ship/sites/t1/current')
  assert.equal(P.sharedConfig, '/srv/dsh-ship/sites/t1/shared/config.json')
  assert.equal(P.confPath, '/etc/caddy/dsh-ship/t1.caddy')
  assert.equal(P.tgzPath('123'), '/tmp/dsh-ship-123.tgz')
})

test('normalizeTargetInput：合法输入归一化', () => {
  const target = core.normalizeTargetInput({
    host: 'vps.example.com', username: 'root', domain: 'Notes.Example.com',
    privateKeyPath: '~/.ssh/id_ed25519',
  }, [])
  assert.equal(target.id, 't1')
  assert.equal(target.domain, 'notes.example.com')
  assert.equal(target.ssh.auth, 'key')
  assert.equal(target.spa, true)
})

test('normalizeTargetInput：非法输入逐项拒绝', () => {
  assert.throws(() => core.normalizeTargetInput({ host: '', username: 'r', domain: 'a.com' }), /host/)
  assert.throws(() => core.normalizeTargetInput({ host: 'h', username: '', domain: 'a.com' }), /username/)
  assert.throws(() => core.normalizeTargetInput({ host: 'h', username: 'r', domain: 'bad_domain' }), /域名/)
  assert.throws(() => core.normalizeTargetInput({ host: 'h', username: 'r', domain: 'a.com', port: 0 }), /port/)
  assert.throws(() => core.normalizeTargetInput({ host: 'h', username: 'r', domain: 'a.com', auth: 'key' }), /privateKeyPath/)
  assert.throws(() => core.normalizeTargetInput({ host: 'h', username: 'r', domain: 'a.com', auth: 'password' }), /password/)
})

test('nextTargetId 跳过已占用', () => {
  assert.equal(core.nextTargetId([{ id: 't1' }, { id: 't2' }]), 't3')
  assert.equal(core.nextTargetId([{ id: 't2' }]), 't1')
})

test('secretFreeView 不含任何凭据本体', () => {
  const target = core.normalizeTargetInput({
    host: 'h', username: 'root', domain: 'a.com', auth: 'password', password: 'hunter2',
  }, [])
  const view = JSON.stringify(core.secretFreeView(target))
  assert.ok(!view.includes('hunter2'))
  assert.equal(JSON.parse(view).auth, 'password')
})

test('parseProbe 全字段解析', () => {
  const parsed = core.parseProbe([
    'DSHSHIP_UID=0',
    'DSHSHIP_OS=ubuntu',
    'DSHSHIP_CADDY=no',
    'DSHSHIP_PORTS=0.0.0.0:80 [::]:443',
    'DSHSHIP_IP=1.2.3.4',
    'DSHSHIP_PROBE_OK',
  ].join('\n'))
  assert.deepEqual(parsed, { uid: 0, os: 'ubuntu', hasCaddy: false, ports: ['0.0.0.0:80', '[::]:443'], ip: '1.2.3.4', ok: true })
})

test('parseDnsCheck 三分支', () => {
  const good = core.parseDnsCheck('DSHSHIP_DNS=1.2.3.4\nDSHSHIP_DNS_DONE', '1.2.3.4')
  assert.equal(good.ok, true)
  const multiNoIp = core.parseDnsCheck('DSHSHIP_DNS=5.6.7.8 9.10.11.12\nDSHSHIP_DNS_DONE', null)
  assert.equal(multiNoIp.ok, true)
  const mismatch = core.parseDnsCheck('DSHSHIP_DNS=5.6.7.8\nDSHSHIP_DNS_DONE', '1.2.3.4')
  assert.equal(mismatch.ok, false)
  const unresolved = core.parseDnsCheck('DSHSHIP_DNS=\nDSHSHIP_DNS_DONE', '1.2.3.4')
  assert.equal(unresolved.ok, false)
})

test('renderCaddyfile：SPA 开关', () => {
  const spa = core.renderCaddyfile({ domain: 'a.com', root: '/srv/x/current', spa: true })
  assert.ok(spa.includes('a.com {') && spa.includes('try_files {path} /index.html') && spa.includes('file_server'))
  const plain = core.renderCaddyfile({ domain: 'a.com', root: '/srv/x/current', spa: false })
  assert.ok(!plain.includes('try_files'))
})

test('publishScript：解包 + config 软链 + 原子切换', () => {
  const P = core.sitePaths('/srv/dsh-ship', 't1')
  const script = core.publishScript(P, '20260101010101')
  assert.ok(script.includes("tar xzf '/tmp/dsh-ship-20260101010101.tgz'"), 'tgz 路径应经 shq 包裹')
  assert.ok(script.includes('ln -sfn ../shared/config.json'))
  assert.ok(script.includes('mv -T'))
  assert.ok(script.includes('DSHSHIP_PUBLISH_OK'))
})

test('gcSelection：保最新 keep 个 + current 永删', () => {
  const versions = ['20260101010101', '20260101010102', '20260101010103', '20260101010104', '20260101010105', '20260101010106']
  // keep=5，current 是最老版本（刚回滚过去）→ 它也不能删
  assert.deepEqual(core.gcSelection(versions, '20260101010101', 5), [])
  // keep=5，current 是最新 → 删最老 1 个
  assert.deepEqual(core.gcSelection(versions, '20260101010106', 5), ['20260101010101'])
  // keep=2 → 删前 4 个里未被 current 保护的
  assert.deepEqual(core.gcSelection(versions, '20260101010106', 2), ['20260101010101', '20260101010102', '20260101010103', '20260101010104'])
})

test('parseReleases 只收 14 位版本并排序', () => {
  assert.deepEqual(
    core.parseReleases('20260101010102 junk releases/20260101010103 20260101010101\n'),
    ['20260101010101', '20260101010102'],
  )
})

test('parseStatus 全字段', () => {
  const parsed = core.parseStatus([
    'DSHSHIP_CURRENT=20260101010102',
    'DSHSHIP_RELEASES=20260101010101 20260101010102',
    'DSHSHIP_DISK=12M',
    'DSHSHIP_CERT_END=Jan  1 00:00:00 2027 GMT',
    'DSHSHIP_HTTP=200',
    'DSHSHIP_STATUS_DONE',
  ].join('\n'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.current, '20260101010102')
  assert.equal(parsed.http, '200')
  assert.equal(parsed.releases.length, 2)
})

test('validateConfigContent：非 JSON/非对象拒绝', () => {
  assert.throws(() => core.validateConfigContent(''), /非空/)
  assert.throws(() => core.validateConfigContent('not json'), /JSON/)
  assert.throws(() => core.validateConfigContent('[]'), /对象/)
  assert.deepEqual(core.validateConfigContent('{"a":1}'), { a: 1 })
})

test('withSudo：root 直跑；非 root base64 落临时文件整段执行', () => {
  const script = 'set -e\necho hi'
  assert.equal(core.withSudo(script, 0), script)
  const wrapped = core.withSudo(script, 1000)
  assert.ok(wrapped.includes('base64 -d') && wrapped.includes('sudo -n sh /tmp/dsh-ship-run.sh'))
})

test('parseState：损坏降级为空态，垃圾条目被丢弃', () => {
  assert.deepEqual(core.parseState('not json'), { targets: [], history: {} })
  const state = core.parseState(JSON.stringify({
    targets: [{ id: 't1', domain: 'a.com', ssh: { host: 'h', username: 'r' } }, { junk: true }],
    history: { t1: [{ version: '1' }], t2: 'not-array' },
  }))
  assert.equal(state.targets.length, 1)
  assert.equal(state.history.t1.length, 1)
  assert.equal(state.history.t2, undefined)
})

test('configSetScript 原子写且不含远端 JSON 校验依赖', () => {
  const P = core.sitePaths('/srv/dsh-ship', 't1')
  const script = core.configSetScript(P, '{"a":1}')
  assert.ok(script.includes('config.json.tmp') && script.includes('mv -T') && script.includes('DSHSHIP_CONFIG_OK'))
  assert.ok(!script.includes('python3'), '不应依赖 python3（最小系统可能没有）')
})
