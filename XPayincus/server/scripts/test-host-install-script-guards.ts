import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const hostInstallScript = readFileSync(resolve(__dirname, '../templates/install.sh'), 'utf8').replace(/\r\n/g, '\n')
const caddyInstallScript = readFileSync(resolve(__dirname, '../templates/caddy.sh'), 'utf8')
const hostRoutes = readFileSync(resolve(__dirname, '../src/routes/hosts.ts'), 'utf8')
const zhCnLocale = readFileSync(resolve(__dirname, '../../client/src/locales/zh-CN.ts'), 'utf8')
const zhTwLocale = readFileSync(resolve(__dirname, '../../client/src/locales/zh-TW.ts'), 'utf8')
const enLocale = readFileSync(resolve(__dirname, '../../client/src/locales/en.ts'), 'utf8')
const installPanel = readFileSync(resolve(__dirname, '../../scripts/install-panel.sh'), 'utf8')
const systemctlWrapper = readFileSync(resolve(__dirname, '../../deploy/incudal-systemctl-wrapper.sh.example'), 'utf8')
const apiEntrypoint = readFileSync(resolve(__dirname, '../../deploy/compose/api-entrypoint.sh'), 'utf8')
const panelCertificate = readFileSync(resolve(__dirname, '../src/lib/incus/panel-certificate.ts'), 'utf8')
const startupCertificate = readFileSync(resolve(__dirname, '../src/scripts/ensure-panel-certificate.ts'), 'utf8').replace(/\r\n/g, '\n')

assert.ok(
  startupCertificate.includes('lstatSync(path)') &&
    startupCertificate.includes("code === 'ENOENT'") &&
    startupCertificate.includes('Boolean(process.env.PANEL_CRT_PATH) !== Boolean(process.env.PANEL_KEY_PATH)') &&
    startupCertificate.includes('!pathExists(certPath) && !pathExists(keyPath)') &&
    startupCertificate.includes('chmodSync(temporaryKey, 0o600)') &&
    startupCertificate.indexOf('readPanelCertificatePair(temporaryCert, temporaryKey)') < startupCertificate.indexOf('linkSync(temporaryKey, keyPath)') &&
    startupCertificate.includes('readPanelCertificatePair(certPath, keyPath)') &&
    !startupCertificate.includes('linkSync(temporaryKey, keyPath,') &&
    !startupCertificate.includes('existsSync('),
  'startup must treat dangling links as existing paths, validate staged and published pairs, and reject generation failures without raw crypto errors'
)

assert.ok(
  installPanel.includes('install_verified_root_helpers_from_archive') &&
    installPanel.includes('install -o root -g root -m 0755 "$tmp" /usr/local/libexec/incudal/incudal-online-task') &&
    installPanel.includes('chown "root:${RUN_USER}" "$ENV_FILE"') &&
    installPanel.includes('chmod 640 "$ENV_FILE"'),
  'panel installer must install the fixed OTA entry from the verified archive and keep root unit env service-read-only'
)
assert.ok(
  systemctlWrapper.includes('[[ "$#" -ne 3 || "$1" != "start" || "$2" != "--no-block" ]]') &&
    systemctlWrapper.includes('^incudal-online-(update|rollback)@[1-9][0-9]*\\.service$') &&
    systemctlWrapper.includes('exec /usr/bin/systemctl start --no-block "$UNIT_NAME"'),
  'sudo systemctl wrapper must reject extra arguments and non-OTA unit names'
)

assert.ok(
  hostInstallScript.includes('明确支持 Debian 12/13') &&
    hostInstallScript.includes('Debian 11 可兼容安装，但推荐使用 Debian 12/13') &&
    hostInstallScript.includes('if [[ "$deb_major" -lt 11 ]]') &&
    hostInstallScript.includes('if [[ "$deb_major" -eq 11 ]]'),
  'host install script must explicitly support Debian 12/13 while keeping Debian 11 as best-effort compatibility'
)

assert.ok(
  hostInstallScript.includes('if [[ -f /etc/apt/sources.list.d/debian.sources ]]') &&
    hostInstallScript.includes('sed -i \'s/Components: main$/Components: main contrib/\'') &&
    hostInstallScript.includes('Debian 12+'),
  'host install script must keep Debian 12+ DEB822 apt-source handling for ZFS contrib packages'
)

assert.ok(
  hostInstallScript.includes('normalize_agent_interval()') &&
    hostInstallScript.includes('local value="${1:-60}"') &&
    hostInstallScript.includes('value >= 30 && value <= 3600') &&
    hostInstallScript.includes('Agent 上报间隔秒数 [默认 60，范围 30-3600]'),
  'host install script must keep Agent heartbeat interval at a conservative 60s default and 30s minimum'
)

assert.ok(
  hostInstallScript.includes('cert_file=$(mktemp /tmp/incudal-panel-cert.XXXXXX.crt)') &&
    hostInstallScript.includes('--config - -o "$cert_file" 2>/dev/null') &&
    !hostInstallScript.includes('curl -sSf "$cert_url"') &&
    hostInstallScript.includes('fetch_authenticated_panel_certificate certificate') &&
    hostInstallScript.includes('fetch_authenticated_panel_certificate verify') &&
    hostInstallScript.includes('hmac.compare_digest(proof, expected)') &&
    hostInstallScript.includes('incus config trust remove "$old"') &&
    !hostInstallScript.slice(hostInstallScript.indexOf('import_cert() {'), hostInstallScript.indexOf('install_incudal_agent() {')).includes('incus config trust remove panel') &&
    hostInstallScript.includes('incus config trust add-certificate "$cert_file" --name panel') &&
    !hostInstallScript.includes('面板证书已存在，跳过导入'),
  'host install script must authenticate certificate rotation and verify connectivity before removing old fingerprints'
)

assert.ok(
  caddyInstallScript.includes('auto_https disable_redirects') &&
    caddyInstallScript.indexOf('auto_https disable_redirects') > caddyInstallScript.indexOf('admin localhost:2019') &&
    caddyInstallScript.indexOf('auto_https disable_redirects') < caddyInstallScript.indexOf(':${CADDY_PORT} {'),
  'Caddy install script must disable automatic HTTP to HTTPS redirects so it does not bind port 80 on shared hosts'
)

assert.ok(
  hostInstallScript.includes('独立 IPv4') &&
    hostInstallScript.includes('独立 IPv4 + 独立 IPv6') &&
    hostInstallScript.includes('新节点、新套餐和新实例不再以 IPv6 NAT 作为目标能力。') &&
    hostInstallScript.includes('ipv6_block="ipv6.address: none"') &&
    !hostInstallScript.includes('${GREEN}IPv4 NAT + IPv6 NAT${NC}') &&
    !hostInstallScript.includes('${GREEN}IPv6 NAT${NC}') &&
    !hostInstallScript.includes('网桥 NAT 双通道模式') &&
    !hostInstallScript.includes('Bridge: Auto+NAT'),
  'host install script must document dedicated IPv4/IPv6 targets and stop presenting IPv6 NAT as a new node capability'
)

assert.ok(
  hostRoutes.includes('function getPanelCertificatePaths') &&
    hostRoutes.includes("appDir.endsWith('/current') ? dirname(appDir) : null") &&
    hostRoutes.includes("join(installDir, 'server/certs/client.crt')") &&
    hostRoutes.includes("join(installDir, 'server/certs/client.key')") &&
    hostRoutes.includes('existsSync(stableCertPath)') &&
    hostRoutes.includes('existsSync(stableKeyPath)'),
  'host routes must prefer stable install-level panel client certificate paths over release-local paths'
)

assert.ok(
  hostRoutes.includes('if (process.env.PANEL_CRT_PATH || process.env.PANEL_KEY_PATH)') &&
    hostRoutes.includes('(existsSync(stableCertPath) || existsSync(stableKeyPath))') &&
    !hostRoutes.includes('existsSync(stableCertPath) ? stableCertPath : fallbackCertPath'),
  'host certificate paths must select pairs together and must not hide a partial explicit or stable pair'
)
assert.equal((hostRoutes.match(/readPanelCertificatePair\(certPath, keyPath\)/g) ?? []).length, 2,
  'certificate download and host verification must validate the same readable pair')
assert.ok(
  panelCertificate.includes('statSync(certPath).isFile()') &&
    panelCertificate.includes('statSync(keyPath).isFile()') &&
    panelCertificate.includes('statSync(keyPath).mode & 0o077') &&
    panelCertificate.includes('certificate.checkPrivateKey(privateKey)') &&
    panelCertificate.includes('createSecureContext({ cert, key })') &&
    panelCertificate.includes('cert: Buffer.from(certificate.toString())') &&
    panelCertificate.includes('throw new Error(PANEL_CERTIFICATE_ERROR)'),
  'pair reader must validate regular readable files, private key permissions and TLS compatibility, export only X.509 and redact parser errors'
)
assert.ok(
  hostRoutes.includes("code: 'PANEL_CERTIFICATE_INVALID'") &&
    hostRoutes.includes('send(`# Error: ${PANEL_CERTIFICATE_ERROR}`)') &&
    !hostRoutes.includes("request.log.error(err, 'Failed to read panel certificate files')") &&
    !hostRoutes.includes("request.log.error(err, 'Failed to read certificate file')"),
  'certificate failures must return actionable guidance without logging raw key or crypto errors'
)
assert.ok(
  apiEntrypoint.includes('gosu node node dist/scripts/ensure-panel-certificate.js') &&
    startupCertificate.includes('!pathExists(certPath) && !pathExists(keyPath)') &&
    startupCertificate.includes('mkdtempSync(join(certDir,') &&
    startupCertificate.includes("'req', '-x509', '-newkey', 'rsa:4096', '-nodes', '-days', '3650'") &&
    startupCertificate.includes('linkSync(temporaryKey, keyPath)') &&
    startupCertificate.includes('linkSync(temporaryCert, certPath)') &&
    startupCertificate.includes('finally {\n      rmSync(temporaryDir, { recursive: true, force: true })'),
  'Compose must generate only an entirely absent pair in a private temporary directory and publish without overwriting existing files'
)
assert.ok(
  apiEntrypoint.includes('set -eu') &&
    apiEntrypoint.includes('gosu node node dist/scripts/ensure-panel-certificate.js') &&
    startupCertificate.includes('readPanelCertificatePair(certPath, keyPath)') &&
    startupCertificate.includes('do not delete a partial pair to regenerate') &&
    startupCertificate.includes('process.exit(1)') &&
    apiEntrypoint.indexOf('gosu node node dist/scripts/ensure-panel-certificate.js') < apiEntrypoint.indexOf('pnpm exec prisma migrate deploy'),
  'Compose must reject missing, unreadable and invalid pairs as the API user before migrations and app startup'
)

assert.ok(
  zhCnLocale.includes('目前支持 Ubuntu 22.04+、Debian 12/13；Debian 11 可兼容安装但建议升级。') &&
    zhTwLocale.includes('目前支援 Ubuntu 22.04+、Debian 12/13；Debian 11 可相容安裝但建議升級。') &&
    enLocale.includes('Currently supports Ubuntu 22.04+ and Debian 12/13. Debian 11 is best-effort compatible but should be upgraded.'),
  'host create page copy must explicitly show Debian 12/13 support in all enabled locales'
)

for (const staleCopy of [
  '目前仅支持 Ubuntu 22.04+ 和 Debian 11+ 系统。',
  '目前僅支援 Ubuntu 22.04+ 和 Debian 11+ 系統。',
  'Currently supports Ubuntu 22.04+ and Debian 11+ only.'
]) {
  assert.ok(
    !zhCnLocale.includes(staleCopy) && !zhTwLocale.includes(staleCopy) && !enLocale.includes(staleCopy),
    `host create page must not keep stale Debian support copy: ${staleCopy}`
  )
}

// ==================== ZFS 安装 ====================
//
// 背景：用户反馈「装宿主机节点时 ZFS 安装报错，得自己手动装」。根因是拿不到当前内核的精确
// 头文件时，脚本回退去装 linux-headers-amd64 —— 那是个 meta 包，拉的是 Debian 最新 stock
// 内核的头文件，不是当前运行内核的。DKMS 于是把模块编译进另一个内核的目录，modprobe 必然失败。
// 厂商内核（cloud/vendor kernel）的 VPS 上这条「兜底」等于保证失败。

assert.ok(
  !hostInstallScript.includes('generic_headers="linux-headers-amd64"') &&
    !hostInstallScript.includes('generic_headers="linux-headers-arm64"') &&
    !hostInstallScript.includes('正尝试拉取架构级通用头文件'),
  'ZFS DKMS must never fall back to architecture-generic kernel headers: they belong to a different kernel than the running one, so the built module can never be loaded'
)
assert.ok(
  hostInstallScript.includes('apt-get install -y -qq "linux-headers-${running_kernel}"') &&
    hostInstallScript.includes('return 2'),
  'ZFS DKMS must build against the running kernel headers only, and signal a distinct code when they are unavailable'
)

// 只装 zfsutils-linux（用户态工具）并不会触发 DKMS 编译 —— zfs-dkms 才是编译内核模块的包。
// 此前完全依赖 Recommends 隐式带出它，而预编译路径又特意用 --no-install-recommends 避开它。
assert.ok(
  hostInstallScript.includes('apt-get install -y -qq zfs-dkms zfsutils-linux'),
  'ZFS DKMS must install zfs-dkms explicitly instead of relying on Recommends of zfsutils-linux'
)

// 成功判定必须是实证：模块确实落在当前运行内核目录下且真的能加载。只看 apt 退出码会把
// 「装了工具但没有内核模块」误判为成功。
assert.ok(
  hostInstallScript.includes('find "/lib/modules/${running_kernel}" -name \'zfs.ko*\'') &&
    hostInstallScript.includes('modprobe zfs'),
  'ZFS DKMS success must be proven by the module existing for the running kernel and actually loading'
)

assert.ok(
  hostInstallScript.includes('ZFS 套件、DKMS 编译工具链与当前内核标头已全部保留') &&
    !hostInstallScript.includes('apt-get purge -y -qq $zfs_added_pkgs') &&
    !hostInstallScript.includes('编译环境已清理，磁盘空间已释放'),
  'the host installer must preserve ZFS packages, DKMS build tools, and running-kernel headers for later use'
)

assert.ok(
  hostInstallScript.includes('configure_zfs_arc_memory()') &&
    hostInstallScript.includes('ARC 最大值 (MiB/GiB，如 512M、2G；回车保留现有设置)') &&
    hostInstallScript.includes('options zfs zfs_arc_max=${arc_max_bytes}') &&
    hostInstallScript.includes('options zfs zfs_arc_min=${arc_min_bytes}') &&
    hostInstallScript.indexOf('configure_zfs_arc_memory\n') < hostInstallScript.indexOf('confirm_install\n') &&
    hostInstallScript.indexOf('apply_zfs_arc_config\n') > hostInstallScript.indexOf('if ! install_deps; then'),
  'the host installer must ask for ZFS ARC limits before confirmation and apply them after ZFS installation'
)

// 锁内核必须锁「当前正在运行」的那个 —— 取 dpkg 列表里第一个 linux-image 会在多内核机器上
// 锁错版本，重启后进入没有 ZFS 模块的内核，存储池直接不可用。
assert.ok(
  hostInstallScript.includes('kernel_pkg="linux-image-$(uname -r)"') &&
    !hostInstallScript.includes("awk '/^ii.*linux-image-[0-9]/ {print $2}' | head -n1"),
  'the ZFS kernel hold must pin the running kernel, not the first linux-image found in dpkg'
)

// 预编译模块是 insmod 进内核的 ring-0 代码，上游仓库不在我们控制之下：哈希必须固定在本脚本里
// （fail-closed，清单外的内核一律跳过），绝不能取上游同一个 release 里的校验和 —— 能换 tar 包的
// 人同样能换校验和文件。
assert.ok(
  hostInstallScript.includes('zfs_prebuilt_sha256()') &&
    hostInstallScript.includes('verify_sha256 "$tmp_tar" "$expected_sha"') &&
    hostInstallScript.includes('if ! expected_sha=$(zfs_prebuilt_sha256 "$kernel_ver"); then'),
  'prebuilt ZFS kernel modules must be pinned to SHA-256 hashes baked into this script, and unknown kernels must be skipped (fail-closed)'
)
assert.ok(
  !hostInstallScript.includes('${ZFS_PREBUILT_URL}/xpayincus-zfs-linux-${ARCH}-${kernel_ver}.tar.gz.sha256'),
  'the prebuilt module checksum must never be fetched from the same upstream release as the artifact itself'
)

// 换内核会改客户生产机的引导配置：容器型虚拟化换了没用，非交互环境不得擅自动手。
assert.ok(
  hostInstallScript.includes('systemd-detect-virt --container') &&
    hostInstallScript.includes('if [[ ! -t 0 ]]; then') &&
    hostInstallScript.includes('offer_kernel_switch_for_zfs'),
  'the kernel switch must be skipped on container virtualization and must never run unattended'
)

// ZFS 装不上不是安装失败 —— 面板用 dir 存储池照样能跑，不能因此中断整个宿主机安装。
assert.ok(
  !hostInstallScript.includes('warn "已跳过 ZFS 安装，返回主菜单"'),
  'a failed ZFS setup must degrade to the dir storage pool, not abort the host installation'
)

const bash = process.env.BASH_PATH || (process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
const shellFunction = (name: string) => {
  const match = hostInstallScript.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  assert.ok(match, `missing shell function ${name}`)
  return match[0]
}
const runShell = (script: string, expected = 0) => {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], { input: script, encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, expected, `isolated shell check failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
assert.equal(runShell(`set -euo pipefail
${shellFunction('import_cert')}
step() { :; }
error() { :; }
rm() { :; }
mktemp() { printf '/unused-test-cert'; }
curl() {
  local arg config
  for arg in "$@"; do [[ "$arg" != *private-install-token* ]] || exit 91; done
  config=$(cat)
  [[ "$config" == 'url = "https://panel.example.org/api/hosts/cert/private-install-token"' ]] || exit 92
  printf 'protected-url\\n'
  return 1
}
AGENT_CONFIG_FILE=/dev/null/absent-config
PANEL_URL=https://panel.example.org
TOKEN=private-install-token
import_cert
`, 1), 'protected-url\n', 'certificate TOKEN must travel through curl stdin, never argv, and download failures must stop installation')
const terminalSetup = hostInstallScript.match(/^RED='' GREEN=''[\s\S]*?^readonly RED[^\n]*/m)?.[0]
assert.ok(terminalSetup, 'terminal color setup must remain independently testable')
const messageFunctions = hostInstallScript.match(/^log\(\)[\s\S]*?^step\(\)[^\n]*/m)?.[0]
assert.ok(messageFunctions)
for (const noColor of ['', 'export NO_COLOR=']) {
  const output = runShell(`set -euo pipefail
${noColor}
TERM=xterm
${terminalSetup}
${messageFunctions}
${shellFunction('divider')}
log 'literal \\n 100%'
COLUMNS=020 divider
`)
  assert.equal(output, '  [完成] literal \\n 100%\n  ------------------\n')
  assert.ok(!output.includes('\u001b'), 'redirected and NO_COLOR output must contain no ANSI')
}
assert.ok(hostInstallScript.includes('纯数字/G 为 GiB，GB 为十进位，GiB 为二进位'))
assert.ok(hostInstallScript.includes('容量支持小数'))
const arcHarness = `set -euo pipefail
info() { :; }
warn() { :; }
error() { :; }
${shellFunction('parse_binary_size')}
${shellFunction('configure_zfs_arc_memory')}
awk() { echo 8388608; }
ZFS_ARC_MAX_BYTES=""
ZFS_ARC_MIN_BYTES=""
ZFS_ARC_MAX_GB=""
ZFS_ARC_MIN_GB=""
`
runShell(`${arcHarness}
[[ $(parse_binary_size 512M) == 536870912 ]]
[[ $(parse_binary_size 512MiB) == 536870912 ]]
[[ $(parse_binary_size 2G) == 2147483648 ]]
[[ $(parse_binary_size 2GB) == 2000000000 ]]
[[ $(parse_binary_size 002) == 2147483648 ]]
[[ $(parse_binary_size 1.5gIb) == 1610612736 ]]
[[ $(parse_binary_size 1.5gb) == 1500000000 ]]
[[ $(parse_binary_size 1.5) == 1610612736 ]]
[[ $(parse_binary_size 0.001MB) == 1000 ]]
[[ $(parse_binary_size 0.000000001G) == 1 ]]
[[ $(parse_binary_size 1.234567890123456789GiB) == 1325607178 ]]
[[ $(parse_binary_size 8589934591.999999999GiB) == 9223372036854775806 ]]
for bad in 0 0.0 -1 .5G 1.G 1e3G 1..5G 999999999999G 8589934592GiB 9223372036.854775808GB 999999999999999999999999 0.0000000001G '/dev/sda' '1+1'; do
  if parse_binary_size "$bad"; then exit 1; fi
done
configure_zfs_arc_memory
[[ -z "$ZFS_ARC_MAX_BYTES" ]]
ZFS_ARC_MAX=512MiB ZFS_ARC_MIN=128M configure_zfs_arc_memory
[[ "$ZFS_ARC_MAX_BYTES" == 536870912 && "$ZFS_ARC_MIN_BYTES" == 134217728 ]]
ZFS_ARC_MAX_GB=2 ZFS_ARC_MIN_GB=1 configure_zfs_arc_memory
[[ "$ZFS_ARC_MAX_BYTES" == 2147483648 && "$ZFS_ARC_MIN_BYTES" == 1073741824 ]]
if ZFS_ARC_MAX=8G configure_zfs_arc_memory; then exit 1; fi
if ZFS_ARC_MAX=1G ZFS_ARC_MIN=2G configure_zfs_arc_memory; then exit 1; fi
if ZFS_ARC_MIN=1G configure_zfs_arc_memory; then exit 1; fi
`)
const storageHarness = `set -euo pipefail
info() { :; }
error() { :; }
${shellFunction('parse_binary_size')}
${shellFunction('ensure_incus_storage')}
${process.platform === 'win32' ? 'python3() { command python "$@"; }' : ''}
incus() {
  case "$*" in
    'profile show default --format json') printf 'Error: unknown flag: --format\n' >&2; return 1 ;;
    'query /1.0/profiles/default')
      [[ "$QUERY_STATUS" == 0 ]] || return "$QUERY_STATUS"
      printf '%s' "$PROFILE_JSON" ;;
    'storage list --format csv -c n') printf '%s' "$POOLS" ;;
    'storage show '*) return "$POOL_STATUS" ;;
    'profile device get default root type') return "$ROOT_NAME_STATUS" ;;
    'storage create '*) [[ "\${CREATE_STATUS:-0}" == 0 ]] || return 1; printf '%s\\n' "$*" ;;
    'profile device add '*) printf '%s\\n' "$*" ;;
    *) printf 'unexpected Incus command: %s\\n' "$*" >&2; return 91 ;;
  esac
}
zfs_storage_available() { return 1; }
PROFILE_JSON='{"name":"default","config":{},"devices":{}}'
QUERY_STATUS=0
POOL_STATUS=0
ROOT_NAME_STATUS=1
POOLS=""
`
assert.equal(runShell(`${storageHarness}
PROFILE_JSON='{"name":"default","devices":{"eth0":{"type":"nic","network":"incusbr0"},"data":{"type":"disk","path":"/data","pool":"other"},"disk0":{"type":"disk","path":"/","pool":"custom"}}}'
POOLS=$'default\\ncustom' INCUS_STORAGE_POOL=missing INCUS_STORAGE_DRIVER=/dev/sda ensure_incus_storage
`), '', 'existing profile root must not be modified')
for (const profile of [
  '', '{', 'null', '[]', '{}',
  '{"devices":null}', '{"devices":[]}', '{"devices":{"root":null}}',
  '{"devices":{"root":{"type":"disk","path":"/","pool":null}}}',
  '{"devices":{"root":{"type":"disk","path":"/","pool":42}}}',
  '{"devices":{"root":{"type":"disk","path":"/","pool":"bad\\nname"}}}',
  '{"devices":{"a":{"type":"disk","path":"/","pool":"one"},"b":{"type":"disk","path":"/","pool":"two"}}}'
]) {
  assert.equal(runShell(`${storageHarness}
PROFILE_JSON='${profile}'
if ensure_incus_storage; then exit 92; fi
`), '', 'invalid profile JSON must fail without creating storage or modifying devices')
}
for (const device of [
  '{"type":"disk","path":"/"}',
  '{"type":"disk","path":"/","pool":""}',
  '{"type":"disk","path":"/","pool":"missing"}'
]) {
  assert.equal(runShell(`${storageHarness}
PROFILE_JSON='{"devices":{"disk0":${device}}}'
POOL_STATUS=1
if ensure_incus_storage; then exit 92; fi
`), '', 'existing root with missing or unavailable pool must fail without mutation')
}
assert.equal(runShell(`${storageHarness}
QUERY_STATUS=1
if ensure_incus_storage; then exit 92; fi
`), '', 'Incus API failure must propagate without storage changes')
assert.equal(runShell(`${storageHarness}
PROFILE_JSON='{"devices":{"root":{"type":"disk","path":"/data","pool":"existing"}}}'
POOLS=existing ROOT_NAME_STATUS=0
if ensure_incus_storage; then exit 92; fi
`), '', 'a non-root device named root must never be replaced')
assert.match(runShell(`${storageHarness}
POOLS=$'other\\ndefault' ensure_incus_storage
`), /profile device add default root disk path=\/ pool=default/)
assert.match(runShell(`${storageHarness}
POOLS=$'zeta\\nalpha' ensure_incus_storage
`), /pool=alpha/)
assert.match(runShell(`${storageHarness}
POOLS=$'alpha\\nzeta' INCUS_STORAGE_POOL=zeta ensure_incus_storage
`), /pool=zeta/)
assert.match(runShell(`${storageHarness}
ensure_incus_storage
`), /storage create default dir/)
runShell(`${storageHarness}
if INCUS_STORAGE_POOL=missing POOLS=existing ensure_incus_storage; then exit 1; fi
if INCUS_STORAGE_DRIVER=/dev/sda ensure_incus_storage; then exit 1; fi
if INCUS_STORAGE_DRIVER=zfs ensure_incus_storage; then exit 1; fi
zfs_storage_available() { return 0; }
INCUS_STORAGE_DRIVER=zfs INCUS_STORAGE_SIZE=2GiB ensure_incus_storage
INCUS_STORAGE_DRIVER=zfs INCUS_STORAGE_SIZE=30GiB ensure_incus_storage
`)
const zfsStorageHarness = `${storageHarness}
zfs_storage_available() { return 0; }
df() { echo unexpected-df >&2; return 91; }
`
for (const driver of ['auto', 'zfs']) {
  assert.equal(runShell(`${zfsStorageHarness}
INCUS_STORAGE_DRIVER=${driver} ensure_incus_storage
`), 'storage create default zfs size=10737418240\nprofile device add default root disk path=/ pool=default\n',
  `${driver} must default to 10GiB without querying free space or falling back to dir`)
}
for (const [size, bytes] of [
  ['512MiB', 536870912], ['30GiB', 32212254720], ['1.5GB', 1500000000],
  ['1.5GiB', 1610612736], ['1.5g', 1610612736], ['1.5', 1610612736],
  ['2gb', 2000000000], ['2GB', 2000000000], ['2GIB', 2147483648],
  ['1.5mb', 1500000], ['1.5mIb', 1572864], ['1.5M', 1572864],
  ['1.5tb', 1500000000000], ['1.5TiB', 1649267441664], ['1T', 1099511627776],
  ['1.5kb', 1500], ['1.5KiB', 1536], ['1k', 1024], ['0.001KB', 1]
] as const) {
  assert.equal(runShell(`${zfsStorageHarness}
INCUS_STORAGE_SIZE=${size} ensure_incus_storage
`), `storage create default zfs size=${bytes}\nprofile device add default root disk path=/ pool=default\n`,
  `${size} must normalize to bytes without a minimum or free-space limit`)
}
for (const size of ['bad', '0', '-1', '1e3GB', '0.0000000001G', '8589934592GiB', '999999999999999999999999']) {
  assert.equal(runShell(`${zfsStorageHarness}
if INCUS_STORAGE_SIZE=${size} ensure_incus_storage; then exit 92; fi
`), '', 'invalid explicit sizes must fail without mutation or prompting')
}
assert.equal(runShell(`${zfsStorageHarness}
if CREATE_STATUS=1 ensure_incus_storage; then exit 92; fi
`), '', 'storage creation failures must remain failures')
const interactiveStorageHarness = zfsStorageHarness.replaceAll('[[ -t 0', '[[ 1 == 1') + `
INCUS_STORAGE_POOL=default
INCUS_STORAGE_DRIVER=zfs
READS=0
read() {
  [[ "$3" == 'ZFS loop 大小 [10GiB]: ' ]] || return 91
  READS=$((READS + 1))
  case "$READS" in
    1) size=bad ;;
    2) size=0 ;;
    3) size=8589934592GiB ;;
    4) size="$FINAL_SIZE" ;;
    *) return 92 ;;
  esac
}
`
for (const [input, bytes] of [['', 10737418240], ['512MiB', 536870912], ['1.5GB', 1500000000], ['30GiB', 32212254720]] as const) {
  assert.equal(runShell(`${interactiveStorageHarness}
FINAL_SIZE='${input}'
ensure_incus_storage
[[ "$READS" == 4 ]]
`), `storage create default zfs size=${bytes}\nprofile device add default root disk path=/ pool=default\n`,
  'interactive invalid syntax, zero and overflow must retry before accepting a positive size or the 10GiB default')
}
assert.equal(runShell(`${interactiveStorageHarness}
read() { return 1; }
if ensure_incus_storage; then exit 92; fi
`), '', 'interactive EOF must fail without mutation or infinite retries')
runShell(`set -euo pipefail
${shellFunction('do_uninstall')}
info() { :; }
warn() { :; }
log() { :; }
error() { :; }
systemctl() { [[ "$1" == cat || "$1" == disable ]]; }
confirm_uninstall() { exit 92; }
incus() { exit 93; }
apt-get() { exit 94; }
rm() { exit 95; }
AGENT_SERVICE_NAME=incudal-agent
UNINSTALL_DELETE_DATA=false
do_uninstall
`)
const storageFunction = shellFunction('ensure_incus_storage')
assert.ok(!/storage (delete|set)|volume delete|source=/.test(storageFunction), 'storage initialization must never delete or reconfigure pools or accept disks')
assert.ok(shellFunction('zfs_storage_available').includes('[[ -c /dev/zfs ]]'), 'ZFS detection must verify the kernel device')
assert.ok(shellFunction('apply_zfs_arc_config').includes('[[ -n "$ZFS_ARC_MAX_BYTES" ]] || return 0'), 'reruns without explicit ARC input must preserve config')
assert.ok(!shellFunction('apply_zfs_arc_config').includes('|| true'), 'ARC application must not silently ignore failures')
const arcApply = shellFunction('apply_zfs_arc_config')
assert.ok(arcApply.includes('if ! cat > "$modprobe_file"') && arcApply.includes('chmod 0644 "$modprobe_file" || return 1'), 'ARC persistence failures must propagate even when called in a conditional')
assert.match(arcApply, /initramfs 更新失败[^\n]*\n\s*return 1/, 'initramfs failure must not report successful persistence')
const bootServices = shellFunction('preserve_zfs_boot_services')
assert.ok(bootServices.includes('! -L /etc/modules-load.d/incudal-zfs.conf') && bootServices.includes("grep -Eq '^[[:space:]]*zfs[[:space:]]*$'"), 'existing module-load config must be a regular non-symlink file that loads ZFS')
assert.ok(bootServices.includes('zfs-import-cache.service zfs-mount.service zfs.target') && bootServices.includes('systemctl enable "$service" >/dev/null 2>&1 || return 1'), 'ZFS boot units must be enabled with failures propagated')
assert.match(hostInstallScript, /if ! refresh_panel_trust; then\n\s*warn [^\n]*\n\s*elif ! update_incudal_agent_from_config true; then/, 'automatic root script updates must require successful authenticated trust refresh')
assert.ok(hostInstallScript.indexOf('\n    confirm_install\n') < hostInstallScript.indexOf('\n        if ! refresh_panel_trust; then'), 'automatic trust and Agent updates must follow confirmation')
assert.ok(hostInstallScript.includes('bash -s -- --host-ready --yes; then'), 'host initialization must install Agent without recursively initializing the host')
const hostCommandBuilder = hostRoutes.slice(hostRoutes.indexOf('function buildHostInstallCommand('), hostRoutes.indexOf('export default async function hostRoutes'))
assert.ok(hostCommandBuilder.includes('/api/agent/install.sh') && !hostCommandBuilder.includes('installToken'), 'host commands must use the generic TOKEN-free installer')
assert.equal((hostRoutes.match(/installScriptUrl: `\$\{panelUrl\}\/api\/agent\/install.sh`/g) ?? []).length, 2, 'host creation and regeneration must include installScriptUrl')
const prepareHost = hostInstallScript.slice(hostInstallScript.indexOf('    if [[ "$ACTION" == prepare_agent_host ]]'), hostInstallScript.indexOf('    # 如果通过命令行指定了卸载'))
assert.ok(prepareHost.indexOf('confirm_install') < prepareHost.indexOf('install_deps'), 'standalone host preparation must confirm before installing packages')
assert.ok(prepareHost.includes('setup_kernel || return 1') && prepareHost.indexOf('confirm_install') < prepareHost.indexOf('setup_kernel') && prepareHost.indexOf('setup_kernel') < prepareHost.indexOf('init_incus'), 'standalone host preparation must apply forwarding and RA settings after confirmation and stop on failure before Incus initialization')
assert.ok(prepareHost.includes('init_incus || return 1') && !prepareHost.includes('install_incudal_agent'), 'host preparation must initialize networking and storage without recursively installing Agent')
assert.ok(hostRoutes.includes("'/install.sh/:token', { logLevel: 'silent' }"), 'UUID script downloads must suppress request URL logging')
assert.ok(hostRoutes.includes("'/cert/:token', { logLevel: 'silent' }"), 'certificate downloads must suppress TOKEN-bearing request URL logging')
assert.match(shellFunction('install_incudal_agent'), /AGENT_INSTALL_STATUS="安装失败"[\s\S]*return 1/, 'host setup must propagate Agent installation failures')
const arcFailureHarness = `set -euo pipefail
${arcApply.replace('"/etc/modprobe.d/99-zfs-arc.conf"', '"/dev/null"').replace('[[ -d /sys/module/zfs ]]', '[[ -d /dev/null ]]')}
info() { :; }
warn() { :; }
log() { echo unexpected-success; }
ZFS_ARC_MAX_BYTES=536870912
ZFS_ARC_MIN_BYTES=134217728
`
for (const failure of ['cat', 'chmod', 'update-initramfs']) {
  assert.equal(runShell(`${arcFailureHarness}
cat() { return ${failure === 'cat' ? 1 : 0}; }
chmod() { return ${failure === 'chmod' ? 1 : 0}; }
update-initramfs() { return ${failure === 'update-initramfs' ? 1 : 0}; }
uname() { printf guard-kernel; }
if apply_zfs_arc_config; then exit 92; fi
`), '', `ARC ${failure} failure must propagate without reporting success`)
}
assert.ok(hostInstallScript.includes('--uninstall|--uninstall-keep-data)') && hostInstallScript.includes('--delete-data)'), 'destructive uninstall must require an extra explicit option')
assert.equal((hostInstallScript.slice(hostInstallScript.indexOf('init_incus() {'), hostInstallScript.indexOf('import_cert() {')).match(/ensure_incus_storage/g) ?? []).length, 2, 'storage must initialize on fresh installs and reruns with an existing bridge')

const initFunction = hostInstallScript.slice(hostInstallScript.indexOf('init_incus() {'), hostInstallScript.indexOf('import_cert() {'))
const initHarness = `set -euo pipefail
${initFunction}
step() { :; }
info() { :; }
log() { echo unexpected-success; }
incus() {
  case "$*" in
    'network show '*) return "$BRIDGE_STATUS" ;;
    'admin init --preseed') return "$PRESEED_STATUS" ;;
    *) return 91 ;;
  esac
}
ensure_incus_storage() { STORAGE_CALLS=$((STORAGE_CALLS + 1)); return 1; }
BRIDGE_NAME=incusbr0
BRIDGE_SUBNET=10.0.0.1/24
MODE=nat
IS_PURE_IPV6=false
LISTEN_PORT=8443
PRESEED_FILE=/dev/null
STORAGE_CALLS=0
`
for (const [bridgeStatus, preseedStatus, storageCalls] of [[0, 0, 1], [1, 1, 0], [1, 0, 1]]) {
  assert.equal(runShell(`${initHarness}
BRIDGE_STATUS=${bridgeStatus}
PRESEED_STATUS=${preseedStatus}
if init_incus; then exit 92; fi
[[ "$STORAGE_CALLS" == ${storageCalls} ]]
`), '', '初始化失敗必須在條件呼叫中傳回失敗，且不得記錄成功或在 preseed 失敗後檢查儲存池')
}
const mainInstallCalls = hostInstallScript.match(/^    install_incus[^\n]*\n    init_incus[^\n]*\n    import_cert[^\n]*/m)
assert.ok(mainInstallCalls, '主流程必須直接呼叫初始化，再匯入證書')
assert.ok(/^set -euo pipefail$/m.test(hostInstallScript) && /\nmain "\$@"\s*$/.test(hostInstallScript), '主流程必須啟用錯誤即中止並直接執行')
assert.equal(runShell(`${initHarness}
BRIDGE_STATUS=0
PRESEED_STATUS=0
install_incus() { :; }
import_cert() { echo unexpected-import; }
main() {
${mainInstallCalls[0]}
  echo unexpected-continuation
}
main
`, 1), '', '初始化失敗必須中止主流程，不得繼續匯入證書')

console.log('host install script guard tests passed')
