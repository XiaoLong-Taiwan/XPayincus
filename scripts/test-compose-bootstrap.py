import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / 'XPayincus/deploy/compose'
BASH = os.environ.get('BOOTSTRAP_TEST_BASH', 'bash')
VERSION = 'v1.0.5'


def release_override(version=VERSION):
    return json.dumps({'services': {service: {'image':
        f'ghcr.io/xiaolong-taiwan/xpayincus-{suffix}:{version}'}
        for service, suffix in [('api', 'api'), ('user', 'panel-web'), ('admin', 'panel-web')]}}).encode()


@unittest.skipIf(os.name == 'nt', '需要 Linux flock 與原生符號連結；Windows 改跑 archive 核心測試')
class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.destination = self.base / 'deployment'
        self.archive = self.base / 'source.tar.gz'
        self.log = self.base / 'docker.log'
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        FIXTURE_ARCHIVE=str(self.archive), DOCKER_LOG=str(self.log))
        self.shim('curl', 'while (($#)); do if [[ "$1" == --output ]]; then output="$2"; shift; fi; shift; done\ncp -- "$FIXTURE_ARCHIVE" "$output"\nprintf 200')
        self.shim('docker', 'printf "%s\\n" "$*" >> "$DOCKER_LOG"\nexit 99')
        self.make_archive()

    def shim(self, name, body):
        target = self.bin / name
        target.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n', newline='\n')
        target.chmod(0o755)

    def make_archive(self, version=VERSION, missing=None, extra=None, image_version=VERSION):
        with tarfile.open(self.archive, 'w:gz') as archive:
            for file in COMPOSE.iterdir():
                if file.is_file() and file.name != missing:
                    content = file.read_bytes()
                    member = tarfile.TarInfo(f'./XPayincus/deploy/compose/{file.name}')
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            content = version.encode()
            member = tarfile.TarInfo('./VERSION')
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
            if missing != 'compose.release.yaml':
                content = release_override(image_version)
                member = tarfile.TarInfo('./XPayincus/deploy/compose/compose.release.yaml')
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            if extra:
                archive.addfile(extra)

    def run_bootstrap(self, action='install', checksum=None, success=True, panel=False):
        checksum = checksum or hashlib.sha256(self.archive.read_bytes()).hexdigest()
        args = ([str(self.destination / 'panel.sh'), 'update'] if panel else
                [str(COMPOSE / 'download.sh'), action, str(self.destination)])
        result = subprocess.run([BASH, *args, VERSION, checksum],
                                env=self.env, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.log.exists(), 'bootstrap must never invoke Docker')
        return result

    def current(self):
        return os.readlink(self.destination / '.bootstrap/current')

    def test_download_update_preserves_private_data(self):
        self.run_bootstrap()
        previous = self.current()
        private = ['.env', 'secrets/key', 'certs/client.key', 'tls/user/privkey.pem',
                   'data/postgres/PG_VERSION', 'backups/db.dump', 'config/local', 'source/custom']
        for name in private:
            target = self.destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'$(touch must-not-execute)\nprivate\x00')
        before = {name: (self.destination / name).read_bytes() for name in private}
        self.run_bootstrap(panel=True)
        self.assertNotEqual(previous, self.current())
        self.assertTrue((self.destination / '.bootstrap' / previous).is_dir())
        self.assertEqual(before, {name: (self.destination / name).read_bytes() for name in private})
        override = json.loads((self.destination / 'compose.release.yaml').read_text())
        self.assertEqual(override, json.loads(release_override()))

    def test_validation_failures_keep_current(self):
        self.run_bootstrap()
        previous = self.current()
        self.run_bootstrap('update', checksum='0' * 64, success=False)
        for options in [dict(version='v9.0.0'), dict(missing='panel.sh'),
                        dict(missing='compose.release.yaml'), dict(image_version='latest'),
                        dict(extra=tarfile.TarInfo('../escape'))]:
            self.make_archive(**options)
            self.run_bootstrap('update', success=False)
            self.assertEqual(self.current(), previous)
        self.assertFalse((self.base / 'escape').exists())
        self.assertEqual(list((self.destination / '.bootstrap').glob('.staging.*')), [])

    def test_archive_links_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            member = tarfile.TarInfo('unsafe')
            member.type = kind
            member.linkname = '/etc/passwd'
            self.make_archive(extra=member)
            self.run_bootstrap(success=False)
            self.assertFalse((self.destination / '.bootstrap/current').exists())
            if self.destination.exists():
                shutil.rmtree(self.destination)

    def test_nonempty_and_modified_entry_rejected(self):
        self.destination.mkdir()
        (self.destination / '.env').write_text('preserve')
        self.run_bootstrap(success=False)
        self.assertEqual((self.destination / '.env').read_text(), 'preserve')
        self.run_bootstrap('update', success=False)
        shutil.rmtree(self.destination)
        self.run_bootstrap()
        previous = self.current()
        (self.destination / 'panel.sh').unlink()
        (self.destination / 'panel.sh').write_text('custom')
        self.run_bootstrap('update', success=False)
        self.assertEqual(self.current(), previous)

    def test_download_failure_and_lock_keep_current(self):
        self.run_bootstrap()
        previous = self.current()
        self.shim('curl', 'exit 22')
        self.run_bootstrap('update', success=False)
        self.assertEqual(self.current(), previous)
        self.shim('flock', 'exit 1')
        self.run_bootstrap('update', success=False)
        self.assertEqual(self.current(), previous)


class ArchiveCoreTests(BootstrapTests):
    __unittest_skip__ = False
    __unittest_skip_why__ = ''

    def run_bootstrap(self, action='install', checksum=None, success=True, panel=False, bundle=False):
        self.destination.mkdir(exist_ok=True)
        store = self.destination / '.bootstrap'
        store.mkdir(exist_ok=True)
        scratch = self.base / 'scratch'
        if scratch.exists():
            shutil.rmtree(scratch)
        scratch.mkdir()
        shutil.copyfile(self.archive, scratch / 'source.tar.gz')
        script = (COMPOSE / 'download.sh').read_text(encoding='utf-8')
        code = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        args = ['bootstrap', str(scratch), str(self.destination), action,
                VERSION, checksum or '0' * 64]
        artifact = f'xpayincus-compose-{VERSION}.tar.gz' if bundle else f'xpayincus-dashboard-{VERSION}-compose.tar.gz'
        args.append(artifact)
        links = {}

        def symlink(target, location):
            links[str(location)] = target
            Path(location).write_text(target)

        with patch.object(sys, 'argv', args), patch('os.symlink', side_effect=symlink), \
                patch('subprocess.run') as syntax:
            if success:
                exec(compile(code, 'bootstrap-core', 'exec'), {})
                self.assertEqual(syntax.call_count, 5)
                receipt = json.loads(next(store.glob('release-*/receipt.json')).read_text())
                self.assertEqual(receipt['version'], VERSION)
                self.assertEqual(receipt['artifact'], artifact)
                override = json.loads(next(store.glob('release-*/compose.release.yaml')).read_text())
                self.assertEqual(override, json.loads(release_override()))
                self.assertTrue((store / 'current').exists())
            else:
                with self.assertRaises((SystemExit, tarfile.TarError)):
                    exec(compile(code, 'bootstrap-core', 'exec'), {})
                self.assertFalse((store / 'current').exists())

    def test_download_update_preserves_private_data(self):
        self.destination.mkdir()
        private = self.destination / '.env'
        private.write_bytes(b'$(touch must-not-execute)\nprivate\x00')
        self.run_bootstrap()
        self.assertEqual(private.read_bytes(), b'$(touch must-not-execute)\nprivate\x00')

    def test_validation_failures_keep_current(self):
        for options in [dict(version='v9.0.0'), dict(missing='panel.sh'),
                        dict(missing='compose.release.yaml'), dict(image_version='latest'),
                        dict(extra=tarfile.TarInfo('../escape'))]:
            self.make_archive(**options)
            self.run_bootstrap(success=False)

    def test_nonempty_and_modified_entry_rejected(self):
        self.run_bootstrap(action='update', success=False)

    def test_download_failure_and_lock_keep_current(self):
        self.make_archive(missing='download.sh')
        self.run_bootstrap(success=False)

    def test_minimal_bundle_installs_and_records_artifact(self):
        import ast
        allowed = ast.literal_eval('(' + (COMPOSE / 'update.py').read_text().split('FILES = (', 1)[1].split('\n)', 1)[0] + ')')
        with tarfile.open(self.archive, 'r:gz') as original:
            entries = [(member, original.extractfile(member).read()) for member in original
                       if member.isfile() and (member.name == './VERSION' or member.name.rsplit('/', 1)[-1] in allowed)]
        with tarfile.open(self.archive, 'w:gz') as archive:
            for member, content in entries:
                archive.addfile(member, io.BytesIO(content))
        self.run_bootstrap(bundle=True)

    def test_minimal_bundle_rejects_source_files(self):
        with tarfile.open(self.archive, 'r:gz') as original:
            entries = [(member, original.extractfile(member).read()) for member in original if member.isfile()]
        with tarfile.open(self.archive, 'w:gz') as archive:
            for member, content in entries:
                archive.addfile(member, io.BytesIO(content))
            source = tarfile.TarInfo('XPayincus/client/package.json')
            source.size = 2
            archive.addfile(source, io.BytesIO(b'{}'))
        self.run_bootstrap(bundle=True, success=False)


class PanelCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.log = self.base / 'docker.log'
        shutil.copyfile(COMPOSE / 'panel.sh', self.base / 'panel.sh')
        shutil.copyfile(COMPOSE / 'update.py', self.base / 'update.py')
        shutil.copyfile(COMPOSE / 'compose.yaml', self.base / 'compose.yaml')
        shutil.copyfile(COMPOSE / 'docker-compose.yml', self.base / 'docker-compose.yml')
        (self.base / 'compose.release.yaml').write_bytes(release_override())
        (self.base / '.env').write_text('COMPOSE_PROFILES=\n')
        (self.base / 'secrets').mkdir()
        for name in ['postgres_password', 'jwt_secret', 'cookie_secret', 'encryption_key', 'admin_password']:
            (self.base / 'secrets' / name).write_text('fixture')
        for name, body in [('flock', 'exit 0'), ('docker',
                'printf "%s\\n" "$*" >> "$DOCKER_LOG"\n'
                'if [[ "$1 $2" == "buildx imagetools" ]]; then printf \'{"digest":"sha256:%064d"}\\n\' 0; exit 0; fi\n'
                'if [[ "$1 $2" == "image inspect" ]]; then printf \'[]\\n\'; exit 0; fi\n'
                'if [[ " $* " == *" pull "* && " $* " == *"${PULL_MATCH:-pull}"* ]]; then exit "${PULL_EXIT:-0}"; fi')]:
            target = self.bin / name
            target.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n', newline='\n')
            target.chmod(0o755)

    def run_panel(self, pull_exit, mode=None, profile='', pull_match='pull'):
        self.log.write_text('')
        bin_path = self.bin.as_posix()
        if os.name == 'nt':
            bin_path = '/' + bin_path[0].lower() + bin_path[2:]
        env = dict(os.environ, DOCKER_LOG=self.log.as_posix(), PULL_EXIT=str(pull_exit),
                   COMPOSE_PROFILES=profile, PULL_MATCH=pull_match)
        result = subprocess.run([BASH, '-c', 'export PATH="$1:$PATH"; shift; bash "$@"',
                                 'test', bin_path, (self.base / 'panel.sh').as_posix(), 'up',
                                 *([mode] if mode else [])],
                                env=env, capture_output=True, text=True)
        commands = self.log.read_text().splitlines()
        return result, commands

    @unittest.skipIf(os.name == 'nt', '官方映像解析需要 Linux fd 繼承')
    def test_pull_failure_does_not_stop_services(self):
        result, commands = self.run_panel(42)
        self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
        self.assertTrue(any('pull --policy always' in line for line in commands))
        self.assertFalse(any(' stop ' in line or ' up ' in line or ' down' in line for line in commands))

    @unittest.skipIf(os.name == 'nt', '官方映像解析需要 Linux fd 繼承')
    def test_success_pulls_before_stop_and_up(self):
        result, commands = self.run_panel(0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        pull = next(i for i, line in enumerate(commands) if 'pull --policy always' in line)
        stop = next(i for i, line in enumerate(commands) if ' stop ' in line)
        up = next(i for i, line in enumerate(commands) if ' up ' in line)
        self.assertLess(pull, stop)
        self.assertLess(stop, up)
        self.assertIn('--no-build --pull never --wait', commands[up])

    def test_manual_pull_uses_existing_compose_without_update_tools(self):
        (self.base / 'compose.release.yaml').unlink()
        (self.base / 'update.py').unlink()
        compose = self.base / 'compose.yaml'
        compose.write_text(compose.read_text().replace('ghcr.io/xiaolong-taiwan/', 'private.example/custom/'))
        private = {path: path.read_bytes() for path in self.base.rglob('*')
                   if path.is_file() and path != self.log}
        for mode in [None, 'pull']:
            with self.subTest(mode=mode):
                result, commands = self.run_panel(0, mode=mode)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(private, {path: path.read_bytes() for path in private})
                self.assertFalse(any('buildx' in line or ' build ' in line or 'image inspect' in line for line in commands))
                pulls = [i for i, line in enumerate(commands) if ' pull ' in line]
                stop = next(i for i, line in enumerate(commands) if ' stop ' in line)
                self.assertTrue(pulls)
                self.assertLess(max(pulls), stop)
                self.assertTrue(all(line.endswith(' pull --policy always') for line in (commands[i] for i in pulls)))
                self.assertTrue(all('/docker-compose.yml pull --policy always' in commands[i] for i in pulls))
                self.assertTrue(any('up -d --no-build --pull never --wait' in line for line in commands))

    def test_manual_pull_supports_legacy_compose_entry(self):
        (self.base / 'compose.release.yaml').unlink()
        (self.base / 'docker-compose.yml').unlink()
        result, commands = self.run_panel(0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any('/compose.yaml pull --policy always' in line for line in commands))
        self.assertFalse(any('/docker-compose.yml' in line for line in commands))

    def test_manual_pull_failure_does_not_stop_services(self):
        (self.base / 'compose.release.yaml').unlink()
        for mode in [None, 'pull']:
            with self.subTest(mode=mode):
                result, commands = self.run_panel(42, mode=mode)
                self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
                self.assertIn('建置／拉取全部必要映像', result.stderr)
                self.assertIn('尚未停止既有服務', result.stderr)
                self.assertTrue(any(line.endswith(' pull --policy always') for line in commands))
                self.assertFalse(any(' stop ' in line or ' up ' in line or ' down' in line for line in commands))

    def test_manual_pull_retains_preflight_checks(self):
        (self.base / 'compose.release.yaml').unlink()
        for profile in ['nginx', 'cloudflare', 'nginx,cloudflare']:
            with self.subTest(profile=profile):
                result, commands = self.run_panel(0, profile=profile)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(' pull ' in line or ' stop ' in line or ' up ' in line for line in commands))
        (self.base / 'secrets/jwt_secret').unlink()
        result, commands = self.run_panel(0)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(' pull ' in line or ' stop ' in line or ' up ' in line for line in commands))

    @unittest.skipIf(os.name == 'nt', '官方映像解析需要 Linux fd 繼承')
    def test_official_supporting_image_failure_does_not_stop_services(self):
        for profile, pull_match in [('', 'db init'), ('nginx', 'missing nginx'),
                                    ('cloudflare', 'missing tunnel-origin cloudflared')]:
            with self.subTest(profile=profile):
                for name in ['user/fullchain.pem', 'user/privkey.pem', 'admin/fullchain.pem', 'admin/privkey.pem']:
                    target = self.base / 'tls' / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('fixture')
                (self.base / 'secrets/cloudflare_tunnel_token').write_text('fixture')
                result, commands = self.run_panel(42, profile=profile, pull_match=pull_match)
                self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
                self.assertFalse(any(' stop ' in line or ' up ' in line or ' down' in line for line in commands))

    def test_empty_release_is_not_treated_as_manual_deployment(self):
        (self.base / 'compose.release.yaml').write_text('')
        result, commands = self.run_panel(0)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, [])

    def test_download_rejects_unpinned_input(self):
        for version, checksum in [('latest', 'a' * 64), ('main', 'a' * 64),
                                  ('v01.0.2', 'a' * 64), (VERSION, 'bad')]:
            result = subprocess.run([BASH, str(COMPOSE / 'download.sh'), 'install',
                                     str(self.base / 'new'), version, checksum],
                                    capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.base / 'new').exists())

    def test_checksum_failure_never_runs_archive_code(self):
        fixture = self.base / 'fixture.tar.gz'
        fixture.write_bytes(b'untrusted archive')
        marker = self.base / 'python-ran'
        for name, body in [('python3',
                'if [[ "$2" == --fetch ]]; then cp -- "$FIXTURE_ARCHIVE" "$4"; else touch -- "$PYTHON_MARKER"; fi')]:
            target = self.bin / name
            target.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n', newline='\n')
            target.chmod(0o755)
        bin_path = self.bin.as_posix()
        if os.name == 'nt':
            bin_path = '/' + bin_path[0].lower() + bin_path[2:]
        env = dict(os.environ, FIXTURE_ARCHIVE=fixture.as_posix(),
                   PYTHON_MARKER=marker.as_posix())
        result = subprocess.run([BASH, '-c',
            'export PATH="$1:$PATH"; bash "$2" install "$3" v1.0.5 "$4"', 'test',
            bin_path, (COMPOSE / 'download.sh').as_posix(),
            (self.base / 'new').as_posix(), '0' * 64], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('下載校驗失敗', result.stderr)
        self.assertFalse(marker.exists())
        self.assertFalse((self.base / 'new/.bootstrap/current').exists())
        self.assertEqual(list((self.base / 'new/.bootstrap').glob('.staging.*')), [])

    def test_menu_dispatches_literal_arguments_and_survives_failure(self):
        code = (COMPOSE / 'download.sh').read_text(encoding='utf-8').split('dashboard_menu() {\n', 1)[1].split('\n}\ncase ', 1)[0]
        code = '\n'.join(line for line in code.splitlines() if 'exec 8<>/dev/tty' not in line)
        code = code.replace('<&8', '').replace('>&8', '>&2')
        panel = self.base / 'panel.sh'
        panel.write_text('printf "<%s>" "$@" >> "$MENU_LOG"\nprintf "\\n" >> "$MENU_LOG"\nif [[ "$1" == update ]]; then exit 42; fi\n', newline='\n')
        log = self.base / 'menu.log'
        directory = self.base.as_posix()
        if os.name == 'nt':
            directory = '/' + directory[0].lower() + directory[2:]
        script = 'set -Eeuo pipefail\ndashboard_menu() {\n' + code + '\n}\ndashboard_menu "$1"'
        result = subprocess.run([BASH, '-c', script, 'test', directory],
                                input=b'3\n4\n5\n2\n0\n',
                                env=dict(os.environ, MENU_LOG=log.as_posix()), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('<update>', log.read_text())
        self.assertIn('<up><pull>', log.read_text())
        self.assertIn('<status>', log.read_text())
        self.assertIn('<wizard>', log.read_text())
        self.assertIn('更新失敗'.encode(), result.stderr)
        self.assertFalse((ROOT / 'forbidden').exists())

    @unittest.skipIf(os.name == 'nt', '需要 Linux controlling tty 與 pty')
    def test_menu_uses_tty_with_piped_stdin(self):
        import pty
        import select
        import time
        pid, descriptor = pty.fork()
        if pid == 0:
            os.execvp(BASH, [BASH, '-c', 'bash "$1" menu </dev/null', 'test', str(COMPOSE / 'download.sh')])
        output = b''
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                if select.select([descriptor], [], [], 0.1)[0]:
                    try:
                        output += os.read(descriptor, 65536)
                    except OSError:
                        break
                    if b'Compose' in output:
                        os.write(descriptor, b'0\n')
                ended, status = os.waitpid(pid, os.WNOHANG)
                if ended:
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)
                    break
            else:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
                self.fail('menu tty fixture timeout')
        finally:
            os.close(descriptor)
        self.assertIn(b'Compose', output)


if __name__ == '__main__':
    unittest.main()
