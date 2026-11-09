#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'bash download.sh [menu [DIRECTORY]]  (Dashboard 數字選單)' \
    'bash download.sh install DIRECTORY [latest]  (官方最新正式版最小 Compose bundle)' \
    'bash download.sh install-bundle DIRECTORY VERSION SHA256' \
    'bash download.sh install DIRECTORY VERSION SHA256' \
    'bash download.sh update DIRECTORY VERSION SHA256' \
    '來源固定為 XiaoLong-Taiwan/XPayincus 的固定版本 Release Dashboard Compose 資產。' \
    '只準備部署檔案，不呼叫 Docker、不初始化或覆寫私人資料。'
}
if [[ "${1:-}" == --fetch || "${1:-}" == --resolve ]]; then
  if [[ "$1" == --fetch ]]; then (($# == 5)) || die '下載介面參數錯誤。'; else (($# == 2)) || die '版本解析參數錯誤。'; fi
  exec python3 - "$@" <<'DOWNLOAD_PY'
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urljoin, urlsplit, urlunsplit

REPOSITORY = 'XiaoLong-Taiwan/XPayincus'
API = f'https://api.github.com/repos/{REPOSITORY}/releases'
RELEASES = f'https://github.com/{REPOSITORY}/releases/download/'

class DownloadError(Exception):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status

def safe_url(url):
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.hostname or '', parts.path, '', ''))

def token_value():
    filename = os.environ.get('XPAYINCUS_GITHUB_TOKEN_FILE', '')
    if not filename:
        return ''
    try:
        with open(filename, 'r', opener=lambda path, flags: os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))) as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or (os.name != 'nt' and (info.st_mode & 0o077 or info.st_uid != os.geteuid())):
                raise ValueError()
            token = source.read(4097).strip()
        if not re.fullmatch(r'[A-Za-z0-9_\-.]{1,4096}', token):
            raise ValueError()
        return token
    except (OSError, ValueError):
        raise DownloadError('token 檔案須為目前帳號持有、權限 600 的非空一般檔案；不可為符號連結或包含換行。')

def request(url, target, limit, phase, accept='application/vnd.github+json'):
    token = token_value()
    original = safe_url(url)
    for redirect in range(6):
        parts = urlsplit(url)
        host = parts.hostname or ''
        if parts.scheme != 'https' or parts.username or parts.password or parts.port not in (None, 443) or host not in {
                'github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}:
            raise DownloadError(f'{phase}：拒絕非受信任 HTTPS 下載來源；URL={safe_url(url)}')
        with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
            headers = Path(temporary) / 'headers'
            body = Path(temporary) / 'body'
            config = ''
            if host == 'api.github.com' and token:
                config = f'header = "Authorization: Bearer {token}"\n'
            args = ['curl', '--disable', '--silent', '--show-error', '--proto', '=https',
                    '--connect-timeout', '20', '--max-time', '300', '--retry', '2',
                    '--max-filesize', str(limit), '--user-agent', 'XPayincus-Compose-Updater',
                    '--header', f'Accept: {accept}', '--dump-header', str(headers),
                    '--output', str(body), '--write-out', '%{http_code}', '--config', '-', url]
            result = subprocess.run(args, input=config, capture_output=True, text=True)
            status = int(result.stdout.strip()) if re.fullmatch(r'[0-9]{3}', result.stdout.strip()) else 0
            values = {}
            if headers.exists():
                for line in headers.read_text(errors='replace').splitlines():
                    if line.startswith('HTTP/'):
                        values = {}
                    elif ':' in line:
                        key, value = line.split(':', 1)
                        values[key.lower()] = value.strip()
            if result.returncode:
                raise DownloadError(f'{phase}：URL={original}；HTTP {status or "未知"}；curl exit={result.returncode}。請檢查 DNS、TLS、代理、磁碟與下載大小限制後重試。', status)
            if status in (301, 302, 303, 307, 308) and 'location' in values:
                url = urljoin(url, values['location'])
                continue
            if 200 <= status < 300 and body.is_file() and 0 < body.stat().st_size <= limit:
                os.replace(body, target)
                return
            hint = '請檢查 GitHub 服務狀態、代理與網路後重試。'
            if status == 429 or (status == 403 and (values.get('x-ratelimit-remaining') == '0' or 'retry-after' in values)):
                hint = 'GitHub API 限流；請稍後重試，或以 XPAYINCUS_GITHUB_TOKEN_FILE 提供有權限的 token。'
                for key in ('retry-after', 'x-ratelimit-reset'):
                    if re.fullmatch(r'[0-9]{1,20}', values.get(key, '')):
                        hint += f' {key}={values[key]}。'
            elif status == 401:
                hint = 'GitHub 認證失敗；請更新或移除無效 token。'
            elif status == 403:
                hint = 'GitHub 拒絕存取；請確認 token repository 權限／組織 SSO、出口 IP 或代理政策；此狀態本身不能證明是限流。'
            elif status == 404:
                hint = 'Release／資產不存在或無權限；請確認正式版本、完整資產名稱及 repository 讀取權限。'
            raise DownloadError(f'{phase}：URL={original}；HTTP {status}。{hint}', status)
    raise DownloadError(f'{phase}：URL={original}；重新導向次數超出限制。')

def download(url, target, limit, phase):
    asset = re.fullmatch(re.escape(RELEASES) + r'(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))/(SHA256SUMS|xpayincus-dashboard-v[0-9]+\.[0-9]+\.[0-9]+-compose\.tar\.gz|xpayincus-compose-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz)', url)
    if url != API + '/latest' and not asset:
        raise DownloadError(f'{phase}：拒絕非官方固定版本來源；URL={safe_url(url)}')
    if asset and asset[2] not in ('SHA256SUMS', f'xpayincus-dashboard-{asset[1]}-compose.tar.gz', f'xpayincus-compose-{asset[1]}.tar.gz'):
        raise DownloadError(f'{phase}：資產版本不符。')
    try:
        request(url, target, limit, phase)
        return
    except DownloadError as error:
        if not asset or error.status not in (403, 404):
            raise
        first_error = str(error)
    version, name = asset.groups()
    if name not in ('SHA256SUMS', f'xpayincus-dashboard-{version}-compose.tar.gz', f'xpayincus-compose-{version}.tar.gz'):
        raise DownloadError(f'{phase}：資產版本不符。')
    print(first_error + ' 改試同一官方 Release API 資產端點。', file=sys.stderr)
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        metadata = Path(temporary) / 'release.json'
        request(API + '/tags/' + version, metadata, 2097152, phase + '／固定版本 API')
        release = json.loads(metadata.read_text())
        if release.get('tag_name') != version or release.get('draft') is not False or release.get('prerelease') is not False:
            raise DownloadError(f'{phase}：替代來源不是要求的正式版本。')
        matches = [item for item in release.get('assets', []) if item.get('name') == name]
        if len(matches) != 1 or type(matches[0].get('id')) is not int or matches[0]['id'] <= 0:
            raise DownloadError(f'{phase}：官方 Release 缺少唯一對應資產。')
        request(API + '/assets/' + str(matches[0]['id']), target, limit, phase + '／API 資產', 'application/octet-stream')

def resolve(version):
    pattern = r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
    if version != 'latest' and not re.fullmatch(pattern, version):
        raise DownloadError('需要 latest 或固定正式 vX.Y.Z。')
    with tempfile.TemporaryDirectory() as temporary:
        metadata = Path(temporary) / 'release.json'
        request(API + ('/latest' if version == 'latest' else '/tags/' + version), metadata, 2097152, '解析正式 Release')
        release = json.loads(metadata.read_text())
        tag = release.get('tag_name', '')
        if not isinstance(tag, str) or not re.fullmatch(pattern, tag) or release.get('draft') is not False or release.get('prerelease') is not False or (version != 'latest' and tag != version):
            raise DownloadError('GitHub Release 不是要求的正式 vX.Y.Z。')
        artifact = f'xpayincus-compose-{tag}.tar.gz'
        assets = [item for item in release.get('assets', []) if item.get('name') == artifact]
        if len(assets) != 1:
            raise DownloadError('正式 Release 缺少唯一的最小 Compose bundle；請等待官方發布，不退回完整來源包。')
        sums = Path(temporary) / 'SHA256SUMS'
        download(RELEASES + tag + '/SHA256SUMS', sums, 2097152, '最小 Compose bundle checksum')
        matches = [entry for line in sums.read_text().splitlines() if len(entry := line.split()) == 2 and entry[1] == artifact]
        if len(matches) != 1 or not re.fullmatch(r'[0-9a-f]{64}', matches[0][0]):
            raise DownloadError('官方 SHA256SUMS 缺少唯一有效的最小 Compose bundle checksum。')
        return tag + ' ' + matches[0][0]

if __name__ == '__main__':
    try:
        if sys.argv[1] == '--resolve':
            print(resolve(sys.argv[2]))
        else:
            download(sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
    except (DownloadError, OSError, ValueError, KeyError) as error:
        message = str(error) if isinstance(error, DownloadError) else 'Release 下載／解析失敗；請檢查代理回應格式、目錄權限及前述階段。'
        sys.exit(message)
DOWNLOAD_PY
fi
self="${BASH_SOURCE[0]}"
dashboard_menu() {
  local directory="${1:-/srv/incudal-panel}" choice value
  { exec 8<>/dev/tty; } 2>/dev/null || die '數字選單需要可用的 /dev/tty；無終端請使用 install DIRECTORY latest 或既有非互動 CLI。'
  while true; do
    printf '\nDashboard / Compose\n目錄：%s\n1) 安裝最新最小 Compose bundle\n2) 初始化網址與入口\n3) 更新既有部署至最新正式版\n4) 拉取映像並啟動\n5) 狀態\n6) 日誌\n7) 匯出資料庫\n8) 切換部署目錄\n0) 離開\n選擇：' "$directory" >&8
    IFS= read -r choice <&8 || return 0
    case "$choice" in
      0) return 0 ;;
      1|8)
        printf '部署絕對路徑 [%s]：' "$directory" >&8
        IFS= read -r value <&8 || return 0
        if [[ -n "$value" ]]; then directory="$value"; fi
        [[ "$directory" == /* ]] || { printf '請輸入絕對路徑。\n' >&8; continue; }
        if [[ "$choice" == 1 ]]; then
          if bash "$self" install "$directory" latest; then
            bash "$directory/panel.sh" wizard || printf '設定或啟動失敗，請依前述錯誤處理；不宣告安裝完成。\n' >&8
          else
            printf '下載安裝失敗，未執行設定或啟動。\n' >&8
          fi
        fi
        ;;
      2|3|4|5|6|7)
        [[ "$directory" == /* && -f "$directory/panel.sh" ]] || { printf '找不到部署入口；請先安裝或切換目錄。\n' >&8; continue; }
        case "$choice" in
          2)
            bash "$directory/panel.sh" wizard || printf '設定或啟動失敗。\n' >&8
            ;;
          3) bash "$directory/panel.sh" update || printf '更新失敗，請保留備份並依前述階段處理。\n' >&8 ;;
          4) bash "$directory/panel.sh" up pull || printf '啟動失敗，請查看狀態與日誌。\n' >&8 ;;
          5) bash "$directory/panel.sh" status || printf '狀態查詢失敗。\n' >&8 ;;
          6) bash "$directory/panel.sh" logs || printf '日誌查詢結束或失敗。\n' >&8 ;;
          7) bash "$directory/panel.sh" export || printf '備份失敗。\n' >&8 ;;
        esac
        ;;
      *) printf '請輸入列出的數字。\n' >&8 ;;
    esac
  done
}
case "${1:-menu}" in
  menu)
    (($# <= 2)) || die 'menu 最多接受一個部署目錄。'
    [[ -f "$self" ]] || die '請先以 curl/wget 下載到暫存檔，再使用 bash 執行選單。'
    dashboard_menu "${2:-/srv/incudal-panel}"
    exit 0
    ;;
  help|-h|--help) usage; exit 0 ;;
  install-bundle) action=install ;;
  update-bundle) action=update ;;
  install|download) action=install ;;
  update) action=update ;;
  *) usage; exit 2 ;;
esac
bundle=false
if [[ "$1" == *-bundle ]]; then bundle=true; fi
if [[ "$action" == install && ( $# == 2 || ( $# == 3 && "$3" == latest ) ) ]]; then
  printf '%s\n' '從官方同 repository Release 取得 checksum；這不是獨立簽章。需要獨立可信 SHA256 時使用 install-bundle DIRECTORY VERSION SHA256。' >&2
  resolved="$(bash "$self" --resolve latest)" || exit 1
  read -r version checksum <<<"$resolved"
  set -- install-bundle "$2" "$version" "$checksum"
  bundle=true
fi
(($# == 4)) || { usage; exit 2; }
destination="$2"
version="$3"
checksum="$4"
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die '需要固定的 vX.Y.Z 版本。'
[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || die '需要可信的小寫 SHA256；不自動信任遠端 checksum。'
for tool in curl python3 sha256sum flock mktemp find; do
  command -v "$tool" >/dev/null || die "缺少必要工具：$tool"
done
[[ ! -L "$destination" ]] || die '目的地不可為符號連結。'
if [[ "$action" == install ]]; then
  mkdir -p -- "$destination"
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die 'install 需要空目錄；既有部署請使用 update。'
else
  [[ -d "$destination" ]] || die '更新目的地不存在。'
fi
destination="$(cd -- "$destination" && pwd -P)"
[[ ! -L "$destination/.state" ]] || die '.state 不可為符號連結。'
mkdir -p -- "$destination/.state"
[[ ! -L "$destination/.state/operation.lock" ]] || die '操作鎖不可為符號連結。'
exec 9>"$destination/.state/operation.lock"
flock -n 9 || die '另一個部署操作正在進行。'
[[ ! -L "$destination/.bootstrap" ]] || die '.bootstrap 不可為符號連結。'
mkdir -p -- "$destination/.bootstrap"
scratch="$(mktemp -d "$destination/.bootstrap/.staging.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
artifact="xpayincus-dashboard-$version-compose.tar.gz"
if [[ "$bundle" == true ]]; then artifact="xpayincus-compose-$version.tar.gz"; fi
bash "$self" --fetch \
  "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/$version/$artifact" \
  "$scratch/source.tar.gz" 104857600 'Dashboard archive 下載'
printf '%s  %s\n' "$checksum" "$scratch/source.tar.gz" | sha256sum --check --status || die '下載校驗失敗；部署未更新。'
python3 - "$scratch" "$destination" "$action" "$version" "$checksum" "$artifact" <<'PY'
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

scratch, destination = map(Path, sys.argv[1:3])
action, version, checksum = sys.argv[3:6]
artifact = sys.argv[6] if len(sys.argv) > 6 else f'xpayincus-dashboard-{version}-compose.tar.gz'
files = (
    'docker-compose.yml', 'compose.yaml', 'compose.build.yaml', 'panel.sh',
    'download.sh', 'README.md', 'https-proxy.conf.example', 'origin-entrypoint.sh',
    'edge-nginx.conf.template', 'tunnel-nginx.conf.template',
    'Dockerfile', 'Dockerfile.dockerignore', 'api-entrypoint.sh',
    'nginx.conf.template', 'web-entrypoint.sh',
)
managed = (*files, 'compose.release.yaml')
wanted = {'XPayincus/deploy/compose/' + name: name for name in managed}
wanted['XPayincus/deploy/compose/update.py'] = 'update.py'
wanted['VERSION'] = 'VERSION'
release = scratch / 'release'
release.mkdir()
seen = set()
total = 0
with tarfile.open(scratch / 'source.tar.gz', 'r:gz') as archive:
    for member in archive:
        raw_name = member.name
        name = raw_name[2:] if raw_name.startswith('./') else raw_name
        parts = PurePosixPath(name).parts
        if name.startswith('/') or '..' in parts or '\\' in name or name in seen:
            raise SystemExit('拒絕不安全或重複的 archive 路徑')
        seen.add(name)
        if len(seen) > 100000 or not (member.isdir() or member.isfile()):
            raise SystemExit('拒絕連結、特殊檔案或過多 archive 成員')
        total += member.size
        if total > 536870912:
            raise SystemExit('archive 解壓大小超出限制')
        if name not in wanted:
            if artifact == f'xpayincus-compose-{version}.tar.gz' and member.isfile():
                raise SystemExit('最小 Compose bundle 含非部署檔案，拒絕完整來源包')
            continue
        if not member.isfile() or not 0 < member.size <= 2097152:
            raise SystemExit('必要部署檔案必須為非空一般檔案且不超過 2 MiB')
        with archive.extractfile(member) as source:
            (release / wanted[name]).write_bytes(source.read())
if any(not (release / name).is_file() for name in (*managed, 'VERSION')):
    raise SystemExit('下載缺少完整的部署檔案')
if artifact == f'xpayincus-compose-{version}.tar.gz' and not (release / 'update.py').is_file():
    raise SystemExit('最小 Compose bundle 缺少 update.py')
if (release / 'VERSION').read_text().strip() != version:
    raise SystemExit('Release 的 VERSION 與要求版本不符')
for name in files:
    if name.endswith('.sh'):
        import subprocess
        subprocess.run(['bash', '-n', str(release / name)], check=True)
images = {
    'api': f'ghcr.io/xiaolong-taiwan/xpayincus-api:{version}',
    'user': f'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:{version}',
    'admin': f'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:{version}',
}
expected_override = {
    'services': {name: {'image': image} for name, image in images.items()}
}
if json.loads((release / 'compose.release.yaml').read_text()) != expected_override:
    raise SystemExit('Release 映像設定與要求版本不符')
if (release / 'update.py').exists():
    compile((release / 'update.py').read_text(), 'update.py', 'exec')
    managed = (*managed, 'update.py')
(release / 'receipt.json').write_text(json.dumps({
    'repository': 'XiaoLong-Taiwan/XPayincus', 'version': version,
    'artifact': artifact, 'sha256': checksum
}, indent=2) + '\n')
store = destination / '.bootstrap'
current = store / 'current'
if action == 'update':
    if not current.is_symlink() or not re.fullmatch(r'release-[0-9a-f]{64}-[A-Za-z0-9_]+', os.readlink(current)):
        raise SystemExit('只支援 bootstrap 管理的部署；不覆寫既有手動部署')
    previous = store / os.readlink(current)
    if previous.is_symlink() or not previous.is_dir():
        raise SystemExit('目前 release 無效')
    previous_version = json.loads((previous / 'receipt.json').read_text()).get('version', '')
    pattern = r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
    if not re.fullmatch(pattern, previous_version) or tuple(map(int, version[1:].split('.'))) < tuple(map(int, previous_version[1:].split('.'))):
        raise SystemExit('目前 receipt 版本無效或要求降版，拒絕更新')
    for name in managed:
        target = destination / name
        if name == 'update.py' and not os.path.lexists(target) and not (previous / name).exists():
            continue
        if not target.is_symlink() or os.readlink(target) != f'.bootstrap/current/{name}':
            raise SystemExit(f'部署入口曾被修改，拒絕覆寫：{name}')
else:
    if os.path.lexists(current) or any(os.path.lexists(destination / name) for name in managed):
        raise SystemExit('目的地已有部署檔案，拒絕覆寫')
release_name = f'release-{checksum}-{scratch.name.rsplit(".", 1)[-1]}'
os.rename(release, store / release_name)
created = []
pointer = scratch / 'next'
try:
    for name in managed:
        if action == 'install' or (name == 'update.py' and not os.path.lexists(destination / name)):
            os.symlink(f'.bootstrap/current/{name}', destination / name)
            created.append(destination / name)
    os.symlink(release_name, pointer)
    os.replace(pointer, current)
except BaseException:
    for entry in created:
        entry.unlink()
    raise
PY
printf '已準備 %s：%s\n' "$version" "$destination"
printf '%s\n' '既有服務未停止；首次請執行 bash panel.sh setup，設定完成後執行 bash panel.sh up。標準手動部署請先確認官方檔案與容器掛載一致，再由 bash panel.sh update 安全納管；任何自訂衝突均拒絕覆蓋。'
