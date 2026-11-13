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
        result = subprocess.run([BASH, '-n', shell_path(SOURCE)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
