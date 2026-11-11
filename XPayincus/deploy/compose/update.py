import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import signal
import time
import uuid

JOURNAL = None
JOURNAL_DATA = {}
PLAN_ONLY = False


def interrupted(signum, frame):
    raise KeyboardInterrupt()


def backup_digest(file):
    digest = hashlib.sha256()
    with file.open('r+b') as source:
        for block in iter(lambda: source.read(1048576), b''):
            digest.update(block)
        os.fsync(source.fileno())
    return digest.hexdigest()


def journal(**fields):
    if JOURNAL is None:
        return
    JOURNAL_DATA.update(fields, updatedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    if JOURNAL.is_symlink():
        fail('journal 不可為符號連結。')
    fd, name = tempfile.mkstemp(prefix='.journal-', dir=JOURNAL.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(JOURNAL_DATA, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, JOURNAL)
        if os.name != 'nt':
            directory = os.open(JOURNAL.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


REPOSITORY = 'XiaoLong-Taiwan/XPayincus'
RELEASES = f'https://github.com/{REPOSITORY}/releases/download'
VERSION = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
FILES = (
    'docker-compose.yml', 'compose.yaml', 'compose.build.yaml', 'panel.sh',
    'download.sh', 'update.py', 'README.md', 'https-proxy.conf.example',
    'origin-entrypoint.sh', 'edge-nginx.conf.template', 'tunnel-nginx.conf.template',
    'Dockerfile', 'Dockerfile.dockerignore', 'api-entrypoint.sh',
    'nginx.conf.template', 'web-entrypoint.sh', 'compose.release.yaml', 'operations.py',
)
PHASE = '更新前置檢查'


def phase(message):
    global PHASE
    PHASE = message
    journal(phase=message)
    print(f'更新階段：{message}', flush=True)


def fail(message):
    raise SystemExit(message)


def run(args, **kwargs):
    return subprocess.run(args, check=True, pass_fds=(9,), **kwargs)


def fetch(url, target):
    label = '最新正式 Release 查詢' if url.endswith('/latest') else '固定版本 SHA256SUMS 下載'
    try:
        run(['bash', str(Path(__file__).with_name('download.sh')), '--fetch', url,
             str(target), '2097152', label])
    except subprocess.CalledProcessError as error:
        fail(f'{label}失敗（exit={error.returncode}）；請依前述 HTTP 狀態處理。部署檔及現有服務未切換。')


def checksum(version, scratch, bundle=False):
    target = scratch / 'SHA256SUMS'
    fetch(f'{RELEASES}/{version}/SHA256SUMS', target)
    artifact = f'xpayincus-compose-{version}.tar.gz' if bundle else f'xpayincus-dashboard-{version}-compose.tar.gz'
    entries = [line.split() for line in target.read_text().splitlines()]
    matches = [entry for entry in entries if len(entry) == 2 and entry[1] == artifact]
    if len(matches) != 1 or not re.fullmatch('[0-9a-f]{64}', matches[0][0]):
        fail('官方 SHA256SUMS 缺少唯一有效的 Dashboard checksum。')
    return matches[0][0]


def stage(base, version, scratch, name):
    phase(f'下載與驗證 {name} {version} 部署工具')
    bundle = name == 'target'
    receipt = base / '.bootstrap/current/receipt.json'
    if name == 'previous' and receipt.is_file():
        bundle = json.loads(receipt.read_text()).get('artifact') == f'xpayincus-compose-{version}.tar.gz'
    digest = checksum(version, scratch, bundle=bundle)
    destination = scratch / name
    try:
        run(['bash', str(base / 'download.sh'), 'install-bundle' if bundle else 'install', str(destination), version, digest])
    except subprocess.CalledProcessError as error:
        fail(f'{PHASE}失敗（exit={error.returncode}）；請檢查前述下載／SHA256／封裝錯誤，原部署未切換。')
    if name == 'target' and not (destination / 'update.py').is_file():
        fail('目標 Release 尚未交付宿主一鍵更新工具。')
    return destination, digest


def settings(base):
    values = {}
    for line in (base / '.env').read_text().splitlines():
        match = re.fullmatch(r'\s*(COMPOSE_[A-Z_]+)\s*=(.*)', line)
        if match:
            key, value = match.groups()
            if key in values:
                fail('重複的 Compose 設定，拒絕更新。')
            values[key] = value.strip().strip('\'"')
    for key in set(values) | {key for key in os.environ if key.startswith('COMPOSE_')}:
        value = os.environ.get(key, values.get(key, ''))
        allowed = {
            'COMPOSE_FILE': ('', 'docker-compose.yml', 'compose.yaml', 'compose.yaml:compose.release.yaml'),
            'COMPOSE_PROJECT_NAME': ('', 'incudal-panel'),
            'COMPOSE_PROFILES': ('', 'nginx', 'cloudflare'),
        }
        if key not in allowed or value not in allowed[key]:
            fail(f'自訂或衝突的 {key}，拒絕更新。')
    for pattern in ('compose.override.*', 'docker-compose.override.*'):
        if list(base.glob(pattern)):
            fail('發現自訂 Compose override，拒絕更新。')


def current_version(base):
    images = re.findall(r'ghcr.io/xiaolong-taiwan/xpayincus-(?:api|panel-web):(v[0-9]+\.[0-9]+\.[0-9]+)',
                        (base / 'compose.yaml').read_text())
    if (base / 'compose.release.yaml').exists():
        override = json.loads((base / 'compose.release.yaml').read_text())
        images = [value['image'].rsplit(':', 1)[-1] for value in override['services'].values()]
    if len(images) != 3 or len(set(images)) != 1 or not VERSION.fullmatch(images[0]):
        fail('無法確認目前正式版本，拒絕更新。')
    return images[0]


def resolve_images(base, compose_entry):
    base = Path(base).resolve()
    if not (base / '.state').is_dir() or (base / '.state').is_symlink():
        fail('操作狀態目錄無效。')
    entry = Path(compose_entry)
    if entry.name not in {'docker-compose.yml', 'compose.yaml'} or entry.parent.resolve() != base:
        fail('非標準 Compose 入口，拒絕解析映像。')
    settings(base)
    version = current_version(base)
    expected = {service: {'image': f'ghcr.io/xiaolong-taiwan/xpayincus-{suffix}:{version}'}
                for service, suffix in [('api', 'api'), ('user', 'panel-web'), ('admin', 'panel-web')]}
    override = json.loads((base / 'compose.release.yaml').read_text())
    if override != {'services': expected}:
        fail('部署映像清單不是標準官方版本。')
    pull_required = False
    for image in sorted({value['image'] for value in expected.values()}):
        reference = image.rsplit(':', 1)[0]
        result = run(['docker', 'buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}'],
                     capture_output=True, text=True)
        digest = json.loads(result.stdout).get('digest', '')
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            fail('無法取得官方映像 digest。')
        inspect = subprocess.run(['docker', 'image', 'inspect', image, '--format', '{{json .RepoDigests}}'],
                                 capture_output=True, text=True)
        local = json.loads(inspect.stdout) if inspect.returncode == 0 else []
        if f'{reference}@{digest}' not in (local or []):
            pull_required = True
    marker = base / '.state/pull-required'
    if marker.is_symlink():
        fail('映像狀態檔不可為符號連結。')
    if pull_required:
        marker.write_text(version + '\n')
    elif marker.exists():
        marker.unlink()
    print(f'部署釘選版本：{version}；' + ('映像需拉取' if pull_required else '映像 digest 相同，略過應用映像 pull'))


def dispatch():
    global PLAN_ONLY, JOURNAL, JOURNAL_DATA
    JOURNAL, JOURNAL_DATA = None, {}
    if len(sys.argv) == 4 and sys.argv[1] == 'resolve-images':
        resolve_images(sys.argv[2], sys.argv[3])
        return
    if len(sys.argv) == 3 and sys.argv[2] in ('--resume-up', '--retry-preflight'):
        try:
            recover_update(Path(sys.argv[1]).resolve(), sys.argv[2])
        except BaseException:
            journal(status='interrupted' if isinstance(sys.exc_info()[1], KeyboardInterrupt) else 'failed')
            raise
        return
    PLAN_ONLY = len(sys.argv) == 3 and sys.argv[2] == '--plan'
    if len(sys.argv) != 2 and not PLAN_ONLY:
        fail('用法：python3 update.py DIRECTORY [--plan]；需由 panel.sh 持鎖執行。')
    try:
        main()
    except BaseException:
        journal(status='interrupted' if isinstance(sys.exc_info()[1], KeyboardInterrupt) else 'failed')
        raise


def update_compose(base, target):
    run(['docker', 'compose', '--project-name', 'incudal-panel', '--project-directory', str(base),
         '--env-file', str(base / '.env'), '--file', str(target / 'compose.yaml'),
         '--file', str(target / 'compose.release.yaml'), 'config', '--quiet'])


def validate_files(base, official):
    current = base / '.bootstrap/current'
    if os.path.lexists(current):
        if not current.is_symlink() or not re.fullmatch(r'release-[0-9a-f]{64}-[A-Za-z0-9_]+', os.readlink(current)):
            fail('bootstrap 指標無效。')
        if current.resolve().parent != (base / '.bootstrap').resolve():
            fail('bootstrap 指標超出部署目錄。')
        for name in FILES:
            entry = base / name
            if name in {'update.py', 'operations.py'} and not os.path.lexists(entry) and not (official / name).exists():
                continue
            if not entry.is_symlink() or os.readlink(entry) != f'.bootstrap/current/{name}':
                fail(f'管理入口有衝突：{name}')
    else:
        for name in ('docker-compose.yml', 'compose.yaml', 'panel.sh', 'download.sh', 'origin-entrypoint.sh',
                     'edge-nginx.conf.template', 'tunnel-nginx.conf.template'):
            if not (base / name).is_file():
                fail(f'手動部署缺少標準檔案：{name}')
    for name in FILES:
        entry = base / name
        if os.path.lexists(entry):
            if (not current.is_symlink() and entry.is_symlink()) or not entry.is_file():
                fail(f'部署檔案不是標準一般檔案：{name}')
            if not (official / name).is_file() or entry.read_bytes() != (official / name).read_bytes():
                fail(f'部署檔案有自訂修改：{name}')


def validate_containers(base):
    ids = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=incudal-panel'],
              capture_output=True, text=True).stdout.split()
    if not ids:
        fail('找不到既有 incudal-panel 容器；請先完成標準部署。')
    containers = json.loads(run(['docker', 'inspect', *ids, 'incudal-panel-api'],
                               capture_output=True, text=True).stdout)
    services = set()
    seen = set()
    for container in containers:
        if container['Id'] in seen:
            continue
        seen.add(container['Id'])
        labels = container['Config'].get('Labels') or {}
        service = labels.get('com.docker.compose.service')
        if service in services:
            fail('同一服務有多個容器，拒絕自動更新。')
        if (labels.get('com.docker.compose.project') != 'incudal-panel'
                or labels.get('com.docker.compose.project.working_dir') != str(base)
                or service not in {'init', 'db', 'api', 'user', 'admin', 'nginx', 'tunnel-origin', 'cloudflared'}):
            fail('現有容器專案、路徑或服務衝突。')
        config_files = labels.get('com.docker.compose.project.config_files', '').split(',')
        if not config_files or any(Path(file).parent != base or Path(file).name not in
                                   {'docker-compose.yml', 'compose.yaml', 'compose.release.yaml'} for file in config_files):
            fail('現有容器使用自訂 Compose 檔案。')
        expected = {'db': {'/var/lib/postgresql/data': 'data/postgres'},
                    'api': {'/opt/incudal/server/certs': 'certs', '/opt/incudal/config': 'config',
                            '/opt/incudal/backups': 'backups', '/deployment/.env': '.env'}}.get(service, {})
        mounts = {mount['Destination']: mount for mount in container['Mounts']}
        for mount in mounts.values():
            if mount.get('Type') == 'bind' and not Path(mount['Source']).is_relative_to(base):
                fail('現有容器含部署目錄外掛載，拒絕更新。')
        for target, source in expected.items():
            mount = mounts.get(target, {})
            if mount.get('Type') != 'bind' or mount.get('Source') != str(base / source):
                fail('現有資料掛載與標準部署不符，拒絕更新。')
        if service in {'db', 'api'} and not container['State']['Running']:
            fail('DB 與 API 必須正在運行，才能備份更新。')
        services.add(service)
    if not {'db', 'api'} <= services:
        fail('缺少既有 DB 或 API。')


def activate(base, target, scratch, backup):
    store = base / '.bootstrap'
    release_dir = (target / '.bootstrap/current').resolve()
    next_dir = store / release_dir.name
    os.rename(release_dir, next_dir)
    pointer = scratch / 'next'
    os.symlink(next_dir.name, pointer)
    current = store / 'current'
    if current.is_symlink():
        created = []
        try:
            for name in FILES:
                added = base / name
                if not os.path.lexists(added):
                    os.symlink(f'.bootstrap/current/{name}', added)
                    created.append(added)
            os.replace(pointer, current)
        except BaseException:
            for added in created:
                added.unlink()
            raise
    else:
        changed = []
        try:
            for name in FILES:
                link = scratch / name
                os.symlink(f'.bootstrap/current/{name}', link)
                os.replace(link, base / name)
                changed.append(name)
            os.replace(pointer, current)
        except BaseException:
            for name in changed:
                (base / name).unlink()
                if (backup / name).exists():
                    shutil.copyfile(backup / name, base / name)
            raise


def recover_update(base, action):
    global JOURNAL, JOURNAL_DATA
    os.umask(0o077)
    state = base / '.state'
    file = state / 'update-journal.json'
    if state.is_symlink() or file.is_symlink():
        fail('操作狀態與 journal 不可為符號連結。')
    data = json.loads(file.read_text())
    if data.get('format') != 'incudal-update-journal-v1' or data.get('status') == 'complete':
        fail('沒有可恢復的更新。')
    if action == '--retry-preflight':
        if data.get('backupComplete'):
            fail('備份後可能已切換；請核對 recover 指引，不接受前置重試。')
        os.rename(file, state / ('interrupted-' + uuid.uuid4().hex + '.json'))
        sys.argv = [sys.argv[0], str(base)]
        main()
        return
    backup = Path(data.get('backup') or '')
    if (not data.get('backupComplete') or not backup.is_absolute()
            or not backup.resolve().is_relative_to((base / 'backups').resolve())
            or not (backup / 'panel.dump').is_file() or (backup / 'panel.dump').stat().st_size == 0):
        fail('尚未完成可確認的 DB 備份，不接受恢復啟動。')
    dump = backup / 'panel.dump'
    if backup.is_symlink() or (base / 'backups').is_symlink() or dump.is_symlink() or backup_digest(dump) != data.get('backupSha256'):
        fail('DB 備份雜湊與 journal 不符，拒絕恢復啟動。')
    signal.signal(signal.SIGTERM, interrupted)
    if current_version(base) != data.get('targetVersion'):
        fail('目前部署不是 journal 的目標版本；請人工核對原子切換結果。')
    settings(base)
    current = base / '.bootstrap/current'
    receipt = json.loads((current / 'receipt.json').read_text())
    if receipt.get('version') != data['targetVersion'] or receipt.get('sha256') != data.get('sha256'):
        fail('bootstrap receipt 與 journal 不符。')
    validate_files(base, current)
    JOURNAL, JOURNAL_DATA = file, data
    try:
        journal(status='running', phase='人工確認後恢復啟動')
        run(['bash', str(base / 'panel.sh'), 'up'])
        journal(status='complete', phase='恢復啟動完成', activated=True)
    except BaseException:
        journal(status='failed')
        raise


def main():
    global JOURNAL, JOURNAL_DATA
    JOURNAL, JOURNAL_DATA = None, {}
    base = Path(sys.argv[1]).resolve()
    os.umask(0o077)
    if not PLAN_ONLY:
        state = base / '.state'
        if state.is_symlink():
            fail('操作狀態目錄不可為符號連結。')
        state.mkdir(exist_ok=True)
        journal_file = state / 'update-journal.json'
        if journal_file.is_symlink():
            fail('journal 不可為符號連結。')
        if journal_file.exists():
            previous = json.loads(journal_file.read_text())
            if previous.get('status') != 'complete':
                fail('已有未完成更新 journal；請先執行 recover，確認狀態後使用 recover --resume-up 或人工保留 journal 再重試。')
            history = state / ('update-' + uuid.uuid4().hex + '.json')
            shutil.copyfile(journal_file, history)
        JOURNAL = journal_file
        JOURNAL_DATA = {'format': 'incudal-update-journal-v1', 'id': uuid.uuid4().hex,
                        'status': 'running', 'backupComplete': False, 'activated': False}
        journal(phase=PHASE)
        signal.signal(signal.SIGTERM, interrupted)
    for name in ('.env', '.bootstrap', 'backups'):
        if (base / name).is_symlink():
            fail(f'{name} 不可為符號連結。')
    settings(base)
    old_version = current_version(base)
    journal(fromVersion=old_version)
    store = base / '.bootstrap'
    store.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.update-', dir=store) as temporary:
        scratch = Path(temporary)
        metadata = scratch / 'release.json'
        phase('查詢最新正式 Release')
        fetch(f'https://api.github.com/repos/{REPOSITORY}/releases/latest', metadata)
        release = json.loads(metadata.read_text())
        version = release.get('tag_name', '')
        if release.get('draft') is not False or release.get('prerelease') is not False or not VERSION.fullmatch(version):
            fail('官方最新 Release 不是正式 vX.Y.Z。')
        if tuple(map(int, version[1:].split('.'))) < tuple(map(int, old_version[1:].split('.'))):
            fail('拒絕自動降版。')
        journal(targetVersion=version)
        target, digest = stage(base, version, scratch, 'target')
        official = target if version == old_version else stage(base, old_version, scratch, 'previous')[0]
        phase('核對本機部署檔與容器身分')
        validate_files(base, official)
        validate_containers(base)
        phase('驗證目標 Compose')
        update_compose(base, target)
        if PLAN_ONLY:
            print(json.dumps({'format': 'incudal-update-plan-v1', 'fromVersion': old_version,
                              'targetVersion': version, 'sha256': digest, 'checksPassed': True,
                              'steps': ['備份部署檔', '匯出 DB', '原子切換工具', '拉取映像', '停止舊服務', 'migration 與健康啟動'],
                              'automaticDatabaseRollback': False}, ensure_ascii=False, indent=2))
            return
        backup = base / 'backups'
        backup.mkdir(exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='before-update-', dir=backup))
        journal(backup=str(backup), sha256=digest)
        phase(f'備份原部署檔與資料庫至 {backup}')
        for name in FILES:
            if (base / name).is_file():
                shutil.copyfile(base / name, backup / name)
        run(['bash', str(base / 'panel.sh'), 'export', str(backup / 'panel.dump')])
        dump = backup / 'panel.dump'
        if not dump.is_file() or dump.is_symlink() or dump.stat().st_size == 0:
            fail('DB 備份缺失或為空，拒絕切換。')
        for saved in backup.iterdir():
            if saved.is_file():
                backup_digest(saved)
        journal(backupComplete=True, backupSha256=backup_digest(dump))
        phase('切換已驗證部署工具')
        try:
            activate(base, target, scratch, backup)
        except OSError:
            fail(f'部署檔切換失敗；尚未執行 up。原部署檔與 DB 備份保留於 {backup}；請檢查入口與 .bootstrap/current，依備份修復後重試。')
        journal(activated=True)
        print(f'已固定官方 {version}，SHA256={digest}；備份：{backup}', flush=True)
        try:
            phase('拉取映像並啟動目標版本')
            run(['bash', str(base / 'panel.sh'), 'up'])
            journal(status='complete', phase='更新完成')
        except subprocess.CalledProcessError:
            fail(f'更新啟動失敗；部署檔與 DB 備份保留於 {backup}。請檢查 status/logs；不自動回滾資料庫。')


if __name__ == '__main__':
    try:
        dispatch()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        detail = f'命令 exit={error.returncode}' if isinstance(error, subprocess.CalledProcessError) else '檔案權限／回應格式錯誤'
        fail(f'更新階段「{PHASE}」失敗：{detail}；請檢查前述輸出及備份。未自動回滾資料庫。')
