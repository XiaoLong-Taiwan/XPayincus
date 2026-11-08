#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'bash download.sh install DIRECTORY VERSION SHA256' \
    'bash download.sh update DIRECTORY VERSION SHA256' \
    '來源固定為 XiaoLong-Taiwan/XPayincus 的固定版本 Release Dashboard Compose 資產。' \
    '只準備部署檔案，不呼叫 Docker、不初始化或覆寫私人資料。'
}
case "${1:-help}" in
  help|-h|--help) usage; exit 0 ;;
  install|download) action=install ;;
  update) action=update ;;
  *) usage; exit 2 ;;
esac
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
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 20 --max-time 300 --retry 2 --max-filesize 104857600 \
  --output "$scratch/source.tar.gz" \
  "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/$version/xpayincus-dashboard-$version-compose.tar.gz"
printf '%s  %s\n' "$checksum" "$scratch/source.tar.gz" | sha256sum --check --status || die '下載校驗失敗；部署未更新。'
python3 - "$scratch" "$destination" "$action" "$version" "$checksum" <<'PY'
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

scratch, destination = map(Path, sys.argv[1:3])
action, version, checksum = sys.argv[3:]
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
            continue
        if not member.isfile() or not 0 < member.size <= 2097152:
            raise SystemExit('必要部署檔案必須為非空一般檔案且不超過 2 MiB')
        with archive.extractfile(member) as source:
            (release / wanted[name]).write_bytes(source.read())
if any(not (release / name).is_file() for name in (*managed, 'VERSION')):
    raise SystemExit('下載缺少完整的部署檔案')
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
    'artifact': f'xpayincus-dashboard-{version}-compose.tar.gz', 'sha256': checksum
}, indent=2) + '\n')
store = destination / '.bootstrap'
current = store / 'current'
if action == 'update':
    if not current.is_symlink() or not re.fullmatch(r'release-[0-9a-f]{64}-[A-Za-z0-9_]+', os.readlink(current)):
        raise SystemExit('只支援 bootstrap 管理的部署；不覆寫既有手動部署')
    previous = store / os.readlink(current)
    if previous.is_symlink() or not previous.is_dir():
        raise SystemExit('目前 release 無效')
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
