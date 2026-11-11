"""Standard-library-only, read-only deployment diagnostics and migration planning."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
from urllib.parse import parse_qsl, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def command(args, env=None):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=30, env=env)
    except (OSError, subprocess.TimeoutExpired):
        return None


def env_values(file):
    values = {}
    for line in file.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
        if not match or match[1] in values:
            raise ValueError('env 語法或重複欄位無法安全解析')
        key, value = match.groups()
        if value.startswith(('"', "'")):
            quote = value[0]
            end = value.find(quote, 1)
            if end < 0 or not re.fullmatch(r'\s*(?:#.*)?', value[end + 1:]):
                raise ValueError('不支援的 env 引號語法')
            value = value[1:end]
        else:
            value = re.sub(r'\s+#.*$', '', value).rstrip()
            if re.search(r'[\s\'"\\]', value):
                raise ValueError('不支援的未加引號 env 值')
        if '\\' in value or re.search(r'[`\x00]|\$[({A-Za-z_]', value):
            raise ValueError('env 含插值或跳脫，需提供實際值的私有副本')
        values[key] = value
    return values


def add(report, name, status, detail):
    report['checks'].append({'name': name, 'status': status, 'detail': detail})


def origins(report, values):
    hosts = []
    for key in ('FRONTEND_URL', 'ADMIN_FRONTEND_URL'):
        try:
            value = values.get(key, '')
            parts = urlsplit(value)
            valid = (parts.scheme == 'https' and parts.hostname and not parts.username
                     and not parts.password and not parts.path and not parts.query and not parts.fragment
                     and not any(c.isspace() for c in value) and (parts.port is None or 0 < parts.port < 65536))
            hosts.append(parts.hostname)
        except ValueError:
            valid = False
            hosts.append(None)
        add(report, key, 'pass' if valid else 'fail', 'HTTPS origin 格式' if valid else '須使用無路徑的 HTTPS origin')
    add(report, 'dual-origin', 'pass' if all(hosts) and hosts[0] != hosts[1] else 'fail', '雙站須使用不同 hostname')
    return hosts


def compose_args(base, values):
    entry = os.environ.get('COMPOSE_FILE', values.get('COMPOSE_FILE', ''))
    if not entry:
        entry = 'docker-compose.yml' if (base / 'docker-compose.yml').is_file() else 'compose.yaml'
    allowed = {'docker-compose.yml', 'compose.yaml', 'compose.yaml:compose.release.yaml'}
    if entry not in allowed:
        raise ValueError('非標準 Compose 入口；請以原生模式檢查或人工核對 override')
    files = entry.split(':')
    if (base / 'compose.release.yaml').is_file() and 'compose.release.yaml' not in files:
        files = ['compose.yaml', 'compose.release.yaml']
    args = ['docker', 'compose', '--project-name', 'incudal-panel', '--project-directory', str(base), '--env-file', str(base / '.env')]
    for name in files:
        args += ['--file', str(base / name)]
    return args


def doctor(options):
    base = Path(options.base).resolve()
    report = {'format': 'incudal-doctor-v1', 'mode': options.mode, 'checks': []}
    values = env_values(Path(options.env_file) if options.env_file else base / '.env')
    hosts = origins(report, values)
    mode = options.mode
    if mode == 'auto':
        mode = 'compose' if (base / 'compose.yaml').is_file() else 'native'
    report['mode'] = mode
    profile = os.environ.get('COMPOSE_PROFILES', values.get('COMPOSE_PROFILES', '')) if mode == 'compose' else options.proxy
    add(report, 'proxy', 'pass' if profile in ('', 'external', 'nginx', 'cloudflare') else 'fail', '入口：' + (profile if profile in ('nginx', 'cloudflare') else 'external／人工代理'))
    if profile == 'nginx' and mode == 'compose':
        for site, host in zip(('user', 'admin'), hosts):
            cert = base / 'tls' / site / 'fullchain.pem'
            key = base / 'tls' / site / 'privkey.pem'
            result = command(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', '0', '-checkhost', host or 'invalid'])
            public = command(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'])
            private = command(['openssl', 'pkey', '-in', str(key), '-passin', 'pass:', '-pubout'])
            valid = result and result.returncode == 0 and public and private and public.returncode == private.returncode == 0 and public.stdout == private.stdout
            add(report, 'tls-' + site, 'pass' if valid else 'fail', '憑證期限、hostname 與私鑰配對；公開信任鏈另由 HTTPS probe 核對')
    elif profile == 'cloudflare':
        token = base / 'secrets/cloudflare_tunnel_token'
        valid = token.is_file() and not token.is_symlink() and token.stat().st_size > 0 and not token.stat().st_mode & 0o077
        add(report, 'tunnel-token', 'pass' if valid else 'fail', 'token 須為非空、權限 600 的一般檔案；不顯示內容')
    if mode == 'compose':
        args = compose_args(base, values)
        if options.env_file:
            args[args.index('--env-file') + 1] = str(Path(options.env_file).resolve())
        config = command(args + ['config', '--quiet'])
        add(report, 'compose-config', 'pass' if config and config.returncode == 0 else 'fail', '三種官方入口均使用 Compose config；不輸出展開後的 secrets')
        result = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=incudal-panel', '--filter', 'label=com.docker.compose.service=api'])
        ids = result.stdout.split() if result and result.returncode == 0 else []
        add(report, 'single-api-container', 'pass' if len(ids) == 1 else 'fail', f'API 容器數：{len(ids)}（含停止的副本）')
        if len(ids) == 1:
            state = command(['docker', 'inspect', ids[0], '--format', '{{json .State}}'])
            data = json.loads(state.stdout) if state and state.returncode == 0 else {}
            add(report, 'api-health', 'pass' if data.get('Running') and data.get('Health', {}).get('Status') == 'healthy' else 'fail', 'Docker API healthcheck')
            processes = command(['docker', 'top', ids[0], '-eo', 'comm'])
            count = sum(line.strip() in ('node', 'nodejs') for line in processes.stdout.splitlines()) if processes and processes.returncode == 0 else -1
            add(report, 'single-api-process', 'pass' if count == 1 else 'fail', f'容器內 Node 程序數：{count}')
        query = "SELECT CASE WHEN count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)=0 AND count(*)>0 THEN 'clean' ELSE 'pending' END FROM _prisma_migrations;"
        migration = command(args + ['exec', '-T', 'db', 'sh', '-eu', '-c', 'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; export PGOPTIONS="-c default_transaction_read_only=on"; exec psql -X -h 127.0.0.1 -U incudal -d incudal -At -c ' + shlex.quote(query)])
        add(report, 'migration', 'pass' if migration and migration.returncode == 0 and migration.stdout.strip() == 'clean' else 'warn', '唯讀 migration ledger；仍須比對目標版本的全部 migration，不將健康等同 schema 相容')
    else:
        result = command(['ps', '-eo', 'args='])
        count = sum(bool(re.search(r'(?:^|/)node(?:js)?\s', line)) and ('server/dist/' in line or '/opt/incudal/' in line) for line in result.stdout.splitlines()) if result and result.returncode == 0 else -1
        add(report, 'single-api-process', 'pass' if count == 1 else ('fail' if count > 1 else 'warn'), f'可識別原生 API Node 程序數：{count}；須人工核對自訂程序管理器')
        database = urlsplit(values.get('DATABASE_URL', ''))
        pg = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
        valid = database.scheme in ('postgres', 'postgresql') and database.hostname and database.username and database.path.strip('/') and not database.fragment
        if valid:
            pg.update(PGHOST=database.hostname, PGPORT=str(database.port or 5432), PGUSER=unquote(database.username),
                      PGPASSWORD=unquote(database.password or ''), PGDATABASE=unquote(database.path[1:]),
                      PGCONNECT_TIMEOUT='10', PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000')
            mapping = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY'}
            ignored = {'schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size'}
            parameters = parse_qsl(database.query, keep_blank_values=True)
            valid = len({key for key, _ in parameters}) == len(parameters)
            for key, value in parameters:
                if key in mapping:
                    pg[mapping[key]] = value
                elif key not in ignored:
                    valid = False
        query = "SELECT CASE WHEN count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)=0 AND count(*)>0 THEN 'clean' ELSE 'pending' END FROM _prisma_migrations;"
        migration = command(['psql', '-X', '-w', '-At', '-c', query], env=pg) if valid else None
        add(report, 'migration', 'pass' if migration and migration.returncode == 0 and migration.stdout.strip() == 'clean' else 'warn', '原生唯讀 ledger 檢查；需 PostgreSQL client，仍須比對目標 migration 清單，不輸出連線資料')
    for key in ('FRONTEND_URL', 'ADMIN_FRONTEND_URL'):
        value = values.get(key, '')
        try:
            parts = urlsplit(value)
            if parts.scheme != 'https' or parts.username or parts.password or parts.path or not parts.hostname:
                raise ValueError()
            with build_opener(NoRedirect()).open(Request(value + '/api/health', headers={'User-Agent': 'XPayincus-Doctor'}), timeout=10) as response:
                ok = response.status == 200 and isinstance(json.loads(response.read(65536)), dict)
            add(report, 'https-api-' + key, 'pass' if ok else 'fail', '公開 HTTPS 信任鏈與 API 回應')
        except Exception:
            add(report, 'https-api-' + key, 'fail', 'HTTPS／DNS／代理路由或 API 回應失敗；不輸出回應及敏感網址')
    return report


def migration_plan(options):
    root = Path(options.export).resolve()
    report = {'format': 'incudal-migration-plan-v1', 'checks': [], 'exportComplete': False, 'switchReady': False}
    manifest = json.loads((root / 'manifest.json').read_text())
    add(report, 'manifest', 'pass' if manifest.get('format') == 'incudal-legacy-host-export-v1' and manifest.get('databaseFormat') == 'PostgreSQL custom' else 'fail', '舊宿主 export v1／PostgreSQL custom')
    if (root / 'manifest.json').is_symlink() or (root / 'COMPLETE').is_symlink():
        raise ValueError('manifest 與 marker 不可為符號連結')
    complete = (root / 'COMPLETE').is_file() and not (root / 'INCOMPLETE').exists()
    add(report, 'complete-marker', 'pass' if complete else 'fail', 'COMPLETE 只代表匯出完成')
    seen = set()
    for entry in manifest['files']:
        name = entry['path']
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or '\\' in name or name in seen or not relative.parts:
            raise ValueError('manifest 含不安全或重複路徑')
        seen.add(name)
        file = root.joinpath(*relative.parts)
        if any(parent.is_symlink() for parent in [file, *file.parents] if parent != root.parent):
            raise ValueError('export 不可包含符號連結')
        digest = hashlib.sha256()
        if file.is_file():
            with file.open('rb') as source:
                for block in iter(lambda: source.read(1048576), b''):
                    digest.update(block)
        ok = file.is_file() and file.stat().st_size == entry['bytes'] and digest.hexdigest() == entry['sha256']
        add(report, 'inventory-' + str(len(seen)), 'pass' if ok else 'fail', 'manifest 檔案大小與 SHA256' )
    required = {'database.dump', 'source/legacy.env', 'secrets/encryption_key'}
    required_ok = required <= seen and all((root / name).is_file() and (root / name).stat().st_size > 0 for name in required)
    add(report, 'required-inventory', 'pass' if required_ok else 'fail', 'DB、原始 env、原 encryption_key 必須非空且納入 inventory')
    report['exportComplete'] = complete and all(item['status'] == 'pass' for item in report['checks'])
    values = env_values(root / 'source/legacy.env')
    mappings = {'FRONTEND_URL': 'FRONTEND_URL', 'ADMIN_FRONTEND_URL': 'ADMIN_FRONTEND_URL', 'ADMIN_EMAIL': 'ADMIN_EMAIL', 'JWT_SECRET': 'secrets/jwt_secret', 'COOKIE_SECRET': 'secrets/cookie_secret', 'ENCRYPTION_KEY': 'secrets/encryption_key', 'ADMIN_PASSWORD': 'secrets/admin_password', 'PANEL_CRT_PATH': 'certs/client.crt', 'PANEL_KEY_PATH': 'certs/client.key'}
    report['envMapping'] = [{'source': key, 'target': target, 'present': bool(values.get(key)) or target in seen} for key, target in mappings.items()]
    report['unmappedEnvKeys'] = sorted(set(values) - set(mappings) - {'DATABASE_URL'})
    report['databaseMapping'] = 'DATABASE_URL 不沿用舊宿主；隔離還原後使用目標 DB 與新的 postgres_password'
    for name in ('encryption_key', 'jwt_secret', 'cookie_secret', 'admin_password'):
        file = root / 'secrets' / name
        add(report, 'secret-' + name, 'pass' if 'secrets/' + name in seen and file.is_file() and file.stat().st_size > 0 else 'fail', '保留原值；不輸出密鑰')
    pair = {'certs/client.crt', 'certs/client.key'}
    cert_required = bool(pair & seen or values.get('PANEL_CRT_PATH') or values.get('PANEL_KEY_PATH'))
    add(report, 'incus-pair-required', 'pass' if pair <= seen else ('fail' if cert_required else 'warn'), '已有 Incus 身分或明確路徑時須保留完整配對；來源皆缺仍須核對 DB 自訂憑證，不代表可生成新身分')
    if pair <= seen:
        public = command(['openssl', 'x509', '-in', str(root / 'certs/client.crt'), '-pubkey', '-noout'])
        private = command(['openssl', 'pkey', '-in', str(root / 'certs/client.key'), '-passin', 'pass:', '-pubout'])
        valid = public and private and public.returncode == private.returncode == 0 and public.stdout == private.stdout
        add(report, 'incus-pair', 'pass' if valid else 'fail', '原 Incus mTLS 公私鑰配對；不輸出內容，與網站 TLS 分開保存')
    listing = command(['pg_restore', '--list', str(root / 'database.dump')])
    valid = listing and listing.returncode == 0
    add(report, 'dump-readable', 'pass' if valid else 'fail', 'pg_restore --list，沒有連線資料庫')
    add(report, 'schema-ledger', 'warn', 'archive 含 Prisma ledger' if valid and '_prisma_migrations' in listing.stdout else 'archive 無法確認 Prisma ledger；須隔離還原核對')
    if options.target_schema:
        schema = Path(options.target_schema)
        original = root / 'source/schema.prisma'
        equal = 'source/schema.prisma' in seen and original.is_file() and schema.is_file() and hashlib.sha256(original.read_bytes()).digest() == hashlib.sha256(schema.read_bytes()).digest()
        add(report, 'schema-comparison', 'pass' if equal else 'warn', 'schema 位元組相同' if equal else '來源缺少 schema 或與目標不同；不可直接切換')
    else:
        add(report, 'schema-comparison', 'warn', '以 --target-schema 指定目標 schema；最小包不含應用 schema，須使用同版本完整來源或官方 API image')
    add(report, 'cutover', 'warn', '匯出不等於可切換；必須停止舊寫入端、重新匯出並完成隔離還原、migration 及解密驗收')
    dump = shlex.quote(str(root / 'database.dump'))
    report['steps'] = [
        '在另一台隔離主機啟動 PostgreSQL 16；不要掛載正式 data 或連接正式 DATABASE_URL。',
        '以隔離專用帳號設定 PGHOST/PGPORT/PGUSER/PGDATABASE 與私有 PGPASSFILE；以下命令只供人工在隔離環境執行。',
        'createdb --template=template0 incudal_rehearsal',
        f'pg_restore --dbname=incudal_rehearsal --no-owner --no-acl --exit-on-error --single-transaction {dump}',
        '以唯讀 SQL 核對 _prisma_migrations migration_name/checksum/finished_at/rolled_back_at，與目標官方 image／同版本來源的 migrations 逐一比較。',
        '只在隔離環境部署目標版本執行 migration；關閉付款、排程、外寄與 Agent／Incus 寫入網路，驗證原 encryption_key 解密、登入及憑證信任。',
        '記錄隔離驗收證據與備份；安排停寫窗口，停止舊 API／worker 後重新匯出、重算本計畫，再人工批准切換。正式 DB 不自動還原或 rollback。'
    ]
    return report


def recovery(options):
    base = Path(options.base).resolve()
    file = base / '.state/update-journal.json'
    report = {'format': 'incudal-recovery-v1', 'checks': [], 'automaticDatabaseRollback': False}
    if not file.is_file() or file.is_symlink():
        add(report, 'journal', 'warn', '沒有可信 journal；使用 doctor/status 與備份人工核對')
        return report
    data = json.loads(file.read_text())
    if data.get('format') != 'incudal-update-journal-v1' or (base / '.state').is_symlink():
        raise ValueError('journal 格式或狀態目錄無效')
    report['operation'] = {key: data.get(key) for key in ('id', 'status', 'phase', 'fromVersion', 'targetVersion', 'backup', 'backupComplete', 'activated', 'updatedAt')}
    add(report, 'journal', 'pass' if data.get('status') == 'complete' else 'warn', '日誌是最後持久化進度；running 可能仍在執行或已中斷，非鎖狀態證明')
    backup = Path(data.get('backup') or base / 'backups/__missing__')
    safe = backup.is_absolute() and backup.resolve().is_relative_to((base / 'backups').resolve()) and not backup.is_symlink() and not (base / 'backups').is_symlink()
    dump = backup / 'panel.dump'
    valid = safe and data.get('backupComplete') and dump.is_file() and not dump.is_symlink() and dump.stat().st_size > 0
    if valid:
        digest = hashlib.sha256()
        with dump.open('rb') as source:
            for block in iter(lambda: source.read(1048576), b''):
                digest.update(block)
        valid = digest.hexdigest() == data.get('backupSha256')
    add(report, 'backup', 'pass' if valid else 'warn', '已完成備份可用' if valid else '未證實備份完整；禁止切換或還原')
    report['steps'] = ['先執行 bash panel.sh status 與 python3 operations.py doctor --base ' + shlex.quote(str(base)), '僅在 backupComplete=false 時，修正失敗原因後執行 bash panel.sh recover --retry-preflight；保留舊 journal 並重新下載驗證與備份。', '若已切換或啟動中斷，保留 journal 與備份，查看 bash panel.sh logs api；migration 可能已執行，不得盲目退版。', '確認目標部署檔、secrets 與 schema 相容後，執行 bash panel.sh recover --resume-up；會取得既有鎖，重新拉取／檢查後啟動，不還原 DB。']
    return report


def main():
    parser = argparse.ArgumentParser(description='唯讀 doctor／migration plan／recovery；不需要 pnpm')
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('doctor', 'migration-plan', 'recover'):
        item = sub.add_parser(action)
        item.add_argument('--json', action='store_true')
        item.add_argument('--base', default=str(Path(__file__).parent))
        if action == 'doctor':
            item.add_argument('--mode', choices=('auto', 'compose', 'native'), default='auto')
            item.add_argument('--env-file')
            item.add_argument('--proxy', choices=('external', 'nginx', 'cloudflare'), default='external')
        if action == 'migration-plan':
            item.add_argument('export')
            item.add_argument('--target-schema')
    options = parser.parse_args()
    try:
        report = {'doctor': doctor, 'migration-plan': migration_plan, 'recover': recovery}[options.action](options)
    except (OSError, ValueError, KeyError, TypeError):
        report = {'format': 'incudal-operations-error-v1', 'checks': [{'name': 'input', 'status': 'fail', 'detail': '輸入、manifest、env 或系統回應無效；不輸出私有內容'}]}
    report['ok'] = not any(check['status'] == 'fail' for check in report['checks'])
    if options.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for check in report['checks']:
            print(f"[{check['status']}] {check['name']}: {check['detail']}")
        for key in ('exportComplete', 'switchReady'):
            if key in report:
                print(f'{key}: {report[key]}')
        for step in report.get('steps', []):
            print('→ ' + step)
        if 'envMapping' in report:
            for mapping in report['envMapping']:
                print(f"env: {mapping['source']} -> {mapping['target']} (present={mapping['present']})")
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
