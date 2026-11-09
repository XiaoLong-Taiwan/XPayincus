import os
import json
import re
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'XPayincus/server/templates/agent-install.sh'
BASH = os.environ.get('AGENT_TEST_BASH', 'bash')
TOKEN = 'ait_' + 't' * 43
SECRET = 'ias_' + 's' * 43


class AgentInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / 'tools'
        self.bin.mkdir()
        self.script = self.base / 'installer.sh'
        self.script.write_text(SOURCE.read_text().replace('\npreflight_environment\n', '\n:\n'), newline='\n')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('INCUDAL_')}
        self.env.update(INCUDAL_AGENT_BIN=self.path(self.base / 'agent'),
                        INCUDAL_CONFIG_FILE=self.path(self.base / 'config.yaml'),
                        INCUDAL_SERVICE_FILE=self.path(self.base / 'agent.service'),
                        TEST_BASE=self.path(self.base))
        self.config = self.base / 'config.yaml'
        self.config.write_text(f'panel_url: "https://panel.example.org"\nagent_id: "agt_{"a" * 32}"\nagent_secret: "{SECRET}"\n', newline='\n')
        (self.base / 'agent').write_text('old binary')
        (self.base / 'agent.service').write_text('old unit')
        self.binary = self.base / 'compiled-agent'
        self.binary.write_text('#!/usr/bin/env bash\nprintf "smoke\\n" >> "$TEST_BASE/events"\nexit "${SMOKE_EXIT:-0}"\n', newline='\n')
        self.shim('uname', 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi')
        self.shim('sleep', ':')
        self.shim('systemctl', 'printf "%s\\n" "$*" >> "$TEST_BASE/events"\nif [ "$1" = restart ] && [ "${FAIL_RESTART:-0}" = 1 ] && [ ! -e "$TEST_BASE/failed" ]; then touch "$TEST_BASE/failed"; exit 1; fi')
        self.shim('install', 'args=(); while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done\n/usr/bin/install "${args[@]}"')
        self.shim('curl', 'printf "curl\\n" >> "$TEST_BASE/events"\ninput=""; out=""; while (($#)); do case "$1" in --config) input="$(cat)"; shift 2;; -o) out="$2"; shift 2;; *) shift;; esac; done\nif [ -n "$input" ]; then printf "%s\\n" "$input" > "$TEST_BASE/request"; cat "$TEST_BASE/response" > "$out"; exit "${EXCHANGE_EXIT:-0}"; fi\nexit 22')
        (self.base / 'response').write_text(f"INCUDAL_AGENT_ID='agt_{'a' * 32}'\nINCUDAL_AGENT_SECRET='{SECRET}'\n", newline='\n')

    def path(self, path):
        value = str(path).replace('\\', '/')
        return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value

    def shim(self, name, body):
        target = self.bin / name
        target.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n', newline='\n')
        target.chmod(0o755)

    def run_installer(self, *args, success=True):
        self.env['TEST_TOOLS'] = self.path(self.bin)
        result = subprocess.run([BASH, '-c', 'export PATH="$TEST_TOOLS:$PATH"; exec bash "$@"',
                                 'test', self.path(self.script), *args], env=self.env, capture_output=True, text=True)
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode == 0, success, output)
        self.assertNotIn(TOKEN, output)
        self.assertNotIn(SECRET, output)
        events = (self.base / 'events').read_text() if (self.base / 'events').exists() else ''
        for command in ['incus', 'rfw', 'zfs', 'modprobe', 'dkms']:
            self.assertNotIn(command, events)
        return output, events

    def local_args(self):
        return ['--binary', self.path(self.binary)]

    def credentials(self):
        self.env.update(INCUDAL_PANEL_URL='https://panel.example.org', INCUDAL_AGENT_INSTALL_TOKEN=TOKEN)

    def test_local_reinstall_preserves_config(self):
        before = self.config.read_bytes()
        _, events = self.run_installer('--reinstall', *self.local_args())
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual((self.base / 'agent').read_bytes(), self.binary.read_bytes())
        self.assertIn('restart incudal-agent', events)
        self.assertNotIn('curl', events)

    def test_post_install_failure_restores_files(self):
        before = {p: (self.base / p).read_bytes() for p in ['agent', 'config.yaml', 'agent.service']}
        self.env['FAIL_RESTART'] = '1'
        self.run_installer('--reinstall', *self.local_args(), success=False)
        for path, content in before.items():
            self.assertEqual((self.base / path).read_bytes(), content)

    def test_smoke_failure_does_not_replace(self):
        self.env['SMOKE_EXIT'] = '1'
        _, events = self.run_installer('--reinstall', *self.local_args(), success=False)
        self.assertEqual((self.base / 'agent').read_text(), 'old binary')
        self.assertNotIn('restart', events)

    def test_checksum_failure_precedes_exchange(self):
        self.credentials()
        _, events = self.run_installer(*self.local_args(), '--sha256', '0' * 64, success=False)
        self.assertNotIn('curl', events)

    def test_local_install_exchanges_once_without_token_in_args(self):
        self.credentials()
        _, events = self.run_installer(*self.local_args())
        self.assertEqual(events.count('curl'), 1)
        self.assertIn(TOKEN, (self.base / 'request').read_text())
        self.assertIn(SECRET, self.config.read_text())

    def test_exchange_failure_not_retried(self):
        self.credentials()
        self.env['EXCHANGE_EXIT'] = '28'
        _, events = self.run_installer(*self.local_args(), success=False)
        self.assertEqual(events.count('curl'), 1)
        self.assertEqual((self.base / 'agent').read_text(), 'old binary')

    def test_response_is_not_executed(self):
        self.credentials()
        (self.base / 'response').write_text('touch "$TEST_BASE/injected"\n')
        self.run_installer(*self.local_args(), success=False)
        self.assertFalse((self.base / 'injected').exists())

    def test_reinstall_rejects_new_credentials(self):
        self.credentials()
        self.run_installer('--reinstall', *self.local_args(), success=False)

    def test_download_failure_precedes_exchange(self):
        self.credentials()
        _, events = self.run_installer(success=False)
        self.assertEqual(events.count('curl'), 1)
        self.assertFalse((self.base / 'request').exists())

    def test_staging_write_failure_precedes_exchange(self):
        self.credentials()
        self.shim('install', 'for arg in "$@"; do [[ "$arg" != *.download.*.tmp ]] || exit 73; done\n/usr/bin/install "$@"')
        _, events = self.run_installer(*self.local_args(), success=False)
        self.assertNotIn('curl', events)
        self.assertEqual((self.base / 'agent').read_text(), 'old binary')

    def test_failed_atomic_copy_does_not_publish_partial_binary(self):
        before = {p: (self.base / p).read_bytes() for p in ['agent', 'config.yaml', 'agent.service']}
        self.shim('install', 'args=(); while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done\nlast="${args[${#args[@]}-1]}"\nif [[ "$last" == */agent.new ]]; then printf partial > "$last"; exit 73; fi\n/usr/bin/install "${args[@]}"')
        self.run_installer('--reinstall', *self.local_args(), success=False)
        for path, content in before.items():
            self.assertEqual((self.base / path).read_bytes(), content)

    def test_invalid_origin_rejected(self):
        self.credentials()
        for url in ['https://user:password@panel.example.org', 'https://panel.example.org/path', 'https://panel.example.org?token=private']:
            self.env['INCUDAL_PANEL_URL'] = url
            self.run_installer(*self.local_args(), success=False)

    def test_dry_run_does_not_expose_credentials(self):
        self.credentials()
        self.env['INCUDAL_AGENT_DRY_RUN'] = '1'
        output, events = self.run_installer(*self.local_args())
        self.assertIn('<redacted-install-token>', output)
        self.assertNotIn('curl', events)
        self.assertEqual((self.base / 'agent').read_text(), 'old binary')

    def test_missing_config_reinstall_rejected(self):
        self.config.unlink()
        self.run_installer('--reinstall', *self.local_args(), success=False)

    def test_token_file_entry(self):
        self.env['INCUDAL_PANEL_URL'] = 'https://panel.example.org'
        token_file = self.base / 'token'
        token_file.write_text(TOKEN + '\n')
        token_file.chmod(0o600)
        if os.name == 'nt':
            self.shim('stat', 'case "$2" in %a) echo 600;; %u) id -u;; esac')
        self.run_installer('--token-file', self.path(token_file), *self.local_args())

    def test_exchange_url_not_passed_in_curl_arguments(self):
        self.credentials()
        self.shim('curl', 'for arg in "$@"; do [[ "$arg" != *ait_* ]] || exit 90; done\nwhile (($#)); do if [ "$1" = -o ]; then cp "$TEST_BASE/response" "$2"; shift; fi; shift; done\ncat > "$TEST_BASE/request"')
        self.run_installer(*self.local_args())

    def test_manifest_version_guards_and_cache_notice(self):
        source = SOURCE.read_text()
        function = re.search(r'^select_manifest\(\) \{.*?^\}', source, re.M | re.S).group()
        manifest_path = self.base / 'manifest.json'
        manifest = {'version': 'v1.2.3', 'schemaVersion': 1, 'minimumUpdaterVersion': 'v1.0.0',
                    'source': 'cache', 'files': {'linux-amd64': {'name': 'xpayincus-agent-v1.2.3-linux-amd64.gz', 'sha256': 'a' * 64, 'size': 42, 'gzip': True}}}
        self.shim('python3', 'exec python "$@"')
        self.shim('current-agent', 'echo v1.1.0')
        function_script = self.base / 'select.sh'
        function_script.write_text('set -eu\nfail() { echo "$*" >&2; exit 1; }\n' + function + '\nselect_manifest\n', newline='\n')
        self.env.update(MANIFEST_PATH=self.path(manifest_path), OS='linux', ARCH='amd64', TARGET_VERSION='latest',
                        BIN_PATH=self.path(self.bin / 'current-agent'), TEST_TOOLS=self.path(self.bin))
        for mutation, accepted in [({}, True), ({'version': 'v0.9.0'}, False), ({'schemaVersion': 2}, False), ({'minimumUpdaterVersion': 'v2.0.0'}, False)]:
            manifest_path.write_text(json.dumps({**manifest, **mutation}))
            result = subprocess.run([BASH, '-c', 'export PATH="$TEST_TOOLS:$PATH"; bash "$1"', 'test', self.path(function_script)], env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, accepted, result.stderr)
            if accepted:
                self.assertEqual(result.stdout.splitlines()[0], 'v1.2.3')
                self.assertEqual(result.stdout.splitlines()[-1], 'cache')

    def test_menu_downloads_only_installer_and_preserves_reinstall(self):
        self.shim('id', 'echo 0')
        self.shim('curl', 'printf "%s\\n" "$@" > "$TEST_BASE/download-args"\nwhile (($#)); do if [ "$1" = -o ]; then cp "$TEST_BASE/fixture-installer" "$2"; shift; fi; shift; done')
        (self.base / 'fixture-installer').write_text('printf "%s\\n" "$@" > "$TEST_BASE/installer-args"\n', newline='\n')
        self.env['TEST_TOOLS'] = self.path(self.bin)
        menu = self.path(ROOT / 'scripts/agent-menu.sh')
        result = subprocess.run([BASH, '-c', 'export PATH="$TEST_TOOLS:$PATH"; bash "$1" --action update', 'test', menu], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / 'installer-args').read_text().splitlines(), ['--reinstall', '--version', 'latest'])
        self.assertIn('https://panel.example.org/api/agent/install.sh', (self.base / 'download-args').read_text())

    def test_menu_stream_entry_preserves_cwd_without_repository(self):
        self.shim('curl', 'cat "$TEST_BASE/menu-source"')
        self.shim('systemctl', 'pwd -P > "$TEST_BASE/child-cwd"\nprintf "%s\\n" "$@" > "$TEST_BASE/status-args"')
        (self.base / 'menu-source').write_bytes((ROOT / 'scripts/agent-menu.sh').read_bytes())
        self.env['TEST_TOOLS'] = self.path(self.bin)
        for invocation in ['curl -fsSL https://raw.example/agent-menu.sh | bash -s -- --action status',
                           'bash <(curl -fsSL https://raw.example/agent-menu.sh) --action status']:
            result = subprocess.run([BASH, '-c', 'set -euo pipefail; export PATH="$TEST_TOOLS:$PATH"; before="$(pwd -P)"; ' + invocation + '; test "$(pwd -P)" = "$before"; test "$(cat "$TEST_BASE/child-cwd")" = "$before"'],
                                    cwd=self.base, env=self.env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.base / 'status-args').read_text().splitlines(), ['--no-pager', 'status', 'incudal-agent'])

    def test_menu_stream_exit_reads_tty_separately_and_preserves_cwd(self):
        source = (ROOT / 'scripts/agent-menu.sh').read_text()
        self.assertIn('</dev/tty', source)
        self.assertNotRegex(source, r'(?m)^\s*cd\s')
        tty = self.base / 'tty-input'
        tty.write_text('0\n', newline='\n')
        (self.base / 'menu-source').write_text(source.replace('/dev/tty', self.path(tty)), newline='\n')
        self.shim('curl', 'cat "$TEST_BASE/menu-source"')
        self.env['TEST_TOOLS'] = self.path(self.bin)
        for invocation in ['curl -fsSL https://raw.example/agent-menu.sh | bash',
                           'bash <(curl -fsSL https://raw.example/agent-menu.sh)']:
            result = subprocess.run([BASH, '-c', 'set -euo pipefail; export PATH="$TEST_TOOLS:$PATH"; before="$(pwd -P)"; ' + invocation + '; test "$(pwd -P)" = "$before"'],
                                    cwd=self.base, env=self.env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            for option in range(7):
                self.assertIn(f'[{option}]', result.stdout)
            self.assertIn('----------------------------------------', result.stdout)
        self.assertFalse((self.base / 'request').exists())

    def test_menu_missing_dependency_is_explicit(self):
        menu = self.path(ROOT / 'scripts/agent-menu.sh')
        result = subprocess.run([BASH, '-c', 'export PATH=/nonexistent; source "$1" --action status', 'test', menu],
                                cwd=self.base, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('缺少必要指令：systemctl', result.stderr)

    @unittest.skipIf(os.name == 'nt', 'POSIX controlling terminal requires Linux/macOS')
    def test_menu_real_tty_process_substitution_exit(self):
        import pty
        import select
        import time
        self.env['TEST_TOOLS'] = self.path(self.bin)
        self.shim('curl', 'cat "$TEST_BASE/menu-source"')
        (self.base / 'menu-source').write_bytes((ROOT / 'scripts/agent-menu.sh').read_bytes())
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.base)
            os.execvpe(BASH, [BASH, '-c', 'export PATH="$TEST_TOOLS:$PATH"; before="$(pwd -P)"; bash <(curl -fsSL https://raw.example/agent-menu.sh); result=$?; test "$(pwd -P)" = "$before" || exit 99; exit "$result"'], self.env)
        output = b''
        status = None
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([fd], [], [], 0.1)
                if ready:
                    try:
                        output += os.read(fd, 4096)
                    except OSError:
                        break
                    if '請選擇：'.encode() in output:
                        os.write(fd, b'0\n')
                child, status = os.waitpid(pid, os.WNOHANG)
                if child:
                    break
                status = None
            if status is None:
                child, status = os.waitpid(pid, os.WNOHANG)
                if not child:
                    self.fail('TTY menu did not exit')
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, output.decode(errors='replace'))
        finally:
            os.close(fd)
            if status is None:
                import signal
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)


if __name__ == '__main__':
    unittest.main()
