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
docker_check() {
  if ! command -v docker >/dev/null; then
    printf '%s\n' '找不到 Docker。請依 https://docs.docker.com/engine/install/ 的 Debian／Ubuntu 官方 apt repository 步驟設定金鑰及來源，再執行：sudo apt-get update && sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' >&2
    return 1
  fi
  local version major minor
  version="$(docker compose version --short 2>/dev/null)" || { printf '%s\n' '缺少 Compose plugin；請依 Docker 官方 apt repository 安裝 docker-compose-plugin。' >&2; return 1; }
  if [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)(\+.*)?$ ]]; then
    major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
    if ((10#$major < 2 || (10#$major == 2 && 10#$minor < 20))); then
      printf '%s\n' 'Compose 至少需要 2.20.0；請更新官方 docker-compose-plugin。' >&2
      return 1
    fi
  else
    printf '%s\n' '無法辨識 Compose 版本；需要 2.20.0 以上正式版本。' >&2
    return 1
  fi
  docker info >/dev/null 2>&1 || { printf '%s\n' '無法連線 Docker daemon；請檢查服務、Docker context 與目前帳號權限（sudo systemctl status docker）。不會自動變更權限或重裝 Docker。' >&2; return 1; }
}
deployment_check() {
  python3 - "$1" "${2:-configured}" <<'DEPLOYMENT_PY'
import os
from pathlib import Path
import stat
import sys

try:
    root = Path(sys.argv[1])
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError()
    names = ['panel.sh', 'compose.yaml']
    if (root / 'docker-compose.yml').exists() or (root / 'docker-compose.yml').is_symlink():
        names.append('docker-compose.yml')
    if sys.argv[2] == 'configured':
        names.append('.env')
    paths = {root, *(root / name for name in names)}
    for path in list(paths):
        resolved = path.resolve(strict=True)
        for parent in resolved.parents:
            if parent == root.resolve():
                break
            if root.resolve() in parent.parents:
                paths.add(parent)
    for path in paths:
        resolved = path.resolve(strict=True)
        if path in [root / name for name in names] and (not resolved.is_file() or resolved.stat().st_size == 0 or root.resolve() not in resolved.parents):
            raise ValueError()
        info = resolved.stat()
        if os.name != 'nt' and (info.st_uid not in (0, os.geteuid()) or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
            raise ValueError()
    script = (root / 'panel.sh').read_text()
    compose = (root / 'compose.yaml').read_text()
    if 'incudal-panel' not in script or 'command_name=' not in script or not all(value in compose for value in ('services:', '  api:', '  user:', '  admin:')):
        raise ValueError()
except (OSError, ValueError):
    sys.exit(1)
DEPLOYMENT_PY
}
move_deployment() {
  (
  local source="$1" destination="$2"
  command -v flock >/dev/null || { printf '搬移需要 flock；無法安全取得部署操作鎖。\n' >&2; return 1; }
  [[ ! -L "$source/.state" && ! -L "$source/.state/operation.lock" ]] || return 1
  mkdir -p -- "$source/.state" || return 1
  exec 9>"$source/.state/operation.lock"
  flock -n 9 || { printf '另一個部署操作正在進行，未搬移。\n' >&2; return 1; }
  local source_native="$source" destination_native="$destination"
  if command -v cygpath >/dev/null; then
    source_native="$(cygpath -w "$source")" || return 1
    destination_native="$(cygpath -w "$destination")" || return 1
  fi
  python3 - "$source_native" "$destination_native" preflight <<'MOVE_CHECK_PY' || { printf '此系統不支援安全原子搬移；來源服務未停止。\n' >&2; return 1; }
import ctypes
import sys

if not sys.platform.startswith('linux'):
    raise OSError('Linux is required')
renameat2 = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
if renameat2 is None:
    raise OSError('renameat2 is unavailable')
MOVE_CHECK_PY
  bash "$source/panel.sh" export || { printf '備份失敗，未停止或搬移。\n' >&2; return 1; }
  bash "$source/panel.sh" down || { printf '停止失敗，未搬移。\n' >&2; return 1; }
  python3 - "$source_native" "$destination_native" <<'MOVE_PY' || { printf '原子搬移失敗；原部署服務已停止。\n' >&2; return 1; }
import os
import ctypes
import sys

libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1)
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), sys.argv[2])
MOVE_PY
  [[ -d "$destination" && ! -e "$source" ]] || return 1
  deployment_check "$destination" configured || { printf '新位置驗證失敗，資料保留於新路徑；未啟動。\n' >&2; return 1; }
  bash "$destination/panel.sh" up || { printf '新路徑啟動失敗，請在新位置查看狀態與日誌。\n' >&2; return 1; }
  flock -u 9 || return 1
  exec 9>&-
  )
}
dashboard_menu() {
  local directory="${1:-$PWD}" choice value method source_real parent_real destination trusted=''
  { exec 8<>/dev/tty; } 2>/dev/null || die '數字選單需要可用的 /dev/tty；無終端請使用 install DIRECTORY latest 或既有非互動 CLI。'
  while true; do
    printf '\n╭──────────────────────────────────────────╮\n│           XPAYINCUS · 面板管理            │\n╰──────────────────────────────────────────╯\n部署目錄：%s\n\n  [1] 查看狀態\n  [2] 更新面板\n  [3] 安裝新面板\n  [4] 重新拉取鏡像\n  [5] 匯入資料\n  [6] 查看日誌\n  [7] 匯出資料\n  [8] 移動佈署目錄\n  [9] 重建容器\n  [0] 退出腳本\n\n選擇功能 › ' "$directory" >&8
    IFS= read -r choice <&8 || return 0
    case "$choice" in
      0) return 0 ;;
      3)
        printf '\n安裝方式\n  [1] Compose（Docker）\n  [2] 宿主機（交由 Dashboard 上層入口）\n  [0] 返回\n選擇：' >&8
        IFS= read -r method <&8 || return 0
        case "$method" in
          0) continue ;;
          2) printf '%s\n' '交回上層入口：請以 dashboard.sh --host-install 執行宿主機安裝（退出碼 20）。' >&8; return 20 ;;
          1) docker_check || continue ;;
          *) printf '請選擇 [1]、[2] 或 [0]。\n' >&8; continue ;;
        esac
        printf '部署絕對路徑 [%s]：' "$directory" >&8
        IFS= read -r value <&8 || return 0
        if [[ -n "$value" ]]; then directory="$value"; fi
        trusted=''
        [[ "$directory" == /* ]] || { printf '請輸入絕對路徑。\n' >&8; continue; }
        if [[ "$choice" == 3 ]]; then
          printf '確認在 %s 安裝（可建立新目錄）？輸入 yes：' "$directory" >&8
          IFS= read -r value <&8 || return 0
          [[ "$value" == yes ]] || continue
          if bash "$self" install "$directory" latest; then
            bash "$directory/panel.sh" wizard || printf '設定或啟動失敗，請依前述錯誤處理；不宣告安裝完成。\n' >&8
          else
            printf '下載安裝失敗，未執行設定或啟動。\n' >&8
          fi
        fi
        ;;
      1|2|4|5|6|7|9)
        method=configured
        if ! deployment_check "$directory" "$method"; then
          printf '目前目錄不是有效且權限安全的 Compose 部署。請輸入既有部署絕對路徑（不建立目錄，空白返回）：' >&8
          IFS= read -r value <&8 || return 0
          [[ -n "$value" ]] || continue
          directory="$value"; trusted=''
          deployment_check "$directory" "$method" || { printf '目錄無效；未執行任何本機腳本。\n' >&8; continue; }
        fi
        if [[ "$trusted" != "$directory" ]]; then
          printf '即將執行 %s/panel.sh；結構檢查不等同來源驗證。確認這是您管理且信任的部署？輸入 yes：' "$directory" >&8
          IFS= read -r value <&8 || return 0
          [[ "$value" == yes ]] || continue
          trusted="$directory"
        fi
        docker_check || continue
        case "$choice" in
          1)
            bash "$directory/panel.sh" status || printf '狀態查詢失敗。\n' >&8
            while true; do
              printf '\n╭────────────── 服務操作 ──────────────╮\n│ [1] 啟動面板    [2] 停止面板          │\n│ [3] 重啟面板    [4] 強制停止面板      │\n│ [0] 返回主選單                        │\n╰──────────────────────────────────────╯\n選擇操作 › ' >&8
              IFS= read -r method <&8 || return 0
              case "$method" in
                0) break ;;
                1) bash "$directory/panel.sh" up || printf '啟動失敗，請查看狀態與日誌。\n' >&8 ;;
                2)
                  printf '停止會中斷面板服務，但不刪除資料。輸入 stop 確認：' >&8
                  IFS= read -r value <&8 || return 0
                  [[ "$value" == stop ]] && bash "$directory/panel.sh" down || printf '已取消停止或停止失敗。\n' >&8
                  ;;
                3)
                  printf '重啟會中斷現有連線。輸入 restart 確認：' >&8
                  IFS= read -r value <&8 || return 0
                  if [[ "$value" == restart ]]; then
                    bash "$directory/panel.sh" up || printf '重啟失敗，請查看狀態與日誌。\n' >&8
                  else
                    printf '已取消重啟。\n' >&8
                  fi
                  ;;
                4)
                  printf '強制停止會立即中斷所有面板容器。輸入 FORCE-STOP 確認：' >&8
                  IFS= read -r value <&8 || return 0
                  if [[ "$value" == FORCE-STOP ]]; then
                    bash "$directory/panel.sh" kill || printf '強制停止命令失敗，請查看 Docker 狀態。\n' >&8
                  else
                    printf '已取消強制停止。\n' >&8
                  fi
                  ;;
                *) printf '請選擇 [1] 至 [4] 或 [0]。\n' >&8 ;;
              esac
            done
            ;;
          2) bash "$directory/panel.sh" update || printf '更新失敗，請保留備份並依前述階段處理。\n' >&8 ;;
          4) bash "$directory/panel.sh" pull || printf '拉取映像失敗，現有服務未停止。\n' >&8 ;;
          5)
            printf '資料匯入會取代目前資料庫，請先確認已有可用備份。\n備份檔絕對路徑：' >&8
            IFS= read -r value <&8 || return 0
            [[ -n "$value" ]] || continue
            printf '確認取代目前資料庫？輸入 IMPORT：' >&8
            IFS= read -r method <&8 || return 0
            [[ "$method" == IMPORT ]] && bash "$directory/panel.sh" import "$value" --confirm-replace-incudal || printf '已取消匯入或匯入失敗。\n' >&8
            ;;
          6) bash "$directory/panel.sh" logs || printf '日誌查詢結束或失敗。\n' >&8 ;;
          7) bash "$directory/panel.sh" export || printf '備份失敗。\n' >&8 ;;
          9)
            printf '重建將短暫中斷服務，不刪除資料或密鑰；請先備份。輸入 rebuild 確認：' >&8
            IFS= read -r value <&8 || return 0
            [[ "$value" == rebuild ]] || continue
            bash "$directory/panel.sh" up pull --force-recreate || printf '重建失敗，設定與資料保留；請查看日誌。\n' >&8
            ;;
        esac
        ;;
      8)
        method=configured
        if ! deployment_check "$directory" "$method"; then
          printf '目前目錄不是有效的 Compose 部署。請輸入來源部署絕對路徑（空白返回）：' >&8
          IFS= read -r value <&8 || return 0
          [[ -n "$value" ]] || continue
          directory="$value"
          trusted=''
          deployment_check "$directory" "$method" || { printf '來源目錄無效；未執行任何本機腳本。\n' >&8; continue; }
        fi
        if [[ "$trusted" != "$directory" ]]; then
          printf '即將移動 %s 的完整部署資料。確認來源可信？輸入 yes：' "$directory" >&8
          IFS= read -r value <&8 || return 0
          [[ "$value" == yes ]] || continue
          trusted="$directory"
        fi
        printf '新的部署絕對路徑：' >&8
        IFS= read -r value <&8 || return 0
        [[ "$value" == /* ]] || { printf '新路徑必須是絕對路徑。\n' >&8; continue; }
        source_real="$(cd -- "$directory" && pwd -P)"
        parent_real="$(cd -- "$(dirname -- "$value")" 2>/dev/null && pwd -P)" || { printf '新路徑父目錄不存在。\n' >&8; continue; }
        destination="$parent_real/$(basename -- "$value")"
        [[ "$destination" != "$source_real" && "$destination" != "$source_real/"* && "$source_real" != "$destination/"* ]] || { printf '新路徑不可與來源相同或巢狀。\n' >&8; continue; }
        [[ ! -e "$destination" && ! -L "$destination" ]] || { printf '新路徑已存在，拒絕覆蓋。\n' >&8; continue; }
        docker_check || continue
        command -v python3 >/dev/null || { printf '搬移需要 Python 3。\n' >&8; continue; }
        source_native="$source_real"; parent_native="$parent_real"
        if command -v cygpath >/dev/null; then source_native="$(cygpath -w "$source_real")"; parent_native="$(cygpath -w "$parent_real")"; fi
        if ! python3 - "$source_native" "$parent_native" <<'MOVE_CHECK_PY'
import os
import sys
from pathlib import Path

source = Path(sys.argv[1])
parent = Path(sys.argv[2])
if os.stat(source).st_dev != os.stat(parent).st_dev or os.path.ismount(source):
    sys.exit(1)
bad_link_or_mount = any(
    (Path(root) / name).is_mount()
    or ((Path(root) / name).is_symlink() and (
        os.path.isabs(os.readlink(Path(root) / name))
        or not (Path(root) / name).resolve().is_relative_to(source)
    ))
    for root, dirs, files in os.walk(source, followlinks=False)
    for name in dirs + files
)
references_source = any(
    str(source) in path.read_text()
    for path in [source / '.env', *source.glob('*.yaml'), *source.glob('*.yml')]
    if path.is_file()
)
sys.exit(bad_link_or_mount or references_source)
MOVE_CHECK_PY
        then
          printf '搬移預檢失敗：須位於同一檔案系統，且部署不得含掛載點、絕對／越界連結或設定引用來源路徑。\n' >&8
          continue
        fi
        printf '將先匯出資料庫備份，再停止服務並搬移整個目錄；確認？輸入 MOVE：' >&8
        IFS= read -r method <&8 || return 0
        [[ "$method" == MOVE ]] || { printf '已取消搬移。\n' >&8; continue; }
        directory="$source_real"
        if move_deployment "$source_real" "$destination" >&8; then
          :
        else
          if [[ -d "$source_real" ]]; then directory="$source_real"; else directory="$destination"; fi
          printf '搬移未完成；請檢查來源、目標及備份，服務可能已停止。\n' >&8
          continue
        fi
        directory="$destination"
        trusted="$directory"
        printf '部署資料已搬移至 %s。\n' "$directory" >&8
        ;;
      *) printf '請輸入 0 至 9 的選項。\n' >&8 ;;
    esac
  done
}
case "${1:-menu}" in
  menu)
    (($# <= 2)) || die 'menu 最多接受一個部署目錄。'
    [[ -f "$self" ]] || die '請先以 curl/wget 下載到暫存檔，再使用 bash 執行選單。'
    status=0
    dashboard_menu "${2:-$PWD}" || status=$?
    exit "$status"
    ;;
  help|-h|--help) usage; exit 0 ;;
  docker-check) docker_check; exit $? ;;
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
wanted['XPayincus/deploy/compose/operations.py'] = 'operations.py'
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
if 'incudal-operations-v1' in (release / 'README.md').read_text() and not (release / 'operations.py').is_file():
    raise SystemExit('最小 Compose bundle 缺少同版本 operations.py')
if (release / 'operations.py').is_file():
    compile((release / 'operations.py').read_text(), 'operations.py', 'exec')
    managed = (*managed, 'operations.py')
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
        if name in {'update.py', 'operations.py'} and not os.path.lexists(target) and not (previous / name).exists():
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
        if action == 'install' or (name in {'update.py', 'operations.py'} and not os.path.lexists(destination / name)):
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
