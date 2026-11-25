// dsh-ship — 语义核（纯逻辑，零 import，keyless 直测缝）。
//
// 职责：远端 shell 模板、探测/健康输出解析、目标输入校验与无密视图、
// 状态文件序列化、版本命名与 GC 选择。宿主服务（host-service.js）只做编排，
// 所有可单测的判断都在本文件。
//
// 纪律：本文件不得 import 任何东西（对齐 dsh-local-llm core.js 的零宿主包纪律；
// Buffer 是 Node 全局，不算 import）。shell 片段一律 POSIX sh + GNU 工具
// （Phase 1 只承诺 Ubuntu/Debian）。所有插值进 shell 前必须过 shq()，杜绝注入面。

// ---------- 常量与缺省 ----------

export const DEFAULTS = {
  remoteRoot: '/srv/dsh-ship',
  maxVersions: 5,
  autoRollback: true,
}

export const HISTORY_KEEP = 20

/** 版本号：服务器本地时间语义由部署时刻给定，本函数只做 YYYYMMDDHHmmss 格式化。 */
export function versionStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 版本号形状校验（14 位数字）。 */
export function isVersion(value) {
  return typeof value === 'string' && /^\d{14}$/.test(value)
}

// ---------- shell 工具 ----------

/** 单引号安全包裹（O'Brien → 'O'\''Brien'）。所有插值进 shell 前必须过这里。 */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// ---------- 路径布局 ----------

/** 远端目录布局（设计文档 §5）。 */
export function sitePaths(remoteRoot, targetId) {
  const siteDir = `${remoteRoot}/sites/${targetId}`
  return {
    siteDir,
    releasesDir: `${siteDir}/releases`,
    sharedDir: `${siteDir}/shared`,
    sharedConfig: `${siteDir}/shared/config.json`,
    currentLink: `${siteDir}/current`,
    confPath: `/etc/caddy/dsh-ship/${targetId}.caddy`,
    tgzPath: (version) => `/tmp/dsh-ship-${version}.tgz`,
  }
}

// ---------- 状态文件 ----------

export function defaultStatePath() {
  const home = process.env.DSH_HOME || `${process.env.HOME || ''}/.dsh`
  return `${home}/dsh-ship-targets.json`
}

/** 解析并净化 state 文本；损坏/缺字段一律降级为空态（不抛）。 */
export function parseState(text) {
  const state = { targets: [], history: {} }
  if (typeof text !== 'string' || text.trim() === '') return state
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return state
  }
  if (Array.isArray(raw?.targets)) {
    for (const t of raw.targets) {
      if (t && typeof t === 'object' && typeof t.id === 'string' && typeof t.domain === 'string'
        && t.ssh && typeof t.ssh.host === 'string' && typeof t.ssh.username === 'string') {
        state.targets.push(t)
      }
    }
  }
  if (raw?.history && typeof raw.history === 'object') {
    for (const [id, list] of Object.entries(raw.history)) {
      if (Array.isArray(list)) state.history[id] = list.filter((e) => e && typeof e === 'object')
    }
  }
  return state
}

export function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** 分配下一个目标 id：t1、t2…（跳过已占用）。 */
export function nextTargetId(targets) {
  const used = new Set(targets.map((t) => t.id))
  for (let n = 1; ; n += 1) {
    const id = `t${n}`
    if (!used.has(id)) return id
  }
}

// ---------- 目标输入校验 ----------

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/

/**
 * 校验并归一化「添加目标」输入（RPC 面与未来表单共用）。
 * 返回新 target；非法即抛带中文指引的 Error。凭据字段原样保留在返回值里，
 * 调用方持久化；对外展示一律走 secretFreeView()。
 */
export function normalizeTargetInput(input, existingTargets = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('dsh-ship: 输入必须为对象')
  }
  const host = String(input.host ?? '').trim()
  if (host === '') throw new Error('dsh-ship: host 必须为非空字符串（服务器地址或 ~/.ssh/config 别名）')
  const username = String(input.username ?? '').trim()
  if (username === '') throw new Error('dsh-ship: username 必须为非空字符串')
  const domain = String(input.domain ?? '').trim().toLowerCase()
  if (!DOMAIN_RE.test(domain)) {
    throw new Error(`dsh-ship: 域名不合法 "${domain}"——需要形如 notes.example.com 的完整域名（将作为访问地址与证书名）`)
  }
  const port = input.port === undefined ? 22 : input.port
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`dsh-ship: port 必须为 1..65535 的整数，收到 ${JSON.stringify(input.port)}`)
  }
  const auth = input.auth ?? (input.privateKeyPath !== undefined ? 'key' : input.password !== undefined ? 'password' : undefined)
  if (auth !== 'key' && auth !== 'password' && auth !== 'agent') {
    throw new Error('dsh-ship: auth 必须为 key / password / agent 之一（缺省由提供的凭据字段推断）')
  }
  if (auth === 'key' && (input.privateKeyPath === undefined || String(input.privateKeyPath).trim() === '')) {
    throw new Error('dsh-ship: auth=key 需要提供 privateKeyPath（私钥路径）')
  }
  if (auth === 'password' && (input.password === undefined || String(input.password) === '')) {
    throw new Error('dsh-ship: auth=password 需要提供 password')
  }
  const label = String(input.label ?? '').trim() || domain
  const spa = input.spa === undefined ? true : input.spa === true
  return {
    id: nextTargetId(existingTargets),
    label,
    domain,
    spa,
    createdAt: new Date().toISOString(),
    ssh: {
      host,
      port,
      username,
      auth,
      ...(input.privateKeyPath !== undefined && String(input.privateKeyPath).trim() !== ''
        ? { privateKeyPath: String(input.privateKeyPath).trim() } : {}),
      ...(auth === 'password' && input.password !== undefined ? { password: String(input.password) } : {}),
      ...(input.passphrase !== undefined && String(input.passphrase) !== '' ? { passphrase: String(input.passphrase) } : {}),
      ...(input.agent !== undefined && String(input.agent).trim() !== '' ? { agent: String(input.agent).trim() } : {}),
      ...(Array.isArray(input.knownHosts) && input.knownHosts.length > 0
        ? { knownHosts: input.knownHosts.map(String) } : {}),
    },
  }
}

/** 无密视图：auth 只留认证方式名；privateKeyPath 保留（路径非密钥本体）。 */
export function secretFreeView(target) {
  return {
    id: target.id,
    label: target.label,
    domain: target.domain,
    spa: target.spa === true,
    auth: target.ssh.auth,
    host: target.ssh.host,
    port: target.ssh.port,
    username: target.ssh.username,
    ...(target.ssh.privateKeyPath !== undefined ? { privateKeyPath: target.ssh.privateKeyPath } : {}),
  }
}

// ---------- 探测脚本与解析 ----------

/** 一次性环境探测（root/系统/Caddy/端口占用/公网 IP）。输出 DSHSHIP_* 键值行。 */
export function probeScript() {
  return [
    'echo "DSHSHIP_UID=$(id -u 2>/dev/null || echo ?)"',
    `echo "DSHSHIP_OS=$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | head -1 | tr -d '"')"`,
    'echo "DSHSHIP_CADDY=$(command -v caddy >/dev/null 2>&1 && echo yes || echo no)"',
    `echo "DSHSHIP_PORTS=$(ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' | tr '\\n' ' ')"`,
    'echo "DSHSHIP_IP=$(curl -4s -m 6 https://api.ipify.org 2>/dev/null || echo)"',
    'echo DSHSHIP_PROBE_OK',
  ].join('\n')
}

/** 解析 probeScript 输出。 */
export function parseProbe(stdout) {
  const out = { uid: null, os: null, hasCaddy: false, ports: [], ip: null, ok: false }
  for (const line of String(stdout).split('\n')) {
    if (line === 'DSHSHIP_PROBE_OK') { out.ok = true; continue }
    const eq = line.indexOf('=')
    if (eq <= 0 || !line.startsWith('DSHSHIP_')) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1).trim()
    if (key === 'DSHSHIP_UID') out.uid = value === '?' ? null : Number(value)
    else if (key === 'DSHSHIP_OS') out.os = value === '' ? null : value
    else if (key === 'DSHSHIP_CADDY') out.hasCaddy = value === 'yes'
    else if (key === 'DSHSHIP_PORTS') out.ports = value === '' ? [] : value.split(/\s+/).filter(Boolean)
    else if (key === 'DSHSHIP_IP') out.ip = value === '' ? null : value
    else if (key === 'DSHSHIP_PROBE_OK') out.ok = true
  }
  return out
}

/** Caddy 安装（Ubuntu/Debian 官方 apt 源）。root 直跑；非 root 由 withSudo 包裹。 */
export function installCaddyScript() {
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null',
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list",
    'apt-get update -qq',
    'apt-get install -y -qq caddy >/dev/null',
    'command -v caddy >/dev/null 2>&1 && echo DSHSHIP_INSTALL_OK',
  ].join('\n')
}

/** 主 Caddyfile 追加 import 行（幂等；按 import 语句本身判重）。 */
export function ensureImportScript() {
  const importLine = 'import /etc/caddy/dsh-ship/*.caddy'
  return [
    'set -e',
    '[ -f /etc/caddy/Caddyfile ] || : > /etc/caddy/Caddyfile',
    `grep -qF ${shq(importLine)} /etc/caddy/Caddyfile 2>/dev/null || printf '\\n# dsh-ship managed sites\\n%s\\n' ${shq(importLine)} >> /etc/caddy/Caddyfile`,
    'echo DSHSHIP_IMPORT_OK',
  ].join('\n')
}

/** 写单站点 conf（幂等覆盖）+ 主配置语法校验（此时 import 的 conf 已存在）。 */
export function writeSiteConfScript(confPath, caddyfile) {
  const dir = confPath.slice(0, confPath.lastIndexOf('/'))
  return [
    'set -e',
    `mkdir -p ${shq(dir)}`,
    `printf '%s\\n' ${shq(caddyfile)} > ${shq(confPath)}`,
    'caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo DSHSHIP_ERR_CADDY_INVALID; exit 1; }',
    'echo DSHSHIP_CONF_OK',
  ].join('\n')
}

/**
 * 渲染单站点 Caddyfile。domain 已过 DOMAIN_RE（安全字符集，可裸插）；
 * root 须来自 remoteRoot 校验后的 sitePaths（host-service 在 apply 时校验
 * remoteRoot 形状，禁空格/引号/分号）。
 */
export function renderCaddyfile({ domain, root, spa }) {
  return [
    `${domain} {`,
    `\troot * ${root}`,
    '\tencode gzip zstd',
    '\tfile_server',
    ...(spa === true ? ['\ttry_files {path} /index.html'] : []),
    '}',
  ].join('\n')
}

export function reloadCaddyScript() {
  return [
    'set -e',
    'systemctl reload caddy 2>/dev/null || systemctl restart caddy',
    'systemctl is-active caddy >/dev/null && echo DSHSHIP_RELOAD_OK',
  ].join('\n')
}

// ---------- DNS ----------

export function dnsCheckScript(domain) {
  return [
    'set -e',
    `echo "DSHSHIP_DNS=$(getent hosts ${shq(domain)} 2>/dev/null | awk '{print $1}' | sort -u | tr '\\n' ' ')"`,
    'echo DSHSHIP_DNS_DONE',
  ].join('\n')
}

/**
 * 解析 DNS 检查。resolved: getent 输出的 A 记录；serverIp: 探测到的本机公网 IP。
 * 要求域名已解析且（能探到公网 IP 时）指向本机——前置拦住「证书对错 DNS 反复撞」。
 */
export function parseDnsCheck(stdout, serverIp) {
  let resolved = []
  let done = false
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('DSHSHIP_DNS=')) {
      resolved = line.slice('DSHSHIP_DNS='.length).trim().split(/\s+/).filter(Boolean)
    } else if (line === 'DSHSHIP_DNS_DONE') done = true
  }
  const ok = done && resolved.length > 0 && (serverIp === null || resolved.includes(serverIp))
  return { resolved, serverIp, ok, done }
}

// ---------- 发布 / 回滚 / GC ----------

/**
 * 发布脚本：建目录 → 解包 → 补 config.json 软链（热更新入口）→ 原子切 current
 * → 清理 tgz。set -e 即停，引擎看 marker 判定成功。
 */
export function publishScript(P, version) {
  const tgz = P.tgzPath(version)
  return [
    'set -e',
    `mkdir -p ${shq(P.releasesDir)} ${shq(P.sharedDir)}`,
    `[ -f ${shq(P.sharedConfig)} ] || printf '{}\\n' > ${shq(P.sharedConfig)}`,
    `mkdir -p ${shq(`${P.releasesDir}/${version}`)}`,
    `tar xzf ${shq(tgz)} -C ${shq(`${P.releasesDir}/${version}`)}`,
    `ln -sfn ../shared/config.json ${shq(`${P.releasesDir}/${version}/config.json`)}`,
    `ln -sfn ${shq(`releases/${version}`)} ${shq(`${P.siteDir}/current.tmp`)}`,
    `mv -T ${shq(`${P.siteDir}/current.tmp`)} ${shq(P.currentLink)}`,
    `rm -f ${shq(tgz)}`,
    'echo DSHSHIP_PUBLISH_OK',
  ].join('\n')
}

export function rollbackScript(P, version) {
  return [
    'set -e',
    `[ -d ${shq(`${P.releasesDir}/${version}`)} ] || { echo DSHSHIP_ERR_MISSING_VERSION; exit 1; }`,
    `ln -sfn ${shq(`releases/${version}`)} ${shq(`${P.siteDir}/current.tmp`)}`,
    `mv -T ${shq(`${P.siteDir}/current.tmp`)} ${shq(P.currentLink)}`,
    `echo DSHSHIP_ROLLBACK_OK=${version}`,
  ].join('\n')
}

/**
 * GC 选择：保留最新 keep 个；current 指向的版本永不删。
 * versions 为 14 位时间戳数组（字典序即时间序）。
 */
export function gcSelection(versions, current, keep) {
  const list = [...new Set(versions.filter(isVersion))].sort()
  const protect = new Set(current !== null ? [current] : [])
  for (const v of list.slice(-keep)) protect.add(v)
  return list.filter((v) => !protect.has(v))
}

export function gcScript(P, doomed) {
  if (doomed.length === 0) return 'echo DSHSHIP_GC_SKIP'
  const rm = doomed.map((v) => shq(`${P.releasesDir}/${v}`)).join(' ')
  return ['set -e', `rm -rf ${rm}`, 'echo DSHSHIP_GC_OK'].join('\n')
}

/** 列 releases（引擎用于 GC 与回滚候选）。 */
export function listReleasesScript(P) {
  return `ls -1 ${shq(P.releasesDir)} 2>/dev/null | tr '\\n' ' '`
}

export function parseReleases(stdout) {
  return String(stdout).trim().split(/\s+/).filter(isVersion).sort()
}

// ---------- 健康检查 / 状态 / 日志 / 配置 ----------

/** 单次健康探测（引擎带重试）。 */
export function healthCheckScript(domain) {
  return `curl -fsS -m 8 -o /dev/null -w '%{http_code}' ${shq(`https://${domain}/`)} 2>/dev/null || echo 000`
}

export function statusScript(P, domain) {
  return [
    'set -e',
    `echo "DSHSHIP_CURRENT=$(readlink ${shq(P.currentLink)} 2>/dev/null | sed 's#^releases/##' || echo)"`,
    `echo "DSHSHIP_RELEASES=$(ls -1 ${shq(P.releasesDir)} 2>/dev/null | tr '\\n' ' ')"`,
    `echo "DSHSHIP_DISK=$(du -sh ${shq(P.siteDir)} 2>/dev/null | cut -f1)"`,
    `echo "DSHSHIP_CERT_END=$(echo | openssl s_client -servername ${shq(domain)} -connect ${shq(`${domain}:443`)} 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"`,
    `echo "DSHSHIP_HTTP=$(curl -fsS -m 8 -o /dev/null -w '%{http_code}' ${shq(`https://${domain}/`)} 2>/dev/null || echo 000)"`,
    'echo DSHSHIP_STATUS_DONE',
  ].join('\n')
}

export function parseStatus(stdout) {
  const out = { current: null, releases: [], disk: null, certEnd: null, http: null, ok: false }
  for (const line of String(stdout).split('\n')) {
    if (line === 'DSHSHIP_STATUS_DONE') { out.ok = true; continue }
    const eq = line.indexOf('=')
    if (eq <= 0 || !line.startsWith('DSHSHIP_')) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1).trim()
    if (key === 'DSHSHIP_CURRENT') out.current = value === '' ? null : value
    else if (key === 'DSHSHIP_RELEASES') out.releases = value === '' ? [] : value.split(/\s+/).filter(isVersion).sort()
    else if (key === 'DSHSHIP_DISK') out.disk = value === '' ? null : value
    else if (key === 'DSHSHIP_CERT_END') out.certEnd = value === '' ? null : value
    else if (key === 'DSHSHIP_HTTP') out.http = value === '' ? null : value
    else if (key === 'DSHSHIP_STATUS_DONE') out.ok = true
  }
  return out
}

export function logScript(tail) {
  const n = Number.isInteger(tail) && tail > 0 ? Math.min(tail, 500) : 60
  return `journalctl -u caddy -n ${n} --no-pager -q 2>/dev/null | tail -${n} || echo DSHSHIP_NO_LOGS`
}

/** 配置热更新：本地已校验 JSON；远端原子写（tmp + mv -T），不重启动任何服务。 */
export function configSetScript(P, content) {
  return [
    'set -e',
    `mkdir -p ${shq(P.sharedDir)}`,
    `printf '%s' ${shq(content)} > ${shq(`${P.sharedDir}/config.json.tmp`)}`,
    `mv -T ${shq(`${P.sharedDir}/config.json.tmp`)} ${shq(P.sharedConfig)}`,
    'echo DSHSHIP_CONFIG_OK',
  ].join('\n')
}

export function configGetScript(P) {
  return `cat ${shq(P.sharedConfig)} 2>/dev/null || echo '{}'`
}

/** 本地侧配置内容校验（引擎在发脚本前先挡一道）。 */
export function validateConfigContent(content) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('dsh-ship: 配置内容必须为非空字符串（JSON 文本）')
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`dsh-ship: 配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('dsh-ship: 配置必须是 JSON 对象（顶层 {}）')
  }
  return parsed
}

// ---------- sudo ----------

/**
 * uid!==0 时把整段脚本 base64 编码，远端落临时文件后 `sudo -n sh` 执行——
 * 保住 set -e 的整段语义（逐行包 sudo 会把它拆散）。
 */
export function withSudo(script, uid) {
  if (uid === 0) return script
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  return [
    'set -e',
    `printf '%s' ${shq(b64)} | base64 -d > /tmp/dsh-ship-run.sh`,
    'sudo -n sh /tmp/dsh-ship-run.sh',
    'rm -f /tmp/dsh-ship-run.sh',
  ].join('\n')
}
