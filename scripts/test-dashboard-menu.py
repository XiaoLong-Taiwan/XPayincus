import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import unittest


SPEC = importlib.util.spec_from_file_location('manage_tests', Path(__file__).with_name('test-manage-menu.py'))
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)
SOURCE = SUPPORT.ROOT / 'scripts/dashboard.sh'
RAW = SUPPORT.RAW


class DashboardTests(unittest.TestCase):
    tool = SUPPORT.ManageMenuTests.tool
    calls = SUPPORT.ManageMenuTests.calls
    fetcher = SUPPORT.ManageMenuTests.fetcher

    def setUp(self):
        SUPPORT.ManageMenuTests.setUp(self)
        self.entry.write_text(SOURCE.read_text(encoding='utf-8'), encoding='utf-8', newline='\n')
        self.env['CHILD_SCRIPT'] = 'printf "cwd:%s\\narg:%s\\n" "$PWD" "$*" >>"$CALLS"\nexit "$CHILD_STATUS"\n'

    def run_entry(self, *args, substitution=False):
        command = [SUPPORT.BASH, '-c', 'cd -- "$TEST_CWD"; bash "$1" "${@:2}"',
                   'dashboard-test', SUPPORT.shell_path(self.entry), *args]
        if substitution:
            command = [SUPPORT.BASH, '-c', 'cd -- "$TEST_CWD"; bash <(/usr/bin/cat "$1") "${@:2}"',
                       'dashboard-test', SUPPORT.shell_path(self.entry), *args]
        self.env['TEST_CWD'] = SUPPORT.shell_path(self.base)
        result = subprocess.run(command, input='', capture_output=True, text=True, encoding='utf-8',
                                env=self.env, cwd=self.base, timeout=20)
        self.assertEqual(list(self.scratch.iterdir()), [], result.stderr)
        self.assertNotIn('forbidden:', self.calls())
        return result

    def host_fixture(self, answer='INSTALL\n'):
        self.tool('id', 'printf "0\\n"\n')
        self.tool('uname', 'case "$1" in -s) printf "Linux\\n" ;; -m) printf "x86_64\\n" ;; esac\n')
        terminal = self.base / 'terminal'
        terminal.write_text(answer, encoding='utf-8', newline='\n')
        self.env['MOCK_TTY'] = SUPPORT.shell_path(terminal)
        text = self.entry.read_text(encoding='utf-8')
        text = text.replace('exec 9<>/dev/tty', 'exec 9<"$MOCK_TTY"').replace('>&9', '>&2')
        text = text.replace('/opt/incudal', '"$TEST_CWD/installed"')
        self.entry.write_text(text, encoding='utf-8', newline='\n')
        python_path = SUPPORT.shell_path(sys.executable)
        if os.name == 'nt':
            self.tool('python3', f'''args=()
for arg in "$@"; do
  if [[ "$arg" == /* ]]; then arg="$(/usr/bin/cygpath -w "$arg")"; fi
  args+=("$arg")
done
exec '{python_path}' "${{args[@]}}"
''')
        else:
            self.tool('python3', f'exec "{python_path}" "$@"\n')
        self.payload = self.base / 'payload'
        self.payload.mkdir()
        self.version = 'v1.0.8'
        self.artifact = f'xpayincus-panel-{self.version}-linux-amd64.tar.gz'
        assets = [{'name': name} for name in (self.artifact, self.artifact + '.sha256')]
        self.metadata = {'tag_name': self.version, 'draft': False, 'prerelease': False, 'assets': assets}
        self.save_metadata()
        self.make_archive()
        actual = (SUPPORT.ROOT / 'XPayincus/scripts/install-panel.sh').read_text(encoding='utf-8')
        main = actual.index('\nmain() {\n')
        actual = actual[:main] + '''
main() {
    printf 'installer:%s\\n' "$PWD" >>"$CALLS"
    package="$(obtain_release)"
    printf 'package:%s\\n' "$package" >>"$CALLS"
    exit "$CHILD_STATUS"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
'''
        (self.payload / 'installer').write_text(actual, encoding='utf-8', newline='\n')
        self.env['PAYLOAD'] = SUPPORT.shell_path(self.payload)
        self.tool('curl', '''printf 'fetch:%s\n' "$@" >>"$CALLS"
while (($#)); do
  case "$1" in -o) target="$2"; shift 2 ;; *) url="$1"; shift ;; esac
done
case "$url" in
  */releases/latest) item=metadata ;;
  *.tar.gz.sha256) item=checksum ;;
  *.tar.gz) item=archive ;;
  */install-panel.sh) item=installer ;;
  */download.sh) printf '%s' "$CHILD_SCRIPT" >"$target"; exit 0 ;;
  *) exit 99 ;;
esac
/usr/bin/cp "$PAYLOAD/$item" "$target"
''')

    def save_metadata(self):
        (self.payload / 'metadata').write_text(json.dumps(self.metadata), encoding='utf-8')

    def make_archive(self, extra=None, version='v1.0.8'):
        with tarfile.open(self.payload / 'archive', 'w:gz') as bundle:
            for name, content in {
                'version.json': json.dumps({'version': version}).encode(),
                'server/dist/app.js': b'fixture',
                'deploy/incudal-online-task.sh.example': b'fixture',
                'deploy/incudal-systemctl-wrapper.sh.example': b'fixture',
                'deploy/incudal-ota-chown-wrapper.sh.example': b'fixture',
            }.items():
                member = tarfile.TarInfo('./' + name)
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))
            if extra:
                bundle.addfile(extra, io.BytesIO(b'x') if extra.isfile() else None)
        digest = hashlib.sha256((self.payload / 'archive').read_bytes()).hexdigest()
        (self.payload / 'checksum').write_text(digest + '  ' + self.artifact + '\n', encoding='utf-8', newline='\n')

    def test_process_substitution_preserves_cwd_and_arguments(self):
        result = self.run_entry('menu', '/srv/panel space', substitution=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('cwd:' + SUPPORT.shell_path(self.base), self.calls())
        self.assertIn('arg:menu /srv/panel space', self.calls())
        self.assertIn(RAW + 'XPayincus/deploy/compose/download.sh', self.calls())

    def deployment_fixture(self):
        self.env['CHILD_SCRIPT'] = (SUPPORT.ROOT / 'XPayincus/deploy/compose/download.sh').read_text(encoding='utf-8')
        python_path = SUPPORT.shell_path(sys.executable)
        self.tool('python3', f'exec "{python_path}" "$@"\n')
        self.deployment = self.base / "panel space's $HOME; deployment"
        self.deployment.mkdir()
        self.directory = SUPPORT.shell_path(self.deployment)
        # Native Windows Python needs its own absolute path syntax for inspection.
        if os.name == 'nt':
            self.directory = self.deployment.as_posix()
        (self.deployment / 'panel.sh').write_text(
            '# incudal-panel\ncommand_name="${1:-help}"\n'
            'printf "panel:%s\\n" "$@" >>"$CALLS"\nexit "$CHILD_STATUS"\n',
            encoding='utf-8', newline='\n')
        (self.deployment / 'compose.yaml').write_text('services:\n  api:\n  user:\n  admin:\n', encoding='utf-8')
        (self.deployment / '.env').write_text('private fixture', encoding='utf-8')

    def test_existing_deployment_routes_preserve_arguments_and_exit_status(self):
        self.deployment_fixture()
        for args, expected in [
                (['update'], ['update']), (['update-plan'], ['update-plan']),
                (['doctor'], ['doctor']), (['doctor', '--json'], ['doctor', '--json']),
                (['recover'], ['recover']), (['recover', '--json'], ['recover', '--json']),
                (['recover', '--retry-preflight'], ['recover', '--retry-preflight']),
                (['recover', '--resume-up'], ['recover', '--resume-up']),
                (['force-recreate'], ['up', 'pull', '--force-recreate'])]:
            with self.subTest(args=args):
                self.log.unlink(missing_ok=True)
                self.env['CHILD_STATUS'] = '37'
                result = self.run_entry(args[0], self.directory, *args[1:])
                self.assertEqual(result.returncode, 37, result.stderr)
                calls = self.calls()
                self.assertEqual([line for line in calls.splitlines() if line.startswith('panel:')],
                                 ['panel:' + arg for arg in expected])
                self.assertEqual(calls.count(RAW + 'XPayincus/deploy/compose/download.sh'), 1)
        self.assertEqual((self.deployment / '.env').read_text(), 'private fixture')
        self.assertFalse((self.deployment / '.state').exists())
        self.assertFalse((self.deployment / '.bootstrap').exists())

    def test_readonly_diagnostics_work_without_env_or_docker(self):
        self.deployment_fixture()
        (self.deployment / '.env').unlink()
        for command in ['doctor', 'recover']:
            result = self.run_entry(command, self.directory, '--json')
            self.assertEqual(result.returncode, 0, result.stderr)
        self.log.unlink()
        result = self.run_entry('update', self.directory)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('panel:', self.calls())

    def test_invalid_routes_and_untrusted_deployment_never_execute_panel(self):
        self.deployment_fixture()
        for args in [('doctor', '--resume-up'), ('recover', '--force'),
                     ('recover', '--resume-up', '--json'), ('update-plan', 'extra'),
                     ('force-recreate', 'extra'), ('update', 'latest')]:
            with self.subTest(args=args):
                result = self.run_entry(args[0], self.directory, *args[1:])
                self.assertEqual(result.returncode, 2, result.stderr)
        (self.deployment / 'panel.sh').write_text('exit 0\n', encoding='utf-8')
        result = self.run_entry('doctor', self.directory)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('panel:', self.calls())

    @unittest.skipIf(os.name == 'nt', 'POSIX directory permissions require Linux')
    def test_parent_chain_permissions_and_sticky_directories(self):
        self.deployment_fixture()
        outer = self.base / 'outer'
        inner = outer / 'inner'
        inner.mkdir(parents=True)
        relocated = inner / self.deployment.name
        self.deployment.rename(relocated)
        self.deployment = relocated
        self.directory = SUPPORT.shell_path(relocated)
        for directory, mode, accepted in [
                (outer, 0o777, False), (outer, 0o775, False),
                (outer, 0o1777, True), (inner, 0o1777, True),
                (self.deployment, 0o1777, False)]:
            with self.subTest(directory=directory, mode=oct(mode)):
                original = directory.stat().st_mode & 0o7777
                try:
                    directory.chmod(mode)
                    self.log.unlink(missing_ok=True)
                    result = self.run_entry('doctor', self.directory)
                    self.assertEqual(result.returncode == 0, accepted, result.stderr)
                    self.assertEqual('panel:' in self.calls(), accepted)
                finally:
                    directory.chmod(original)

    @unittest.skipIf(os.name == 'nt', 'POSIX symlinks and directory permissions require Linux')
    def test_symlink_parent_target_chain_is_checked(self):
        self.deployment_fixture()
        target = self.base / 'target'
        target.mkdir()
        relocated = target / self.deployment.name
        self.deployment.rename(relocated)
        alias = self.base / 'alias'
        alias.symlink_to(target, target_is_directory=True)
        self.directory = (alias / self.deployment.name).as_posix()
        target.chmod(0o777)
        result = self.run_entry('doctor', self.directory)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('panel:', self.calls())
        target.chmod(0o700)
        result = self.run_entry('doctor', self.directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        lexical_parent = self.base / 'lexical parent'
        lexical_parent.mkdir()
        (lexical_parent / 'alias').symlink_to(target, target_is_directory=True)
        self.directory = (lexical_parent / 'alias' / self.deployment.name).as_posix()
        lexical_parent.chmod(0o777)
        self.log.unlink(missing_ok=True)
        result = self.run_entry('doctor', self.directory)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('panel:', self.calls())

    @unittest.skipIf(os.name == 'nt' or not hasattr(os, 'geteuid'), 'POSIX ownership requires Linux')
    def test_sticky_parent_with_untrusted_owner_is_rejected(self):
        if os.geteuid() != 0:
            self.skipTest('Changing fixture ownership requires root')
        self.deployment_fixture()
        parent = self.base / 'untrusted'
        parent.mkdir()
        relocated = parent / self.deployment.name
        self.deployment.rename(relocated)
        self.directory = SUPPORT.shell_path(relocated)
        parent.chmod(0o1777)
        try:
            os.chown(parent, 65534, -1)
            result = self.run_entry('doctor', self.directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('panel:', self.calls())
        finally:
            os.chown(parent, 0, -1)
            parent.chmod(0o700)

    def test_wget_and_download_failure(self):
        (self.bin / 'curl').unlink()
        SUPPORT.ManageMenuTests.fetcher(self, 'wget')
        self.assertEqual(self.run_entry('menu').returncode, 0)
        self.env['FETCH_STATUS'] = '8'
        result = self.run_entry('menu')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('HTTPS 下載失敗', result.stderr)

    def test_non_host_failure_preserved(self):
        self.env['CHILD_STATUS'] = '37'
        self.assertEqual(self.run_entry('menu').returncode, 37)
        self.env['CHILD_STATUS'] = '20'
        self.assertEqual(self.run_entry('install', '/srv/panel', 'latest').returncode, 20)

    def test_host_handoff_does_not_loop(self):
        self.host_fixture(answer='no\n')
        self.env['CHILD_STATUS'] = '20'
        result = self.run_entry(substitution=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls().count(RAW + 'XPayincus/deploy/compose/download.sh'), 1)
        self.assertNotIn('/releases/latest', self.calls())

    def test_host_runs_pinned_verified_artifact_with_official_installer(self):
        self.host_fixture()
        result = self.run_entry('--host-install')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('installer:' + SUPPORT.shell_path(self.base), self.calls())
        self.assertIn(self.artifact, self.calls())
        self.assertIn('/v1.0.8/XPayincus/scripts/install-panel.sh', self.calls())
        self.assertNotIn('/main/XPayincus/scripts/install-panel.sh', self.calls())
        self.assertIn('SHA256', result.stderr)

    def test_host_installer_failure_preserved(self):
        self.host_fixture()
        self.env['CHILD_STATUS'] = '43'
        result = self.run_entry('--host-install')
        self.assertEqual(result.returncode, 43, result.stderr)

    def test_prerelease_missing_asset_and_wrong_version_rejected(self):
        self.host_fixture()
        self.metadata['prerelease'] = True
        self.save_metadata()
        self.assertNotEqual(self.run_entry('--host-install').returncode, 0)
        self.metadata['prerelease'] = False
        self.metadata['assets'] = []
        self.save_metadata()
        self.assertNotEqual(self.run_entry('--host-install').returncode, 0)
        self.assertNotIn('installer:', self.calls())

    def test_checksum_mismatch_rejected(self):
        self.host_fixture()
        (self.payload / 'checksum').write_text('0' * 64, encoding='utf-8')
        result = self.run_entry('--host-install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA256 校驗失敗', result.stderr)
        self.assertNotIn('installer:', self.calls())

    def test_unsafe_archives_and_wrong_version_rejected(self):
        self.host_fixture()
        for name, kind, link in [('../escape', tarfile.REGTYPE, ''),
                                 ('link', tarfile.SYMTYPE, '../../escape'),
                                 ('device', tarfile.CHRTYPE, ''),
                                 ('cycle', tarfile.SYMTYPE, 'cycle'),
                                 ('version.json', tarfile.REGTYPE, '')]:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = link
                member.size = 1 if member.isfile() else 0
                self.make_archive(member)
                self.assertNotEqual(self.run_entry('--host-install').returncode, 0)
        self.make_archive(version='v9.9.9')
        self.assertNotEqual(self.run_entry('--host-install').returncode, 0)
        self.assertNotIn('installer:', self.calls())

    def test_safe_relative_package_link_is_supported(self):
        self.host_fixture()
        member = tarfile.TarInfo('server/node_modules/.bin/tool')
        member.type = tarfile.SYMTYPE
        member.linkname = '../tool/bin.js'
        self.make_archive(member)
        result = self.run_entry('--host-install')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_signal_cleans_private_temp(self):
        self.env['CHILD_SCRIPT'] = 'kill -TERM "$PPID"\nexit 0\n'
        self.assertEqual(self.run_entry('menu').returncode, 143)

    def test_unsupported_installer_rejected(self):
        self.host_fixture()
        (self.payload / 'installer').write_text('exit 0\n', encoding='utf-8')
        result = self.run_entry('--host-install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('相容性', result.stderr)

    def test_host_requires_root(self):
        self.tool('id', 'printf "1000\\n"\n')
        result = self.run_entry('--host-install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('root', result.stderr)
        self.assertEqual(self.calls(), '')

    def test_existing_installation_rejected(self):
        self.host_fixture()
        (self.base / 'installed').mkdir()
        result = self.run_entry('--host-install')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('fetch:', self.calls())

    def test_help_without_download_and_syntax(self):
        for option in ['--help', '-h', 'help']:
            result = self.run_entry(option)
            self.assertEqual(result.returncode, 0, result.stderr)
            for command in ['update DIRECTORY', 'update-plan DIRECTORY', 'doctor DIRECTORY',
                            'recover DIRECTORY', 'force-recreate DIRECTORY', '--retry-preflight', '--resume-up']:
                self.assertIn(command, result.stdout)
        self.assertEqual(self.calls(), '')
        result = subprocess.run([SUPPORT.BASH, '-n', SUPPORT.shell_path(SOURCE)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
