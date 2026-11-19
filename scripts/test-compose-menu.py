from contextlib import redirect_stderr, redirect_stdout
import io
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
        check_function = ('deployment_check() {\n' + SOURCE.split('deployment_check() {\n', 1)[1].split('\n}\ndeployment_command', 1)[0] + '\n}'
                          if check is None else 'deployment_check() { ' + check + '; }')
        inspection_python = 'python3() { python - "$(cygpath -w "$2")" "$3"; }\n' if check is None and os.name == 'nt' else ''
        script = 'set -Eeuo pipefail\n' + bash_prelude + 'self=fixture\ndocker() { printf "DOCKER <%s>\\n" "$*"; }\ndocker_check() { return 0; }\n' + check_function + '\nbash() { printf "CALL <%s>\\n" "$*"; }\n' + extra + '\n' + move_function + '\nmove_deployment() { ' + move_body + '; }\n' + inspection_python + 'dashboard_menu() {\n' + code + '\n}\ndashboard_menu ' + directory_arg
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

    def deployment_fixture(self):
        deployment = self.base / "panel space's $HOME; fixture"
        deployment.mkdir()
        for name in ('panel.sh', 'compose.yaml', 'docker-compose.yml'):
            shutil.copyfile(COMPOSE / name, deployment / name)
        return deployment

    def inspect(self, deployment, mode='configured', expected=None):
        code = SOURCE.split("<<'DEPLOYMENT_PY'\n", 1)[1].split('\nDEPLOYMENT_PY\n', 1)[0]
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', ['check', str(deployment), mode]), redirect_stdout(output), redirect_stderr(errors):
            try:
                exec(compile(code, 'deployment-check', 'exec'), {})
            except SystemExit as error:
                self.assertEqual(error.code, 1)
                self.assertIsNotNone(expected, errors.getvalue())
            else:
                self.assertIsNone(expected, '不安全部署被接受')
        if expected:
            self.assertIn(expected, errors.getvalue())
        self.assertNotIn('Traceback', errors.getvalue())
        return output.getvalue(), errors.getvalue()

    def test_readonly_menu_uses_real_inspection_without_env_or_panel_execution(self):
        deployment = self.deployment_fixture()
        before = {p.name: p.read_bytes() for p in deployment.iterdir()}
        result = self.menu('10\n0\n', check=None, directory=deployment.as_posix(),
                           extra='docker_check() { printf "DOCKER CHECK\\n"; return 1; }')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertIn('缺少 .env'.encode(), result.stderr)
        self.assertNotIn(b'CALL', result.stdout + result.stderr)
        self.assertNotIn(b'DOCKER CHECK', result.stdout + result.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in deployment.iterdir()}, before)

    def test_configured_menu_actions_remain_blocked_without_env(self):
        deployment = self.deployment_fixture()
        for choice in (2, 4, 5, 6, 7, 8, 9):
            with self.subTest(choice=choice):
                result = self.menu(f'{choice}\n\n0\n', check=None, directory=deployment.as_posix())
                self.assertEqual(result.returncode, 0, process_output(result))
                self.assertIn('缺少 .env'.encode(), result.stderr)
                self.assertNotIn(b'CALL', result.stdout + result.stderr)
        self.assertFalse((deployment / '.state').exists())
        self.assertFalse((deployment / '.bootstrap').exists())

    def test_status_reports_incomplete_setup_without_prompting_or_running_panel(self):
        deployment = self.deployment_fixture()
        for content, message in [(None, '缺少 .env'), ('', '.env 是空檔案')]:
            with self.subTest(content=content):
                if content is not None:
                    (deployment / '.env').write_text(content)
                result = self.menu('1\n0\n', check=None, directory=deployment.as_posix(),
                                   extra='docker_check() { printf "DOCKER CHECK\\n"; return 1; }')
                self.assertEqual(result.returncode, 0, process_output(result))
                self.assertIn(message.encode(), result.stderr)
                self.assertIn('目前僅能檢查部署檔案'.encode(), result.stderr)
                self.assertNotIn('請輸入既有部署絕對路徑'.encode(), result.stderr)
                self.assertNotIn(b'CALL', result.stdout + result.stderr)
                self.assertNotIn(b'DOCKER CHECK', result.stdout + result.stderr)

    def test_inspection_reports_env_missing_empty_and_never_prints_values(self):
        deployment = self.deployment_fixture()
        for content, issue in [(None, '缺少 .env'), ('', '.env 是空檔案')]:
            if content is not None:
                (deployment / '.env').write_text(content)
            self.inspect(deployment, expected=issue)
            output, _ = self.inspect(deployment, 'inspect')
            self.assertIn(issue, output)
            self.inspect(deployment, 'prepared')
        (deployment / '.env').write_text('PRIVATE_VALUE=never-display-this')
        output, errors = self.inspect(deployment, 'inspect')
        self.assertNotIn('never-display-this', output + errors)
        self.inspect(deployment)

    def test_inspection_diagnostics_cover_structure_paths_and_encoding(self):
        self.inspect(Path('relative'), expected='絕對路徑')
        self.inspect(self.base / 'absent', expected='路徑不存在')
        deployment = self.deployment_fixture()
        (deployment / '.env').write_text('fixture')
        for name, content, message in [('panel.sh', b'', '檔案為空'),
                                       ('panel.sh', b'exit 0', '面板入口結構'),
                                       ('compose.yaml', b'services:\n', '缺少預期'),
                                       ('compose.yaml', b'\xff', 'UTF-8')]:
            with self.subTest(name=name, content=content):
                original = (deployment / name).read_bytes()
                (deployment / name).write_bytes(content)
                self.inspect(deployment, expected=message)
                (deployment / name).write_bytes(original)
        for name in ('docker-compose.yml', 'compose.release.yaml'):
            with self.subTest(name=name):
                (deployment / name).write_bytes(b'')
                self.inspect(deployment, 'prepared', expected='檔案為空')
                (deployment / name).unlink()

    @unittest.skipIf(os.name == 'nt', 'POSIX 權限與連結測試需要 Linux')
    def test_inspection_accepts_permissions_and_preserves_link_boundaries(self):
        deployment = self.deployment_fixture()
        (deployment / '.env').write_text('fixture')
        for path in [deployment, deployment / 'panel.sh', deployment / '.env', self.base]:
            original = path.stat().st_mode & 0o7777
            try:
                for mode in (0o775, 0o777):
                    path.chmod(mode)
                    self.inspect(deployment, 'inspect')
                    self.inspect(deployment)
                if path.is_dir():
                    path.chmod(0o1777)
                    self.inspect(deployment, 'inspect')
            finally:
                path.chmod(original)
        link = deployment / 'panel.sh'
        release = deployment / '.bootstrap/releases/v1'
        release.mkdir(parents=True)
        link.rename(release / 'panel.sh')
        (deployment / '.bootstrap/current').symlink_to('releases/v1', target_is_directory=True)
        link.symlink_to('.bootstrap/current/panel.sh')
        self.inspect(deployment)
        for target, message in [('missing', '目標不存在'), ('panel.sh', '循環'),
                                ('../outside-panel.sh', '部署目錄外')]:
            link.unlink()
            (self.base / 'outside-panel.sh').write_text('fixture')
            link.symlink_to(target)
            self.inspect(deployment, 'inspect', expected=message)
        link.unlink()
        link.symlink_to('.bootstrap/current/panel.sh')
        alias = self.base / 'alias'
        alias.symlink_to(deployment, target_is_directory=True)
        self.inspect(alias, 'inspect', expected='根目錄不可為符號連結')

    @unittest.skipIf(os.name == 'nt', 'POSIX 連結及權限測試需要 Linux')
    def test_intermediate_links_accept_permissions_and_foreign_owned_directories(self):
        deployment = self.deployment_fixture()
        (deployment / '.env').write_text('fixture')
        release = deployment / '.bootstrap/releases/v1'
        release.mkdir(parents=True)
        (deployment / 'panel.sh').rename(release / 'panel.sh')
        hop = deployment / 'hop'
        hop.mkdir()
        (hop / 'next').symlink_to('../.bootstrap/releases/v1', target_is_directory=True)
        (deployment / 'panel.sh').symlink_to('hop/next/panel.sh')
        self.inspect(deployment)
        hop.chmod(0o777)
        self.inspect(deployment, 'inspect')
        self.inspect(deployment)
        hop.chmod(0o700)
        if os.geteuid() == 0:
            try:
                os.chown(hop, 65532, -1)
                self.inspect(deployment, 'inspect')
                self.inspect(deployment)
            finally:
                os.chown(hop, 0, -1)

    def test_legacy_deployment_structures_remain_inspectable(self):
        deployment = self.deployment_fixture()
        (deployment / 'panel.sh').write_text('command_name="${1:-help}"\ncompose=(docker compose --project-name incudal-panel)\n')
        (deployment / 'docker-compose.yml').unlink()
        self.inspect(deployment, 'inspect')
        (deployment / 'docker-compose.yml').write_text('include:\n  - compose.yaml\n')
        self.inspect(deployment, 'inspect')
        (deployment / 'compose.release.yaml').write_text('services:\n  api:\n    image: fixture\n')
        self.inspect(deployment, 'inspect')

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

    def test_update_failure_explains_recovery_conditions_and_menu_exit(self):
        result = self.menu('2\nyes\n0\n', extra='bash() { printf "CALL <%s>\\n" "$*"; return 1; }')
        self.assertEqual(result.returncode, 0, process_output(result))
        self.assertEqual(result.stdout.count(b'CALL'), 1)
        self.assertIn(b'panel.sh update', result.stdout)
        for text in ('保留 journal 與備份', '[0] 退出腳本', 'shell', '完整命令', 'backupComplete=false',
                     '備份完整', '目標版本', 'secrets 與 schema 相容', '不自動回滾資料庫'):
            self.assertIn(text.encode(), result.stderr)
        self.assertNotIn(b'panel.sh recover', result.stdout)

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
