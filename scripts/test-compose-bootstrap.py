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
VERSION = 'v1.0.3'


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
        self.shim('curl', 'while (($#)); do if [[ "$1" == --output ]]; then output="$2"; shift; fi; shift; done\ncp -- "$FIXTURE_ARCHIVE" "$output"')
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

    def run_bootstrap(self, action='install', checksum=None, success=True, panel=False):
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
                self.assertEqual(receipt['artifact'], f'xpayincus-dashboard-{VERSION}-compose.tar.gz')
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


class PanelCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.log = self.base / 'docker.log'
        shutil.copyfile(COMPOSE / 'panel.sh', self.base / 'panel.sh')
        (self.base / '.env').write_text('COMPOSE_PROFILES=\n')
        (self.base / 'secrets').mkdir()
        for name in ['postgres_password', 'jwt_secret', 'cookie_secret', 'encryption_key', 'admin_password']:
            (self.base / 'secrets' / name).write_text('fixture')
        for name, body in [('flock', 'exit 0'), ('docker',
                'printf "%s\\n" "$*" >> "$DOCKER_LOG"\n'
                'if [[ " $* " == *" pull "* ]]; then exit "${PULL_EXIT:-0}"; fi')]:
            target = self.bin / name
            target.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n', newline='\n')
            target.chmod(0o755)

    def run_panel(self, pull_exit):
        bin_path = self.bin.as_posix()
        if os.name == 'nt':
            bin_path = '/' + bin_path[0].lower() + bin_path[2:]
        env = dict(os.environ, DOCKER_LOG=self.log.as_posix(), PULL_EXIT=str(pull_exit),
                   COMPOSE_PROFILES='')
        result = subprocess.run([BASH, '-c', 'export PATH="$1:$PATH"; bash "$2" up',
                                 'test', bin_path, (self.base / 'panel.sh').as_posix()],
                                env=env, capture_output=True, text=True)
        commands = self.log.read_text().splitlines()
        return result, commands

    def test_pull_failure_does_not_stop_services(self):
        result, commands = self.run_panel(42)
        self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
        self.assertTrue(any('pull --policy always' in line for line in commands))
        self.assertFalse(any(' stop ' in line or ' up ' in line or ' down' in line for line in commands))

    def test_success_pulls_before_stop_and_up(self):
        result, commands = self.run_panel(0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        pull = next(i for i, line in enumerate(commands) if 'pull --policy always' in line)
        stop = next(i for i, line in enumerate(commands) if ' stop ' in line)
        up = next(i for i, line in enumerate(commands) if ' up ' in line)
        self.assertLess(pull, stop)
        self.assertLess(stop, up)
        self.assertIn('--no-build --pull never --wait', commands[up])

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
        curl_log = self.base / 'curl.log'
        marker = self.base / 'python-ran'
        for name, body in [('curl',
                'printf "%s\\n" "$*" > "$CURL_LOG"\n'
                'while (($#)); do if [[ "$1" == --output ]]; then output="$2"; shift; fi; shift; done\n'
                'cp -- "$FIXTURE_ARCHIVE" "$output"'),
                ('python3', 'touch -- "$PYTHON_MARKER"')]:
            target = self.bin / name
            target.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n', newline='\n')
            target.chmod(0o755)
        bin_path = self.bin.as_posix()
        if os.name == 'nt':
            bin_path = '/' + bin_path[0].lower() + bin_path[2:]
        env = dict(os.environ, CURL_LOG=curl_log.as_posix(), FIXTURE_ARCHIVE=fixture.as_posix(),
                   PYTHON_MARKER=marker.as_posix())
        result = subprocess.run([BASH, '-c',
            'export PATH="$1:$PATH"; bash "$2" install "$3" v1.0.3 "$4"', 'test',
            bin_path, (COMPOSE / 'download.sh').as_posix(),
            (self.base / 'new').as_posix(), '0' * 64], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/v1.0.3/'
                      'xpayincus-dashboard-v1.0.3-compose.tar.gz', curl_log.read_text())
        self.assertIn("--proto =https --proto-redir =https", curl_log.read_text())
        self.assertFalse(marker.exists())
        self.assertFalse((self.base / 'new/.bootstrap/current').exists())
        self.assertEqual(list((self.base / 'new/.bootstrap').glob('.staging.*')), [])


if __name__ == '__main__':
    unittest.main()
