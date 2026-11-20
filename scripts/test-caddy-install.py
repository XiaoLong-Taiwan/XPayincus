import os
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'XPayincus/server/templates/caddy.sh').read_text()
HOST = (ROOT / 'XPayincus/server/templates/install.sh').read_text()
BASH = os.environ.get('AGENT_TEST_BASH', 'bash')


class CaddyInstallTests(unittest.TestCase):
    def test_initial_apt_failure_does_not_run_service_rollback(self):
        stage = SOURCE[SOURCE.index('OLD_SERVICE_ACTIVE=false'):SOURCE.index('install -d -o root -g caddy')]
        harness = f'''set -euo pipefail
CADDYFILE=/dev/null
systemctl() {{ printf 'systemctl:%s\\n' "$*"; return 1; }}
apt-get() {{ printf 'apt:%s\\n' "$*"; return 1; }}
log() {{ :; }}
error() {{ printf '%s\\n' "$*"; }}
{stage}
'''
        result = subprocess.run([BASH, '-s'], input=harness, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('APT update failed before Caddy package or service changes', result.stdout)
        self.assertEqual([line for line in result.stdout.splitlines() if line.startswith(('systemctl:', 'apt:'))],
                         ['systemctl:is-active --quiet caddy', 'systemctl:is-enabled --quiet caddy', 'apt:update --error-on=any -qq'])

    @unittest.skipUnless(os.name == 'posix', 'requires POSIX permissions')
    def test_zabbly_keyring_and_source_are_readable_with_private_umask(self):
        for download_fails in (False, True):
            with self.subTest(download_fails=download_fails), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                (base / 'sources.list.d').mkdir()
                function = HOST[HOST.index('install_incus() {'):HOST.index('install_caddy() {')]
                function = function.replace('/etc/apt/', f'{directory}/')
                harness = f'''set -euo pipefail
umask 077
OS_CODENAME=trixie ARCH=amd64
incus() {{ return 1; }}
step() {{ :; }}
log() {{ :; }}
curl() {{ printf 'public key'; return {int(download_fails)}; }}
gpg() {{ cat > "${{@: -1}}"; }}
apt-get() {{ printf '%s\\n' "$*"; }}
{function}
install_incus || exit 7
'''
                result = subprocess.run([BASH, '-s'], input=harness, capture_output=True, text=True)
                self.assertEqual(result.returncode, 7 if download_fails else 0, result.stderr)
                keyrings = base / 'keyrings'
                key = keyrings / 'zabbly.gpg'
                source = base / 'sources.list.d' / 'zabbly-incus-stable.sources'
                self.assertFalse(list(keyrings.glob('.zabbly.*')))
                if download_fails:
                    self.assertFalse(key.exists())
                    self.assertFalse(source.exists())
                    self.assertEqual(result.stdout, '')
                else:
                    self.assertEqual(keyrings.stat().st_mode & 0o777, 0o755)
                    self.assertEqual(key.stat().st_mode & 0o777, 0o644)
                    self.assertEqual(source.stat().st_mode & 0o777, 0o644)
                    self.assertIn(f'Signed-By: {key}', source.read_text())
                    self.assertIn('update --error-on=any -qq', result.stdout)

    def test_listener_detection_rejects_wildcard_ipv4_and_ipv6(self):
        probe = next(line.strip() for line in SOURCE.splitlines() if line.strip().startswith('PUBLIC_ADMIN_LISTENER='))
        for address in ('127.0.0.1:2019', '0.0.0.0:2019', '[::]:2019', '[::1]:2019', '*:2019', '1127.0.0.1:2019'):
            harness = f'''set -euo pipefail
ss() {{ printf 'LISTEN 0 128 %s 0.0.0.0:*\\n' '{address}'; }}
{probe}
[[ -n "$PUBLIC_ADMIN_LISTENER" ]] && printf public || printf local
'''
            result = subprocess.run([BASH, '-s'], input=harness, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'local' if address == '127.0.0.1:2019' else 'public')

    def test_fresh_package_config_replaced_and_existing_sites_preserved(self):
        stage = SOURCE[SOURCE.index('if [[ "$HAD_EXISTING_CADDYFILE" == "true" ]]'):SOURCE.index('install -d -o root -g root -m 0755 "$CADDY_OVERRIDE_DIR"')]
        for address in (None, '127.0.0.1:2019', 'localhost:2019', '0.0.0.0:2019'):
            existing = address is not None
            with self.subTest(address=address), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                original = f'{{\n admin {address} # keep admin comment\n}}\nexample.test {{ respond "localhost:2019 keep" }}\n' if existing else ':80 { respond "package default" }\n'
                config = base / 'Caddyfile'
                config.write_text(original)
                path = str(base).replace('\\', '/')
                if os.name == 'nt':
                    path = '/' + path[0].lower() + path[2:]
                harness = f'''set -euo pipefail
CADDY_CONFIG_DIR='{path}'
CADDYFILE="$CADDY_CONFIG_DIR/Caddyfile"
CADDY_ADMIN_ADDRESS=127.0.0.1:2019
HAD_EXISTING_CADDYFILE={'true' if existing else 'false'}
chown() {{ :; }}
caddy() {{
 if [[ "$1" == adapt ]]; then
   local address
   address=$(awk '$1 == "admin" {{ print $2 }}' "$3")
   printf '{{"admin":{{"listen":"%s"}}}}' "$address"
 else
   [[ "$1" == validate ]]
 fi
}}
error() {{ printf '%s\\n' "$*" >&2; }}
{stage}
if [[ -n "$CADDYFILE_NEW" ]]; then cat "$CADDYFILE_NEW"; else printf preserved; fi
'''
                result = subprocess.run([BASH, '--noprofile', '--norc', '-s'], input=harness, capture_output=True, text=True)
                self.assertEqual(config.read_text(), original)
                if address == '0.0.0.0:2019':
                    self.assertNotEqual(result.returncode, 0)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    expected = original.replace(f'admin {address}', 'admin 127.0.0.1:2019') if existing else '{\n    admin 127.0.0.1:2019\n}\n'
                    self.assertEqual(result.stdout, expected)

    def test_autosave_migration_preserves_sites_and_rejects_unsafe_admin(self):
        stage = SOURCE[SOURCE.index('if [[ "$HAD_OLD_AUTOSAVE" == "true" ]]; then'):SOURCE.index('SWITCH_OK=true')]
        for admin in (None, {'listen': 'localhost:2019'}, {'listen': '127.0.0.1:2019'},
                      {'listen': '0.0.0.0:2019'}, {'disabled': True}, {'config': {'persist': False}}):
            for valid in (True, False):
                with self.subTest(admin=admin, valid=valid), tempfile.TemporaryDirectory() as directory:
                    config = Path(directory) / 'autosave.json'
                    original = {'apps': {'http': {'servers': {'sites': {'listen': [':443'], 'routes': [{'handle': [{'handler': 'static_response', 'body': 'keep'}]}]}}}}}
                    if admin is not None:
                        original['admin'] = admin
                    config.write_text(json.dumps(original))
                    path = str(config).replace('\\', '/')
                    if os.name == 'nt':
                        path = '/' + path[0].lower() + path[2:]
                    harness = f'''set -euo pipefail
CADDY_AUTOSAVE='{path}'
HAD_OLD_AUTOSAVE=true
BACKUP_DIR=$(dirname "$CADDY_AUTOSAVE")
chown() {{ :; }}
chmod() {{ :; }}
caddy() {{ return {0 if valid else 1}; }}
{stage}
cat "$AUTOSAVE_NEW"
'''
                    result = subprocess.run([BASH, '-s'], input=harness, capture_output=True, text=True)
                    self.assertEqual(json.loads(config.read_text()), original)
                    safe = admin is None or admin.get('listen') in ('localhost:2019', '127.0.0.1:2019')
                    if safe and valid:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        expected = json.loads(json.dumps(original))
                        expected.setdefault('admin', {})['listen'] = '127.0.0.1:2019'
                        self.assertEqual(json.loads(result.stdout), expected)
                    else:
                        self.assertNotEqual(result.returncode, 0)

    def test_rollback_restores_files_and_service_state(self):
        restore = SOURCE[SOURCE.index('restore_caddy_install() {'):SOURCE.index('cleanup_caddy_install() {')]
        for active, enabled, had_autosave, stop_fails in (
            (True, True, True, False), (False, False, False, False),
            (True, False, True, False), (True, True, True, True),
        ):
            with self.subTest(active=active, enabled=enabled, had_autosave=had_autosave, stop_fails=stop_fails), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                backup = base / 'backup'
                backup.mkdir()
                for name in ('Caddyfile', 'override.conf', 'autosave.json'):
                    (base / name).write_text('new ' + name)
                    if name != 'override.conf' and (name != 'autosave.json' or had_autosave):
                        (backup / name).write_text('old ' + name)
                path = str(base).replace('\\', '/')
                if os.name == 'nt':
                    path = '/' + path[0].lower() + path[2:]
                harness = f'''set -euo pipefail
CADDYFILE='{path}/Caddyfile'
CADDY_OVERRIDE_FILE='{path}/override.conf'
CADDY_AUTOSAVE='{path}/autosave.json'
BACKUP_DIR='{path}/backup'
TRANSACTION_STARTED=true
OLD_SERVICE_ACTIVE={str(active).lower()}
OLD_SERVICE_ENABLED={str(enabled).lower()}
systemctl() {{
 printf '%s\\n' "$*" >> '{path}/service.log'
 [[ "$1" != stop || '{str(stop_fails).lower()}' != true ]]
}}
error() {{ :; }}
{restore}
restore_caddy_install
'''
                result = subprocess.run([BASH, '-s'], input=harness, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1 if stop_fails else 0, result.stderr)
                if stop_fails:
                    self.assertEqual((base / 'Caddyfile').read_text(), 'new Caddyfile')
                else:
                    self.assertEqual((base / 'Caddyfile').read_text(), 'old Caddyfile')
                    self.assertFalse((base / 'override.conf').exists())
                    self.assertEqual((base / 'autosave.json').exists(), had_autosave)
                    if had_autosave:
                        self.assertEqual((base / 'autosave.json').read_text(), 'old autosave.json')
                    calls = (base / 'service.log').read_text().splitlines()
                    self.assertIn('enable caddy' if enabled else 'disable caddy', calls)
                    self.assertEqual('start caddy' in calls, active)
                self.assertTrue((backup / 'Caddyfile').exists())

    def test_switch_failures_restore_autosave_and_configuration(self):
        restore = SOURCE[SOURCE.index('restore_caddy_install() {'):SOURCE.index('cleanup_caddy_install() {')]
        switch = SOURCE[SOURCE.index('SWITCH_OK=true'):SOURCE.index('CADDY_INSTALL_COMPLETE=true')]
        for failure in ('daemon-reload', 'enable', 'restart', 'listener', 'api'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                (base / 'backup').mkdir()
                for name in ('Caddyfile', 'override.conf', 'autosave.json'):
                    (base / name).write_text('old ' + name)
                    (base / 'backup' / name).write_text('old ' + name)
                    (base / (name + '.new')).write_text('new ' + name)
                (base / 'backup' / 'migrated.json').write_text('{"admin":{"listen":"127.0.0.1:2019"}}')
                path = str(base).replace('\\', '/')
                if os.name == 'nt':
                    path = '/' + path[0].lower() + path[2:]
                harness = f'''set -euo pipefail
CADDYFILE='{path}/Caddyfile'
CADDY_OVERRIDE_FILE='{path}/override.conf'
CADDY_AUTOSAVE='{path}/autosave.json'
CADDYFILE_NEW="$CADDYFILE.new"
OVERRIDE_NEW="$CADDY_OVERRIDE_FILE.new"
AUTOSAVE_NEW="$CADDY_AUTOSAVE.new"
BACKUP_DIR='{path}/backup'
CADDY_ADMIN_ADDRESS=127.0.0.1:2019
TRANSACTION_STARTED=true
HAD_OLD_AUTOSAVE=true
OLD_SERVICE_ACTIVE=true
OLD_SERVICE_ENABLED=false
ROLLBACK_HANDLED=false
systemctl() {{
 printf '%s\\n' "$*" >> '{path}/service.log'
 if [[ "$1" == '{failure}' ]]; then return 1; fi
 if [[ "$1" == show ]]; then printf '%s' "$$"; fi
}}
sleep() {{ :; }}
id() {{ printf 123; }}
stat() {{ printf 123; }}
ss() {{
 if [[ '{failure}' == listener ]]; then return 1; fi
 printf 'LISTEN 0 128 127.0.0.1:2019 0.0.0.0:* users:(("caddy",pid=%s,fd=3))\\n' "$$"
}}
curl() {{ return 1; }}
error() {{ :; }}
{restore}
{switch}
'''
                result = subprocess.run([BASH, '-s'], input=harness, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                for name in ('Caddyfile', 'override.conf', 'autosave.json'):
                    self.assertEqual((base / name).read_text(), 'old ' + name)
                    self.assertEqual((base / 'backup' / name).read_text(), 'old ' + name)
                calls = (base / 'service.log').read_text().splitlines()
                self.assertIn('stop caddy', calls)
                self.assertIn('disable caddy', calls)
                if failure != 'daemon-reload':
                    self.assertIn('start caddy', calls)

    def test_incus_preseed_never_opens_listener_and_preserves_existing(self):
        function = HOST[HOST.index('init_incus() {'):HOST.index('import_cert() {')]
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as directory:
                path = str(Path(directory) / 'preseed').replace('\\', '/')
                if os.name == 'nt':
                    path = '/' + path[0].lower() + path[2:]
                harness = f'''set -euo pipefail
{function}
step() {{ :; }}
info() {{ :; }}
log() {{ :; }}
warn() {{ printf '%s\\n' "$*"; }}
ensure_incus_storage() {{ :; }}
BRIDGE_NAME=incusbr0 BRIDGE_SUBNET=10.0.0.1/24 MODE=nat IS_PURE_IPV6=false
PRESEED_FILE='{path}'
incus() {{
 case "$*" in
 'network show '*) return {0 if existing else 1} ;;
 'admin init --preseed') input=$(cat); [[ "$input" != *core.https_address* ]] || exit 91; printf preseed ;;
 'config get core.https_address') printf '{'[::]:8443' if existing else ''}' ;;
 *) printf 'unexpected mutation: %s' "$*" >&2; exit 92 ;;
 esac
}}
init_incus
'''
                result = subprocess.run([BASH, '--noprofile', '--norc', '-s'], input=harness, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('既有 Incus HTTPS listener' if existing else 'preseed', result.stdout)


if __name__ == '__main__':
    unittest.main()
