#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

fail() { printf '錯誤：%s\n' "$*" >&2; exit 1; }
fetch() {
  local url="$1" target="$2" status
  if command -v curl >/dev/null 2>&1; then
    if curl -q -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 600 --retry 2 -o "$target" "$url"; then :; else
      status=$?; fail "HTTPS 下載失敗（curl exit=$status）：$url；請檢查 HTTP、TLS、代理及 repository 權限，403 不保證可消除。"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget --no-config --https-only --timeout=600 --tries=3 -O "$target" "$url"; then :; else
      status=$?; fail "HTTPS 下載失敗（wget exit=$status）：$url；請檢查 HTTP、TLS、代理及 repository 權限，403 不保證可消除。"
    fi
  else
    fail '需要 curl 或 wget。'
  fi
  [[ -s "$target" ]] || fail "HTTPS 下載得到空檔：$url"
}
work=''
trap 'if [[ -n "$work" ]]; then rm -rf -- "$work"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
host_install() {
  local arch version artifact answer
  (($# == 0)) || fail '--host-install 不接受其他參數；僅支援最新正式版全新安裝。'
  [[ "$(id -u)" == 0 ]] || fail '宿主機安裝需要 root；請自行以 sudo bash dashboard.sh --host-install 執行。'
  [[ "$(uname -s)" == Linux ]] || fail '宿主機安裝僅支援 Linux Debian 12+／Ubuntu 22.04+。'
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) fail '不支援的宿主架構。' ;; esac
  [[ ! -e /opt/incudal && ! -L /opt/incudal ]] || fail '偵測到既有 /opt/incudal；請使用既有原生更新流程，不在此續裝或覆寫。'
  command -v python3 >/dev/null || fail '宿主入口驗證需要 python3。'
  { exec 9<>/dev/tty; } 2>/dev/null || fail '宿主安裝需要 /dev/tty 明確確認與完成安裝精靈。'
  printf '%s\n' '宿主機安裝會安裝系統套件（Node.js 22、PostgreSQL 16、Redis、pnpm 等）、建立 incudal 帳號與資料庫、寫入 /opt/incudal、root helpers／sudoers／systemd，執行 migration 並啟動面板服務；可另配置 Nginx／Certbot 或 Cloudflare Tunnel。請先備份，確認無既有 Compose／原生服務衝突。這不是 Incus 安裝器。' >&9
  printf '確認對此宿主機執行全新 Panel 安裝？輸入 INSTALL：' >&9
  IFS= read -r answer <&9 || return 1
  [[ "$answer" == INSTALL ]] || { printf '已取消宿主機安裝。\n' >&2; return 0; }
  fetch 'https://api.github.com/repos/XiaoLong-Taiwan/XPayincus/releases/latest' "$work/release.json"
  version="$(python3 - "$work/release.json" "$arch" <<'RELEASE_PY'
import json
from pathlib import Path
import re
import sys

release = json.loads(Path(sys.argv[1]).read_text())
tag = release.get('tag_name', '')
if not isinstance(tag, str) or not re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag) or release.get('draft') is not False or release.get('prerelease') is not False:
    sys.exit('需要官方最新正式 vX.Y.Z Release。')
name = f'xpayincus-panel-{tag}-linux-{sys.argv[2]}.tar.gz'
for required in (name, name + '.sha256'):
    matches = [asset for asset in release.get('assets', []) if asset.get('name') == required]
    if len(matches) != 1:
        sys.exit('正式 Release 缺少唯一 Panel artifact／checksum：' + required)
print(tag)
RELEASE_PY
)"
  artifact="xpayincus-panel-$version-linux-$arch.tar.gz"
  fetch "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/$version/$artifact" "$work/$artifact"
  fetch "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/$version/$artifact.sha256" "$work/$artifact.sha256"
  fetch "https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/$version/XPayincus/scripts/install-panel.sh" "$work/install-panel.sh"
  python3 - "$work" "$artifact" "$version" <<'VERIFY_PY'
import hashlib
import json
from collections import deque
from pathlib import Path, PurePosixPath
import posixpath
import re
import shlex
import sys
import tarfile

work = Path(sys.argv[1])
name, version = sys.argv[2:]
archive = work / name
lines = (work / (name + '.sha256')).read_text().splitlines()
if len(lines) != 1 or not re.fullmatch(r'[a-fA-F0-9]{64}(?:[ \t]+\*?' + re.escape(name) + r')?', lines[0]):
    sys.exit('Panel checksum 格式或檔名不符。')
with archive.open('rb') as source:
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1048576), b''):
        digest.update(chunk)
    actual = digest.hexdigest()
if actual != lines[0][:64].lower():
    sys.exit('Panel SHA256 校驗失敗。')
required = {'version.json', 'server/dist/app.js', 'deploy/incudal-online-task.sh.example',
            'deploy/incudal-systemctl-wrapper.sh.example', 'deploy/incudal-ota-chown-wrapper.sh.example'}
seen = {}
total = 0
with tarfile.open(archive, 'r:gz') as bundle:
    members = bundle.getmembers()
    if len(members) > 300000:
        sys.exit('Panel archive 成員過多。')
    for member in members:
        raw = member.name
        path = PurePosixPath(raw)
        key = str(path)
        if path.is_absolute() or '..' in path.parts or '\\' in raw or key in seen or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            sys.exit('Panel archive 含不安全路徑、重複成員或特殊檔案。')
        seen[key] = member
        total += member.size
        if total > 4294967296 or member.size > 536870912:
            sys.exit('Panel archive 解壓大小超出限制。')
        if member.issym() or member.islnk():
            link = member.linkname
            target = posixpath.normpath(posixpath.join(str(path.parent), link) if member.issym() else link)
            if not link or '\\' in link or link.startswith('/') or target == '..' or target.startswith('../'):
                sys.exit('Panel archive 含越界連結。')
    for key in seen:
        if any(str(parent) in seen and not seen[str(parent)].isdir() for parent in PurePosixPath(key).parents if str(parent) != '.'):
            sys.exit('Panel archive 成員穿越連結或一般檔案。')
    for key, member in seen.items():
        if not (member.issym() or member.islnk()):
            continue
        pending = deque(PurePosixPath(posixpath.join(str(PurePosixPath(key).parent), member.linkname) if member.issym() else member.linkname).parts)
        resolved = []
        hops = 0
        while pending:
            part = pending.popleft()
            if part == '..':
                if not resolved:
                    sys.exit('Panel archive 連結鏈越界。')
                resolved.pop()
                continue
            if part == '.':
                continue
            resolved.append(part)
            target = seen.get('/'.join(resolved))
            if target and (target.issym() or target.islnk()):
                hops += 1
                if hops > 40:
                    sys.exit('Panel archive 連結循環或過深。')
                resolved.pop()
                if target.islnk():
                    resolved = []
                pending.extendleft(reversed(PurePosixPath(target.linkname).parts))
    if any(key not in seen or not seen[key].isfile() or seen[key].size == 0 for key in required):
        sys.exit('Panel artifact 缺少原生服務或 root helpers。')
    if seen['version.json'].size > 1048576:
        sys.exit('Panel version.json 過大。')
    metadata = json.loads(bundle.extractfile(seen['version.json']).read())
    if metadata.get('version') != version:
        sys.exit('Panel artifact 版本不符。')
installer = (work / 'install-panel.sh').read_text()
checks = ('readonly GITHUB_REPO="XiaoLong-Taiwan/XPayincus"', 'verify_release_checksum "$tar_file" || return 1',
          'validate_release_archive "$tar_file" || return 1', 'install_verified_root_helpers_from_archive "$tar_file" || return 1',
          'tar_file=$(obtain_release) || exit 1', 'if [[ "${BASH_SOURCE[0]}" == "$0" ]]')
if not all(value in installer for value in checks):
    sys.exit('此正式版本安裝器不符合支援的 checksum／root helper 介面；請由維護者確認相容性。')
start = installer.find('\nobtain_release() {\n')
end = installer.find('\n}\n', start)
if start < 0 or end < 0 or installer.count('\nobtain_release() {\n') != 1:
    sys.exit('不支援的安裝器產物取得介面。')
body = '\nobtain_release() {\n    printf "%s\\n" ' + shlex.quote(str(archive)) + '\n}'
installer = installer[:start] + body + installer[end + 2:]
(work / 'run-panel.sh').write_text(installer)
print('已固定正式版本並驗證 Panel SHA256、封存安全與安裝器介面：' + version, file=sys.stderr)
VERIFY_PY
  bash -n "$work/run-panel.sh"
  bash "$work/run-panel.sh" <&9
}
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  printf '%s\n' 'dashboard.sh [menu [DIRECTORY]|install DIRECTORY latest|...]' 'dashboard.sh --host-install  最新正式版原生 Panel 全新安裝（root、互動確認）'
  exit 0
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/xpayincus-dashboard.XXXXXXXX")" || fail '無法建立私人暫存目錄。'
if [[ "${1:-}" == --host-install ]]; then
  shift
  host_install "$@"
  exit "$?"
fi
fetch 'https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/XPayincus/deploy/compose/download.sh' "$work/download.sh"
status=0
bash "$work/download.sh" "$@" || status=$?
if [[ "$status" == 20 && ( $# == 0 || "${1:-}" == menu ) ]]; then
  host_install
else
  exit "$status"
fi
