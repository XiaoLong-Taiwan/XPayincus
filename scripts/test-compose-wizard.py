import contextlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / 'XPayincus/deploy/compose'
BASH = os.environ.get('BOOTSTRAP_TEST_BASH', 'bash')
SCRIPT = (COMPOSE / 'panel.sh').read_text(encoding='utf-8')
CODE = SCRIPT.split("<<'WIZARD_PY'\n", 1)[1].split('\nWIZARD_PY\n', 1)[0]


class WizardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.module = {'__name__': 'wizard_fixture'}
        exec(compile(CODE, 'wizard-fixture', 'exec'), self.module)
        self.password = 'FixtureSecure1$()'
        self.token = 'FixtureTunnelToken123=='

    def configure(self, profile='2', inputs=None, hidden=None):
        answers = iter(inputs or [profile, 'https://pay.example.org', 'https://admin.example.org', 'admin@example.org'])
        private = iter(hidden or [self.password, self.password, self.token])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.module['configure'](self.base, lambda prompt: next(answers), lambda prompt: next(private))
        self.assertNotIn(self.password, output.getvalue())
        self.assertNotIn(self.token, output.getvalue())
        return output.getvalue()

    def test_cloudflare_settings_and_secrets_permissions(self):
        output = self.configure()
        self.assertIn('http://tunnel-origin:80', output)
        self.assertIn('pay.example.org', output)
        self.assertIn('admin.example.org', output)
        self.assertEqual((self.base / 'secrets/admin_password').read_text().strip(), self.password)
        self.assertEqual((self.base / 'secrets/cloudflare_tunnel_token').read_text().strip(), self.token)
        env = (self.base / '.env').read_text()
        self.assertIn('COMPOSE_PROFILES=cloudflare', env)
        self.assertNotIn(self.password, env)
        self.assertNotIn(self.token, env)
        self.assertFalse(list(self.base.glob('.wizard-*')))
        if os.name != 'nt':
            for path in [self.base / '.env', *(self.base / 'secrets').iterdir()]:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_nginx_copies_validated_pairs(self):
        answers = ['1', 'https://pay.example.org', 'https://admin.example.org', 'admin@example.org', 'cert-user', 'key-user', 'cert-admin', 'key-admin']
        calls = []
        def pair(cert, key, host):
            calls.append((cert, key, host))
            return b'fixture certificate', b'fixture private key'
        with patch.dict(self.module, tls_pair=pair):
            self.configure(inputs=answers)
        self.assertEqual(len(calls), 2)
        for site in ['user', 'admin']:
            self.assertEqual((self.base / f'tls/{site}/privkey.pem').read_bytes(), b'fixture private key')
        self.assertIn('COMPOSE_PROFILES=nginx', (self.base / '.env').read_text())

    def test_generated_settings_parse_with_compose_without_daemon(self):
        if not shutil.which('docker'):
            self.skipTest('需要 Docker Compose CLI')
        self.configure()
        for name in ['compose.yaml', 'docker-compose.yml']:
            shutil.copyfile(COMPOSE / name, self.base / name)
        env = dict(os.environ)
        env.pop('COMPOSE_FILE', None)
        env.pop('COMPOSE_PROFILES', None)
        result = subprocess.run(['docker', 'compose', '--project-name', 'incudal-panel', '--project-directory', str(self.base), '--env-file', str(self.base / '.env'), '--file', str(self.base / 'docker-compose.yml'), 'config', '--quiet'], env=env, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.password.encode(), result.stdout + result.stderr)
        self.assertNotIn(self.token.encode(), result.stdout + result.stderr)

    def test_external_and_release_override(self):
        (self.base / 'compose.release.yaml').write_text('fixture')
        self.configure('3')
        self.assertIn('COMPOSE_PROFILES=\n', (self.base / '.env').read_text())
        self.assertIn('COMPOSE_FILE=compose.yaml:compose.release.yaml', (self.base / '.env').read_text())

    def test_invalid_inputs_do_not_write_settings(self):
        invalid = [
            (['9'], None),
            (['2', 'http://pay.example.org'], None),
            (['2', 'https://pay.example.org/'], None),
            (['2', 'https://pay.example.org:99999'], None),
            (['2', 'https://pay.example.org', 'https://PAY.example.org'], None),
            (['2', 'https://pay.example.org', 'https://admin.example.org', 'invalid'], None),
            (None, ['weak']),
            (None, [self.password, 'Mismatch1']),
            (None, [self.password, self.password, 'bad token']),
        ]
        for inputs, hidden in invalid:
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                self.configure(inputs=inputs, hidden=hidden)
            self.assertFalse((self.base / '.env').exists())
            self.assertFalse((self.base / 'secrets').exists())

    def test_existing_settings_and_data_are_untouched(self):
        for name in ['.env', 'secrets', 'tls', 'data', 'certs', 'config', 'backups']:
            path = self.base / name
            path.write_bytes(b'private preserved')
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.configure()
            self.assertEqual(path.read_bytes(), b'private preserved')
            path.unlink()

    def test_tls_and_write_failure_do_not_commit_partial_settings(self):
        inputs = ['1', 'https://pay.example.org', 'https://admin.example.org', 'admin@example.org', 'missing-cert', 'missing-key']
        with self.assertRaises(ValueError):
            self.configure(inputs=inputs)
        self.assertFalse((self.base / '.env').exists())
        rename = os.rename
        def fail_env(source, destination):
            if Path(destination).name == '.env':
                raise OSError('fixture')
            return rename(source, destination)
        with patch('os.rename', side_effect=fail_env), self.assertRaises(OSError):
            self.configure()
        self.assertEqual(list(self.base.iterdir()), [])

    def test_tls_checks_hostname_trust_expiry_and_pair(self):
        cert = self.base / 'cert'
        key = self.base / 'key'
        cert.write_bytes(b'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----')
        key.write_bytes(b'fixture private')
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            self.assertNotIn('fixture private', str(args))
            return subprocess.CompletedProcess(args, 0, b'public', b'')
        with patch('subprocess.run', side_effect=run):
            self.module['tls_pair'](str(cert), str(key), 'pay.example.org')
        self.assertTrue(any('-verify_hostname' in args and 'pay.example.org' in args for args in calls))
        self.assertTrue(any('-checkend' in args for args in calls))
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 1, b'', b'private-error')), self.assertRaises(ValueError) as caught:
            self.module['tls_pair'](str(cert), str(key), 'pay.example.org')
        self.assertNotIn('private-error', str(caught.exception))
        with patch.dict(self.module, openssl=lambda *args: b'cert-public' if args[0] == 'x509' else b'other'), self.assertRaises(ValueError):
            self.module['tls_pair'](str(cert), str(key), 'pay.example.org')

    @unittest.skipUnless(shutil.which('openssl') or Path('C:/Program Files/Git/usr/bin/openssl.exe').exists(), '需要 OpenSSL')
    def test_real_tls_trusted_wildcard_and_mismatch(self):
        executable = shutil.which('openssl') or 'C:/Program Files/Git/usr/bin/openssl.exe'
        cert, key, other = [self.base / name for name in ('cert.pem', 'key.pem', 'other.pem')]
        def run(*args):
            subprocess.run([executable, *args], check=True, capture_output=True)
        run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=*.example.org', '-addext', 'subjectAltName=DNS:*.example.org', '-keyout', str(key), '-out', str(cert))
        run('genrsa', '-out', str(other), '2048')
        original = subprocess.run
        def openssl(args, **kwargs):
            return original([executable, *args[1:]], **kwargs)
        with patch('subprocess.run', side_effect=openssl), patch.dict(os.environ, SSL_CERT_FILE=str(cert)):
            self.module['tls_pair'](str(cert), str(key), 'pay.example.org')
            self.module['tls_pair'](str(cert), str(key), 'admin.example.org')
            with self.assertRaises(ValueError):
                self.module['tls_pair'](str(cert), str(other), 'pay.example.org')
            with self.assertRaises(ValueError):
                self.module['tls_pair'](str(cert), str(key), 'other.invalid')

    def test_shell_wizard_only_starts_after_setup_and_retains_config_on_pull_failure(self):
        shell = SCRIPT.split('if [[ "$command_name" == wizard ]]; then\n', 1)[1].split('\nfi\n\nif [[ "$command_name" == init', 1)[0]
        shell = shell.split('  if ! python3', 1)[0] + '  if ! python3' + shell.split('  if ! python3', 1)[1].split("<<'WIZARD_PY'", 1)[0] + '\n' + shell.split('\nWIZARD_PY\n', 1)[1]
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'python3').write_text('#!/usr/bin/env bash\nif [[ "$SETUP_EXIT" == 0 ]]; then printf configured > "$2/.env"; fi\nexit "$SETUP_EXIT"\n', newline='\n')
        (bin_dir / 'python3').chmod(0o755)
        (self.base / 'panel.sh').write_text('printf "%s\\n" "$*" >> "$UP_LOG"\nexit "$UP_EXIT"\n', newline='\n')
        log = self.base / 'up.log'
        directory = self.base.as_posix()
        if os.name == 'nt':
            directory = '/' + directory[0].lower() + directory[2:]
        wrapper = 'set -Eeuo pipefail\nbase="$1"\nexport PATH="$base/bin:$PATH"\nshift\ndie() { printf "%s\\n" "$*" >&2; exit 1; }\n' + shell
        for setup_exit, up_exit in [('1', '0'), ('0', '42'), ('0', '0')]:
            if log.exists():
                log.unlink()
            result = subprocess.run([BASH, '-c', wrapper, 'test', directory], env=dict(os.environ, SETUP_EXIT=setup_exit, UP_EXIT=up_exit, UP_LOG=log.as_posix()), capture_output=True)
            self.assertEqual(result.returncode == 0, setup_exit == up_exit == '0')
            self.assertEqual(log.exists(), setup_exit == '0')
            if setup_exit == '0':
                self.assertEqual(log.read_text().strip(), 'up pull')
                self.assertTrue((self.base / '.env').exists())
            if up_exit == '42':
                self.assertNotIn('安裝精靈完成'.encode(), result.stdout)


if __name__ == '__main__':
    unittest.main()
