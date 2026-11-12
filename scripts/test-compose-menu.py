import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / 'XPayincus/deploy/compose'
BASH = os.environ.get('BOOTSTRAP_TEST_BASH') or os.environ.get('BASH_EXE') or shutil.which('bash') or 'bash'
if os.name == 'nt' and Path('C:/Program Files/Git/bin/bash.exe').is_file():
    BASH = os.environ.get('BOOTSTRAP_TEST_BASH') or os.environ.get('BASH_EXE') or 'C:/Program Files/Git/bin/bash.exe'
SOURCE = (COMPOSE / 'download.sh').read_text(encoding='utf-8')
HAS_FLOCK = subprocess.run([BASH, '-lc', 'command -v flock >/dev/null'], capture_output=True).returncode == 0


def process_output(result):
    def decode(value):
        return value.decode('utf-16-le' if b'\x00' in value else 'utf-8', errors='replace')
    return f'Bash: {BASH}\nexit: {result.returncode}\nstdout: {decode(result.stdout)}\nstderr: {decode(result.stderr)}'


class MenuTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def menu(self, data, check='return 0', directory=None, extra='', move_body='move_deployment_impl "$@"'):
        code = SOURCE.split('dashboard_menu() {\n', 1)[1].split('\n}\ncase ', 1)[0]
        code = '\n'.join(line for line in code.splitlines() if 'exec 8<>/dev/tty' not in line)
        code = code.replace('<&8', '').replace('>&8', '>&2')
        move_function = 'move_deployment_impl() {\n' + SOURCE.split('move_deployment() {\n', 1)[1].split('\n}\ndashboard_menu', 1)[0] + '\n}'
        bash_prelude = "python3() { if [[ \"$1\" == - ]]; then python - \"$(cygpath -w \"$2\")\" \"$(cygpath -w \"$3\")\"; elif [[ \"$1\" == -c ]]; then python -c \"$2\" \"$(cygpath -w \"$3\")\" \"$(cygpath -w \"$4\")\"; else python \"$@\"; fi; }\n" if os.name == 'nt' else ''
        directory_arg = '"$1"'
        code = code.replace('move_deployment "$source_real" "$destination"', 'move_deployment_impl "$source_real" "$destination"')
        script = 'set -Eeuo pipefail\n' + bash_prelude + 'self=fixture\ndocker() { printf "DOCKER <%s>\\n" "$*"; }\ndocker_check() { return 0; }\ndeployment_check() { ' + check + '; }\nbash() { printf "CALL <%s>\\n" "$*"; }\n' + extra + '\n' + move_function + '\nmove_deployment() { ' + move_body + '; }\ndashboard_menu() {\n' + code + '\n}\ndashboard_menu ' + directory_arg
        fixture = self.base / 'menu-fixture.sh'
        fixture.write_text(script, encoding='utf-8', newline='\n')
        bash_fixture = str(fixture)
        if os.name == 'nt':
            bash_fixture = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', bash_fixture],
                                          check=True, capture_output=True, text=True).stdout.strip()
        directory_arg = directory or self.base.as_posix()
        if os.name == 'nt':
            directory_arg = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', directory_arg],
                                           check=True, capture_output=True, text=True).stdout.strip()
        args = [BASH, bash_fixture, directory_arg]
        result = subprocess.run(args, input=data.encode(), cwd=self.base, capture_output=True,
                                env=dict(os.environ, MOVE_DESTINATION=str(self.base / 'new'),
                                         SOURCE_DIRECTORY=str(self.base / 'old')))
        fixture.unlink(missing_ok=True)
        return result

    def test_default_uses_launch_directory_and_exit_preserves_cwd(self):
        before = Path.cwd()
        result = self.menu('0\n')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertIn(self.base.name.encode(), result.stderr)
        self.assertEqual(Path.cwd(), before)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_host_handoff_is_nonrecursive(self):
        result = self.menu('3\n2\n')
        self.assertEqual(result.returncode, 20, process_output(result))
        self.assertNotIn(b'CALL', result.stdout)
        self.assertIn(b'--host-install', result.stderr)

    def test_entry_dispatch_preserves_host_handoff_status(self):
        terminal = self.base / 'terminal'
        terminal.write_text('3\n2\n', encoding='utf-8', newline='\n')
        entry = self.base / 'download.sh'
        entry.write_text(SOURCE.replace('exec 8<>/dev/tty', 'exec 8<"$FIXTURE_TTY"').replace('>&8', '>&2'),
                         encoding='utf-8', newline='\n')
        result = subprocess.run([BASH, str(entry), 'menu'],
                                env=dict(os.environ, FIXTURE_TTY=str(terminal)), capture_output=True)
        self.assertEqual(result.returncode, 20, process_output(result))

    def test_install_compose_is_confirmed_then_wizard(self):
        result = self.menu('3\n1\n/srv/fixture-new\nyes\n0\n')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertIn(b'install /srv/fixture-new latest', result.stdout)
        self.assertIn(b'/srv/fixture-new/panel.sh wizard', result.stdout)

    def test_invalid_update_never_creates_or_executes(self):
        result = self.menu('2\n/does-not-exist-fixture\n0\n', check='return 1')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertNotIn(b'CALL', result.stdout)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_trust_refusal_does_not_execute_and_rebuild_requires_confirmation(self):
        result = self.menu('2\nno\n9\nyes\nno\n9\nrebuild\n0\n')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertNotIn(b'panel.sh update', result.stdout)
        self.assertEqual(result.stdout.count(b'up pull --force-recreate'), 1)

    def test_main_menu_actions_and_status_service_menu(self):
        result = self.menu('1\nyes\n0\n2\n4\n5\n/backup/panel.dump\nno\n6\n7\n9\nno\n0\n')
        self.assertEqual(result.returncode, 0, process_output(result))
        for label in [b'[1]', b'[2]', b'[3]', b'[4]', b'[5]', b'[6]', b'[7]', b'[8]', b'[9]', b'[0]']:
            self.assertIn(label, result.stderr)
        self.assertIn(b'[4] ', result.stderr)
        self.assertIn(b'panel.sh status', result.stdout)
        self.assertIn(b'panel.sh update', result.stdout)
        self.assertIn(b'panel.sh pull', result.stdout)
        self.assertIn(b'panel.sh logs', result.stdout)
        self.assertIn(b'panel.sh export', result.stdout)
        self.assertNotIn(b'panel.sh import', result.stdout)

    @unittest.skipUnless(HAS_FLOCK, '平台未提供 flock，不能驗證搬移鎖')
    def test_move_preserves_complete_directory_and_orders_operations(self):
        move_root = Path(__file__).resolve().parent / 'menu-move-fixture'
        source = move_root / 'old panel'
        move_root.mkdir(exist_ok=True)
        self.addCleanup(shutil.rmtree, move_root, ignore_errors=True)
        source.mkdir()
        (source / '.env').write_text('COMPOSE_PROFILES=\n')
        (source / 'data').mkdir()
        (source / 'data/database').write_bytes(b'private fixture')
        (source / 'panel.sh').write_text('fixture')
        destination = move_root / 'new panel'
        path = destination.as_posix()
        directory = source.as_posix()
        if os.name == 'nt':
            path = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', path],
                                  check=True, capture_output=True, text=True).stdout.strip()
            directory = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', directory],
                                       check=True, capture_output=True, text=True).stdout.strip()
        result = self.menu(f'8\nyes\n{path}\nMOVE\n0\n', directory=directory,
                           extra='bash() { printf "CALL <%s>\\n" "$*"; }',
                           move_body='move_deployment_impl "$@"')
        self.assertEqual(result.returncode, 0, process_output(result))
        moved = move_root / 'new panel'
        self.assertFalse(source.exists(), process_output(result))
        self.assertEqual((moved / 'data/database').read_bytes(), b'private fixture')
        self.assertEqual((moved / 'panel.sh').read_text(), 'fixture')
        calls = result.stderr.decode()
        self.assertLess(calls.index('panel.sh export'), calls.index('panel.sh down'))
        self.assertLess(calls.index('panel.sh down'), calls.index('panel.sh up'))

    def test_move_backup_failure_keeps_source(self):
        source = self.base / 'old'
        source.mkdir()
        destination = self.base / 'new'
        path = destination.as_posix()
        directory = source.as_posix()
        source_for_assertion = source
        if os.name == 'nt':
            path = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', path],
                                  check=True, capture_output=True, text=True).stdout.strip()
            directory = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', directory],
                                       check=True, capture_output=True, text=True).stdout.strip()
        result = self.menu(f'8\nyes\n{path}\nMOVE\n0\n', directory=directory,
                           extra='bash() { printf "CALL <%s>\\n" "$*"; [[ "$2" != export ]]; }',
                           move_body='move_deployment_impl "$@"')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertTrue(source_for_assertion.is_dir())
        self.assertFalse(destination.exists())
        self.assertNotIn(b'panel.sh down', result.stdout)

    @unittest.skipUnless(HAS_FLOCK, '平台未提供 flock，不能驗證搬移鎖')
    def test_move_refuses_destination_created_as_directory(self):
        source = self.base / 'old'
        source.mkdir()
        (source / 'private').write_text('preserve')
        destination = self.base / 'new'
        path = destination.as_posix()
        directory = source.as_posix()
        source_for_assertion = source
        if os.name == 'nt':
            path = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', path],
                                  check=True, capture_output=True, text=True).stdout.strip()
            directory = subprocess.run([BASH, '-lc', 'cygpath -u "$1"', 'fixture', directory],
                                       check=True, capture_output=True, text=True).stdout.strip()
        source_for_assertion = source
        result = self.menu(f'8\nyes\n{path}\nMOVE\n0\n', directory=directory,
                           extra='bash() { printf "CALL <%s>\\n" "$*"; if [[ "$2" == down ]]; then command mkdir -p "$MOVE_DESTINATION"; fi; }')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertTrue(source_for_assertion.exists(), process_output(result))
        self.assertEqual((source_for_assertion / 'private').read_text(), 'preserve')
        self.assertTrue(destination.is_dir())

    def test_force_stop_requires_explicit_confirmation(self):
        result = self.menu('1\nyes\n4\nFORCE-STOP\n0\n', check='return 0')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertIn(b'panel.sh kill', result.stdout)

    def test_deployment_inspection_checks_structure_ownership_and_bootstrap_links(self):
        code = SOURCE.split("<<'DEPLOYMENT_PY'\n", 1)[1].split('\nDEPLOYMENT_PY\n', 1)[0]
        def inspect(success):
            with patch.object(sys, 'argv', ['check', str(self.base), 'configured']):
                if success:
                    exec(compile(code, 'deployment-check', 'exec'), {})
                else:
                    with self.assertRaises(SystemExit):
                        exec(compile(code, 'deployment-check', 'exec'), {})
        inspect(False)
        for name in ['panel.sh', 'compose.yaml', 'docker-compose.yml']:
            shutil.copyfile(COMPOSE / name, self.base / name)
        (self.base / '.env').write_text('private fixture')
        inspect(True)
        (self.base / 'panel.sh').write_text('touch arbitrary-code')
        inspect(False)
        if os.name != 'nt':
            shutil.copyfile(COMPOSE / 'panel.sh', self.base / 'panel.sh')
            (self.base / 'panel.sh').chmod(0o666)
            inspect(False)
            (self.base / 'panel.sh').unlink()
            release = self.base / '.bootstrap/release'
            release.mkdir(parents=True)
            shutil.copyfile(COMPOSE / 'panel.sh', release / 'panel.sh')
            (release / 'panel.sh').chmod(0o600)
            (self.base / 'panel.sh').symlink_to(release / 'panel.sh')
            inspect(True)
            (self.base / 'docker-compose.yml').unlink()
            (self.base / 'docker-compose.yml').symlink_to(self.base / 'missing-compose.yml')
            inspect(False)

    def test_docker_preflight_versions_and_daemon(self):
        code = SOURCE.split('docker_check() {\n', 1)[1].split('\n}\ndeployment_check', 1)[0]
        script = 'set -Eeuo pipefail\ndocker() { if [[ "$1" == compose ]]; then printf "%s\\n" "$FIXTURE_VERSION"; return "$FIXTURE_PLUGIN"; fi; return "$FIXTURE_DAEMON"; }\ndocker_check() {\n' + code + '\n}\ndocker_check'
        for version, plugin, daemon, success in [('2.20.0', '0', '0', True), ('5.5.1', '0', '0', True), ('2.19.9', '0', '0', False), ('invalid', '0', '0', False), ('2.20.0', '1', '0', False), ('2.20.0', '0', '1', False)]:
            with self.subTest(version=version, daemon=daemon):
                result = subprocess.run([BASH, '-c', script], env=dict(os.environ, FIXTURE_VERSION=version, FIXTURE_PLUGIN=plugin, FIXTURE_DAEMON=daemon), capture_output=True)
                self.assertEqual(result.returncode == 0, success, process_output(result))


if __name__ == '__main__':
    unittest.main()
