import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'XPayincus/server/templates/install.sh'
BASH = os.environ.get('BASH_EXE') or ('C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))
URL = 'https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/XPayincus/server/templates/install.sh'


def shell_path(path):
    value = Path(path).resolve().as_posix()
    return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value


class HostShortcutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='host shortcuts ')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.cache = self.base / 'incudal.sh'
        self.cache.write_text('old cache\n', encoding='utf-8')
        self.source = SOURCE.read_text(encoding='utf-8')
        wrapper = self.source.split("<<'SHORTCUT'\n", 1)[1].split('\nSHORTCUT', 1)[0]
        wrapper = wrapper.replace('"/root/incudal.sh"', '"' + shell_path(self.cache) + '"')
        wrapper = wrapper.replace('[[ "$EUID" -eq 0 ]]', '[[ "${TEST_UID:-0}" -eq 0 ]]')
        self.wrapper = self.base / 'wrapper'
        self.wrapper.write_text(wrapper + '\n', encoding='utf-8', newline='\n')
        self.env = dict(os.environ, TEST_BASE=shell_path(self.base), TEST_TOOLS=shell_path(self.bin),
                        PAYLOAD='#!/usr/bin/env bash\nprintf "arg:%s\\n" "$@"\nexit "${CHILD_STATUS:-0}"\n',
                        FETCH_STATUS='0')
        self.tool('curl', 'printf "%s\\n" "$@" > "$TEST_BASE/curl-args"\nwhile (($#)); do case "$1" in -o) target="$2"; shift 2;; *) shift;; esac; done\nprintf "%s" "$PAYLOAD" > "$target"\nexit "$FETCH_STATUS"\n')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/bash\n' + body, encoding='utf-8', newline='\n')
        path.chmod(0o755)

    def run_script(self, path, *args):
        result = subprocess.run([BASH, '-c', 'export PATH="$TEST_TOOLS:$PATH"; exec bash "$@"',
                                 'shortcut-test', shell_path(path), *args], env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(list(self.base.glob('incudal.sh.*')), [], result.stderr)
        return result

    def test_download_preserves_arguments_and_child_status(self):
        self.env['CHILD_STATUS'] = '37'
        result = self.run_script(self.wrapper, '--agent', 'space value', 'literal;$(false)')
        self.assertEqual(result.returncode, 37, result.stderr)
        for arg in ['--agent', 'space value', 'literal;$(false)']:
            self.assertIn('arg:' + arg + '\n', result.stdout)
        args = (self.base / 'curl-args').read_text().splitlines()
        self.assertEqual(args[0], '-q')
        self.assertEqual(args[-1], URL)
        for arg in ['--proto', '--proto-redir', '=https', '--connect-timeout', '--max-time', '--retry']:
            self.assertIn(arg, args)
        self.assertEqual(self.cache.read_text(), self.env['PAYLOAD'])

    def test_http_dns_tls_failure_preserves_cache_without_execution(self):
        for status in ['22', '6', '60', '28']:
            with self.subTest(status=status):
                self.env['FETCH_STATUS'] = status
                result = self.run_script(self.wrapper)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('curl exit=' + status, result.stderr)
                self.assertIn(URL, result.stderr)
                self.assertNotIn('arg:', result.stdout)
                self.assertEqual(self.cache.read_text(), 'old cache\n')

    def test_empty_html_and_invalid_bash_preserve_cache(self):
        for payload in ['', '<html>error</html>\n', '#!/usr/bin/env bash\nif then\n']:
            with self.subTest(payload=payload):
                self.env['PAYLOAD'] = payload
                result = self.run_script(self.wrapper)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.cache.read_text(), 'old cache\n')

    @unittest.skipIf(os.name == 'nt', 'Native symlink semantics require Linux; Git Bash may copy files instead')
    def test_cache_symlink_target_is_not_overwritten(self):
        target = self.base / 'protected'
        target.write_text('protected\n')
        result = subprocess.run([BASH, '-c', 'rm -- "$1"; ln -s "$2" "$1"', 'test',
                                 shell_path(self.cache), shell_path(target)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_script(self.wrapper, '--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_text(), 'protected\n')

    def test_nonroot_stops_before_download(self):
        self.env['TEST_UID'] = '1000'
        result = self.run_script(self.wrapper)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.base / 'curl-args').exists())

    def installer(self):
        function = re.search(r'^install_shortcuts\(\) \([\s\S]*?^\)', self.source, re.M)
        self.assertIsNotNone(function)
        script = function[0].replace('/usr/local/bin', '"' + shell_path(self.bin) + '"')
        path = self.base / 'install-shortcuts'
        path.write_text('warn() { printf "%s\\n" "$*" >&2; }\n' + script + '\ninstall_shortcuts\n',
                        encoding='utf-8', newline='\n')
        self.tool('chown', 'exit 0\n')
        return path

    def test_installs_credential_free_wrapper_and_k_idempotently(self):
        installer = self.installer()
        for _ in range(2):
            result = self.run_script(installer)
            self.assertEqual(result.returncode, 0, result.stderr)
        wrapper = (self.bin / 'incudal').read_text()
        self.assertIn(URL, wrapper)
        for secret in ['INJECT_TOKEN', 'INJECT_AGENT_SECRET', 'INJECT_PANEL_URL']:
            self.assertNotIn(secret, wrapper)
        check = '[[ -L "$1/k" && "$(readlink "$1/k")" == incudal ]]' if os.name != 'nt' else 'cmp "$1/incudal" "$1/k"'
        result = subprocess.run([BASH, '-c', check,
                                 'test', shell_path(self.bin)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipIf(os.name == 'nt', 'Dangling symlink preservation requires Linux')
    def test_existing_dangling_k_is_preserved(self):
        (self.bin / 'k').symlink_to('unrelated-missing-command')
        result = self.run_script(self.installer())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(self.bin / 'k'), 'unrelated-missing-command')
        self.assertIn('已保留既有', result.stderr)

    def test_existing_k_is_preserved(self):
        existing = self.bin / 'k'
        existing.write_text('unrelated command\n')
        result = self.run_script(self.installer())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(existing.read_text(), 'unrelated command\n')
        self.assertIn('已保留既有', result.stderr)

    def test_shortcut_action_precedes_host_detection(self):
        main = self.source[self.source.index('main() {'):]
        self.assertLess(main.index('if [[ "$ACTION" == install_shortcuts ]]'), main.index('\n    detect_system\n'))
        self.assertIn('--install-shortcuts) ACTION="install_shortcuts"; shift ;;', main)
        self.assertIn('    install_shortcuts\n', self.source[self.source.index('show_result() {'):])
        prepare = main.split('if [[ "$ACTION" == prepare_agent_host ]]', 1)[1].split('    # 如果通过命令行指定了卸载', 1)[0]
        self.assertLess(prepare.index('init_incus || return 1'), prepare.index('install_shortcuts || return 1'))
        agent = (ROOT / 'XPayincus/server/templates/agent-install.sh').read_text()
        self.assertIn('bash "${HOST_SCRIPT}" --install-shortcuts || fail', agent)
        result = subprocess.run([BASH, '-n', shell_path(SOURCE)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)


class AgentMenuTests(unittest.TestCase):
    tool = HostShortcutTests.tool

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agent menu ')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.config = self.base / 'config.yaml'
        self.config.write_text('panel_url: "https://panel.example.org"\n', encoding='utf-8')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('INCUDAL_')}
        self.env.update(TEST_BASE=shell_path(self.base), TEST_TOOLS=shell_path(self.bin),
                        INCUDAL_CONFIG_FILE=shell_path(self.config), FETCH_STATUS='0',
                        PAYLOAD='printf "%s\\n" "$@" > "$TEST_BASE/installer-args"\n')
        self.tool('id', 'echo 0\n')
        fetch = ('printf "%s\\n" "$@" > "$TEST_BASE/download-args"\n'
                 'while (($#)); do case "$1" in -o|-O) target="$2"; shift 2;; *) shift;; esac; done\n'
                 'printf "%s" "$target" > "$TEST_BASE/download-target"\n'
                 'printf "%s" "$PAYLOAD" > "$target"\nexit "$FETCH_STATUS"\n')
        self.tool('curl', fetch)
        self.tool('wget', fetch)
        self.tool('systemctl', 'touch "$TEST_BASE/status-called"\n')
        self.tool('journalctl', 'touch "$TEST_BASE/logs-called"\n')

    def run_menu(self, *args, wget=False):
        command = 'export PATH="$TEST_TOOLS:$PATH"; '
        if wget:
            command += 'command() { if [[ "$*" == "-v curl" ]]; then return 1; else builtin command "$@"; fi; }; '
        result = subprocess.run([BASH, '-c', command + 'source "$@"', 'menu-test',
                                 shell_path(ROOT / 'scripts/agent-menu.sh'), *args],
                                env=self.env, capture_output=True, text=True, timeout=15)
        target = self.base / 'download-target'
        if target.exists():
            cleanup = subprocess.run([BASH, '-c', 'test ! -e "$1" && test ! -d "${1%/*}"',
                                      'cleanup-test', target.read_text()], capture_output=True, text=True)
            self.assertEqual(cleanup.returncode, 0, cleanup.stderr)
        return result

    def installer_args(self):
        return (self.base / 'installer-args').read_text().splitlines()

    def test_local_forwards_checksum_binary_version_and_confirmation(self):
        digest = 'aB09' * 16
        binary = shell_path(self.base / 'local binary;$(false)')
        result = self.run_menu('--action', 'local', '--binary', binary, '--sha256', digest,
                               '--version', 'v1.2.3', '--yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installer_args(), ['--reinstall', '--binary', binary, '--sha256', digest.lower(),
                                                '--version', 'v1.2.3', '--yes'])
        self.assertEqual((self.base / 'download-args').read_text().splitlines()[-1],
                         'https://panel.example.org/api/agent/install.sh')

    def test_local_checksum_uses_real_installer_verification(self):
        source = (ROOT / 'XPayincus/server/templates/agent-install.sh').read_text(encoding='utf-8')
        functions = '\n'.join(re.search(r'^' + name + r'\(\) \{.*?^\}', source, re.M | re.S)[0]
                              for name in ['sha256_file', 'verify_sha256'])
        self.env['PAYLOAD'] = ('fail() { exit 1; }\n' + functions + '\n'
                               'while (($#)); do case "$1" in '
                               '--binary) binary="$2"; shift 2;; '
                               '--sha256) digest="$2"; shift 2;; *) shift;; esac; done\n'
                               'verify_sha256 "$binary" "$digest"\n')
        binary = self.base / 'local binary'
        binary.write_bytes(b'local Agent checksum fixture\n')
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        for value in [digest, digest.upper(), ''.join(c.upper() if i % 2 else c for i, c in enumerate(digest))]:
            with self.subTest(digest=value):
                result = self.run_menu('--action', 'local', '--binary', shell_path(binary), '--sha256', value)
                self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_menu('--action', 'local', '--binary', shell_path(binary), '--sha256', '0' * 64)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('sha256 mismatch', result.stderr)

    def test_update_and_install_preserve_confirmation_and_token_arguments(self):
        result = self.run_menu('--action', 'update')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installer_args(), ['--reinstall', '--version', 'latest'])
        token = shell_path(self.base / 'private token')
        result = self.run_menu('--action', 'install', '--panel-url', 'https://new.example.org',
                               '--token-file', token, '--yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installer_args(), ['--panel-url', 'https://new.example.org', '--token-file',
                                                token, '--version', 'latest', '--yes'])

    def test_checksum_rejects_other_actions_before_download_or_status(self):
        for action in ['install', 'reinstall', 'update', 'status', 'logs']:
            with self.subTest(action=action):
                result = self.run_menu('--action', action, '--sha256', 'a' * 64)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('--sha256 僅適用 local', result.stderr)
        for name in ['download-args', 'installer-args', 'status-called', 'logs-called']:
            self.assertFalse((self.base / name).exists())

    def test_invalid_or_missing_checksum_stops_before_download(self):
        for values in [[], [''], ['a' * 63], ['a' * 65], ['g' * 64], ['$(false)']]:
            with self.subTest(values=values):
                result = self.run_menu('--action', 'local', '--binary', '/local-agent', '--sha256', *values)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.base / 'download-args').exists())

    def test_help_explains_trusted_local_checksum(self):
        result = self.run_menu('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--sha256 HASH', result.stdout)
        self.assertIn('可信來源', result.stdout)
        self.assertIn('僅適用 local', result.stdout)

    def test_config_file_precedes_config_dir_and_dir_is_fallback(self):
        directory = self.base / 'custom config'
        directory.mkdir()
        (directory / 'config.yaml').write_text('panel_url: "https://directory.example.org"\n', encoding='utf-8')
        self.env['INCUDAL_CONFIG_DIR'] = shell_path(directory)
        for file_override, origin in [(True, 'panel'), (False, 'directory')]:
            with self.subTest(file_override=file_override):
                if not file_override:
                    del self.env['INCUDAL_CONFIG_FILE']
                result = self.run_menu('--action', 'update')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.base / 'download-args').read_text().splitlines()[-1],
                                 f'https://{origin}.example.org/api/agent/install.sh')

    def test_reinstall_rejects_new_credentials_and_force(self):
        for action in ['reinstall', 'update', 'local']:
            for extra in [['--panel-url', 'https://new.example.org'], ['--token-file', '/new-token']]:
                with self.subTest(action=action, extra=extra):
                    result = self.run_menu('--action', action, *extra)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('重裝不接受新地址或 TOKEN', result.stderr)
        result = self.run_menu('--action', 'update', '--force')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.base / 'download-args').exists())

    def test_download_failures_empty_and_invalid_scripts_never_execute(self):
        valid = self.env['PAYLOAD']
        for wget in [False, True]:
            for status, payload in [('22', valid), ('6', valid), ('60', valid), ('28', valid),
                                    ('0', ''), ('0', valid + 'if then\n')]:
                with self.subTest(wget=wget, status=status, payload=payload):
                    self.env.update(FETCH_STATUS=status, PAYLOAD=payload)
                    result = self.run_menu('--action', 'update', wget=wget)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((self.base / 'installer-args').exists())
                    if status == '0':
                        self.assertIn('為空' if not payload else '語法檢查失敗', result.stderr)

    def test_wget_success_executes_installer(self):
        result = self.run_menu('--action', 'update', wget=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installer_args(), ['--reinstall', '--version', 'latest'])


if __name__ == '__main__':
    unittest.main()
