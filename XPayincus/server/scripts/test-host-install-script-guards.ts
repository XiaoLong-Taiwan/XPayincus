import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const hostInstallScript = readFileSync(resolve(__dirname, '../templates/install.sh'), 'utf8')
const caddyInstallScript = readFileSync(resolve(__dirname, '../templates/caddy.sh'), 'utf8')
const hostRoutes = readFileSync(resolve(__dirname, '../src/routes/hosts.ts'), 'utf8')
const zhCnLocale = readFileSync(resolve(__dirname, '../../client/src/locales/zh-CN.ts'), 'utf8')
const zhTwLocale = readFileSync(resolve(__dirname, '../../client/src/locales/zh-TW.ts'), 'utf8')
const enLocale = readFileSync(resolve(__dirname, '../../client/src/locales/en.ts'), 'utf8')
const installPanel = readFileSync(resolve(__dirname, '../../scripts/install-panel.sh'), 'utf8')
const systemctlWrapper = readFileSync(resolve(__dirname, '../../deploy/incudal-systemctl-wrapper.sh.example'), 'utf8')
const apiEntrypoint = readFileSync(resolve(__dirname, '../../deploy/compose/api-entrypoint.sh'), 'utf8')
const panelCertificate = readFileSync(resolve(__dirname, '../src/lib/incus/panel-certificate.ts'), 'utf8')

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
    hostInstallScript.includes('curl -sSf "$cert_url" -o "$cert_file"') &&
    hostInstallScript.includes('面板证书已存在，更新为当前证书') &&
    hostInstallScript.includes('incus config trust remove panel') &&
    hostInstallScript.includes('incus config trust add-certificate "$cert_file" --name panel') &&
    !hostInstallScript.includes('面板证书已存在，跳过导入'),
  'host install script must refresh the panel trust certificate instead of skipping stale panel entries'
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
  apiEntrypoint.includes('[ ! -e "$cert_file" ] && [ ! -L "$cert_file" ] && [ ! -e "$key_file" ] && [ ! -L "$key_file" ]') &&
    apiEntrypoint.includes('gosu node openssl req -x509 -newkey rsa:4096 -nodes -days 3650') &&
    apiEntrypoint.includes('ln "$cert_tmp/client.key" "$key_file"') &&
    apiEntrypoint.includes('ln "$cert_tmp/client.crt" "$cert_file"') &&
    !apiEntrypoint.includes('ln -f') &&
    apiEntrypoint.includes('trap \'rm -rf "$cert_tmp"\' EXIT'),
  'Compose must generate only an entirely absent pair in a private temporary directory and publish without overwriting existing files'
)
assert.ok(
  apiEntrypoint.includes('if ! gosu node node --input-type=module') &&
    apiEntrypoint.includes('checkPrivateKey(createPrivateKey({ key, passphrase: \'\' }))') &&
    apiEntrypoint.includes('createSecureContext({ cert, key })') &&
    apiEntrypoint.includes('Never delete a partial pair to regenerate') &&
    apiEntrypoint.indexOf('if ! gosu node node') < apiEntrypoint.indexOf('pnpm exec prisma migrate deploy'),
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
  const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], { input: script, encoding: 'utf8' })
  assert.equal(result.status, expected, `isolated shell check failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
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
[[ $(parse_binary_size 2GB) == 2147483648 ]]
[[ $(parse_binary_size 002) == 2147483648 ]]
for bad in 0 -1 1.5G 999999999999G 999999999999999999999999 1T '/dev/sda' '1+1'; do
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
# Incus 與所有宿主機變更均使用模擬實作，不會呼叫真實服務。
python3() {
  if [[ "$2" == *'n for n,v'* ]]; then echo "$ROOT_DEVICE"; else echo "$ROOT_POOL"; fi
}
incus() {
  case "$*" in
    'profile show default --format json') echo '{}' ;;
    'storage list --format csv -c n') printf '%s' "$POOLS" ;;
    'storage show '*) return 0 ;;
    'profile device get default root type') return 1 ;;
    'profile device add '*|'storage create '*) printf '%s\\n' "$*" ;;
    *) return 91 ;;
  esac
}
zfs_storage_available() { return 1; }
ROOT_DEVICE=""
ROOT_POOL=""
POOLS=""
`
assert.equal(runShell(`${storageHarness}
ROOT_DEVICE=disk0 ROOT_POOL=custom POOLS=custom ensure_incus_storage
`), '', 'existing profile root must not be modified')
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
df() { printf 'Avail\\n42949672960\\n'; }
INCUS_STORAGE_DRIVER=zfs INCUS_STORAGE_SIZE=2GiB ensure_incus_storage
if INCUS_STORAGE_DRIVER=zfs INCUS_STORAGE_SIZE=30GiB ensure_incus_storage; then exit 1; fi
`)
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
