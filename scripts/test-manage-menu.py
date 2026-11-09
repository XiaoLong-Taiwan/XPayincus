import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/manage.sh'
RAW = 'https://raw.githubusercontent.com/XiaoLong-Taiwan/XPayincus/main/'
BASH = os.environ.get('BASH_EXE') or shutil.which('bash')
if os.name == 'nt' and Path('C:/Program Files/Git/bin/bash.exe').is_file():
    BASH = os.environ.get('BASH_EXE') or 'C:/Program Files/Git/bin/bash.exe'


def shell_path(path):
    value = Path(path).resolve().as_posix()
    return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value


class ManageMenuTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='manage tests ')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.scratch = self.base / 'scratch'
        self.scratch.mkdir()
        self.repo = self.base / 'repo'
        (self.repo / 'scripts').mkdir(parents=True)
        self.entry = self.repo / 'scripts/manage.sh'
        shutil.copyfile(SOURCE, self.entry)
        self.log = self.base / 'calls'
        self.env = dict(os.environ, PATH=shell_path(self.bin), TMPDIR=shell_path(self.scratch),
                        CALLS=shell_path(self.log), CHILD_STATUS='0', FETCH_STATUS='0',
                        CHILD_SCRIPT='printf "child:%s\\n" "$0" "$@" >>"$CALLS"\nexit "$CHILD_STATUS"\n')
        startup = self.base / 'bash-env'
        startup.write_text('export PATH="$MOCK_BIN"\n', encoding='utf-8', newline='\n')
        self.env['BASH_ENV'] = shell_path(startup)
        self.env['MOCK_BIN'] = shell_path(self.bin)
        self.env.pop('ENV', None)
        for name in ('bash', 'dirname', 'mktemp', 'rm'):
            self.tool(name, f'exec /usr/bin/{name} "$@"\n')
        for name in ('sudo', 'git', 'incus', 'systemctl', 'journalctl', 'docker', 'id'):
            self.tool(name, f'printf "forbidden:{name}\\n" >>"$CALLS"\nexit 99\n')
        self.fetcher('curl')

    def tool(self, name, body):
        target = self.bin / name
        target.write_text('#!/bin/bash\n' + body, encoding='utf-8', newline='\n')
        target.chmod(0o755)

    def fetcher(self, name):
        self.tool(name, '''printf 'fetch:%s\n' "$0" "$@" >>"$CALLS"
target=''
while (($#)); do
  case "$1" in -o|-O) target="$2"; shift 2 ;; *) shift ;; esac
done
printf '%s' "$CHILD_SCRIPT" >"$target"
printf 'mode:%s\n' "$(/usr/bin/stat -c %a "$(/usr/bin/dirname "$target")")" >>"$CALLS"
exit "$FETCH_STATUS"
''')

    def local_child(self, route):
        relative = 'scripts/agent-menu.sh' if route == 'agent' else 'scripts/dashboard.sh'
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(self.env['CHILD_SCRIPT'], encoding='utf-8', newline='\n')
        return target

    def run_entry(self, *args, piped=False):
        command = [BASH, '-c', 'bash -s -- "$@"', 'manage-test', *args] if piped else [BASH, shell_path(self.entry), *args]
        result = subprocess.run(command, input=self.entry.read_text(encoding='utf-8') if piped else '',
                                capture_output=True, text=True, env=self.env, cwd=self.base, timeout=15)
        self.assertEqual(list(self.scratch.iterdir()), [], result.stderr)
        if self.log.exists():
            self.assertNotIn('forbidden:', self.log.read_text())
        return result

    def calls(self):
        return self.log.read_text() if self.log.exists() else ''

    def mock_terminal(self, choices):
        text = SOURCE.read_text(encoding='utf-8')
        self.assertIn('exec 8<>/dev/tty', text)
        self.assertIn('IFS= read -r choice <&8', text)
        self.entry.write_text(text.replace('exec 8<>/dev/tty', 'exec 8<"$MOCK_TTY"').replace('>&8', '>&2'),
                              encoding='utf-8', newline='\n')
        terminal = self.base / 'terminal'
        terminal.write_text(choices, encoding='utf-8', newline='\n')
        self.env['MOCK_TTY'] = shell_path(terminal)

    def test_local_routes_preserve_arguments_without_network(self):
        for route, args in [('dashboard', ['menu', '/srv/panel space']),
                            ('agent', ['--action', 'status', 'literal;$(false)'])]:
            with self.subTest(route=route):
                child = self.local_child(route)
                result = self.run_entry('--' + route, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('child:' + shell_path(child), self.calls())
                for value in args:
                    self.assertIn('child:' + value + '\n', self.calls())
        self.assertNotIn('fetch:', self.calls())

    def test_remote_curl_only_fetches_selected_official_entry(self):
        result = self.run_entry('--dashboard', 'install', '/srv/panel space', 'latest')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertIn(RAW + 'scripts/dashboard.sh', calls)
        self.assertNotIn(RAW + 'scripts/agent-menu.sh', calls)
        for value in ['fetch:--proto\nfetch:=https', 'fetch:--proto-redir\nfetch:=https', '-q', '-fsSL', 'mode:700', 'child:latest']:
            self.assertIn(value, calls)

    def test_wget_fallback(self):
        (self.bin / 'curl').unlink()
        self.fetcher('wget')
        result = self.run_entry('--agent', '--action', 'status')
        self.assertEqual(result.returncode, 0, result.stderr)
        for value in ['--no-config', '--https-only', RAW + 'scripts/agent-menu.sh', 'mode:700', 'child:status']:
            self.assertIn(value, self.calls())

    def test_download_failure_never_runs_partial_body(self):
        for downloader, status in [('curl', '22'), ('wget', '8')]:
            with self.subTest(downloader=downloader):
                if downloader == 'wget':
                    (self.bin / 'curl').unlink()
                    self.fetcher('wget')
                self.env['FETCH_STATUS'] = status
                result = self.run_entry('--dashboard')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('HTTPS 下載失敗', result.stderr)
                self.assertIn('exit=' + status, result.stderr)
                self.assertIn('403', result.stderr)
                self.assertNotIn('child:', self.calls())

    def test_empty_download_and_missing_tools_fail(self):
        self.env['CHILD_SCRIPT'] = ''
        result = self.run_entry('--agent')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('空檔', result.stderr)
        (self.bin / 'curl').unlink()
        result = self.run_entry('--agent')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('需要 curl 或 wget', result.stderr)

    def test_child_failure_preserved_locally_and_remotely(self):
        self.env['CHILD_STATUS'] = '37'
        result = self.run_entry('--dashboard')
        self.assertEqual(result.returncode, 37, result.stderr)
        self.local_child('agent')
        result = self.run_entry('--agent', '--action', 'status')
        self.assertEqual(result.returncode, 37, result.stderr)

    def test_signal_cleans_download_directory(self):
        self.env['CHILD_SCRIPT'] = 'kill -TERM "$PPID"\nexit 0\n'
        result = self.run_entry('--dashboard')
        self.assertEqual(result.returncode, 143, result.stderr)

    def test_piped_script_routes_without_reading_stdin(self):
        result = self.run_entry('--agent', '--action', 'status', piped=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(RAW + 'scripts/agent-menu.sh', self.calls())
        self.assertIn('child:status', self.calls())

    def test_menu_repeats_after_children_and_invalid_choice(self):
        self.mock_terminal('invalid\n1\n2\n0\n')
        result = self.run_entry()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count('1) Dashboard / Compose 選單'), 4)
        self.assertIn('請輸入 1、2 或 0', result.stderr)
        self.assertIn(RAW + 'scripts/agent-menu.sh', self.calls())
        self.assertIn(RAW + 'scripts/dashboard.sh', self.calls())

    def test_menu_stops_on_child_failure(self):
        self.mock_terminal('1\n2\n0\n')
        self.env['CHILD_STATUS'] = '41'
        result = self.run_entry()
        self.assertEqual(result.returncode, 41, result.stderr)
        self.assertNotIn(RAW + 'scripts/agent-menu.sh', self.calls())

    def test_piped_menu_uses_terminal_instead_of_script_stdin(self):
        self.mock_terminal('1\n0\n')
        result = self.run_entry(piped=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count('1) Dashboard / Compose 選單'), 2)
        self.assertIn('child:', self.calls())

    def test_menu_exit_and_eof_do_not_download(self):
        for choices in ['0\n', '']:
            with self.subTest(choices=choices):
                self.mock_terminal(choices)
                result = self.run_entry()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.calls(), '')

    def test_unavailable_terminal_has_actionable_error(self):
        self.entry.write_text(SOURCE.read_text(encoding='utf-8').replace('/dev/tty', '/nonexistent/manage-test-tty'),
                              encoding='utf-8', newline='\n')
        result = self.run_entry()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--dashboard 或 --agent', result.stderr)
        self.assertEqual(self.calls(), '')

    def test_help_and_invalid_arguments_do_not_download(self):
        result = self.run_entry('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        for args in [('--unknown',), ('',)]:
            result = self.run_entry(*args)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), '')

    def test_bash_syntax(self):
        result = subprocess.run([BASH, '-n', shell_path(SOURCE)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
