import importlib.util
import json
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
spec = importlib.util.spec_from_file_location('compose_update', COMPOSE / 'update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name) / 'deployment'
        self.base.mkdir()
        self.official = Path(self.temporary.name) / 'official'
        self.official.mkdir()
        for name in update.FILES:
            content = (COMPOSE / name).read_bytes() if (COMPOSE / name).exists() else json.dumps({
                'services': {service: {'image': f'ghcr.io/xiaolong-taiwan/{image}:v1.0.5'}
                             for service, image in [('api', 'xpayincus-api'), ('user', 'xpayincus-panel-web'),
                                                    ('admin', 'xpayincus-panel-web')]}}).encode()
            (self.base / name).write_bytes(content)
            (self.official / name).write_bytes(content)
        (self.base / '.env').write_text('COMPOSE_PROFILES=\nCOMPOSE_FILE=docker-compose.yml\n')
        self.commands = []

    def container(self, service):
        expected = {'db': {'/var/lib/postgresql/data': 'data/postgres'},
                    'api': {'/opt/incudal/server/certs': 'certs', '/opt/incudal/config': 'config',
                            '/opt/incudal/backups': 'backups', '/deployment/.env': '.env'}}[service]
        return {'Id': service, 'Config': {'Labels': {
            'com.docker.compose.service': service,
            'com.docker.compose.project': 'incudal-panel',
            'com.docker.compose.project.working_dir': str(self.base),
            'com.docker.compose.project.config_files': str(self.base / 'docker-compose.yml')}},
            'State': {'Running': True}, 'Mounts': [
                {'Destination': target, 'Source': str(self.base / source), 'Type': 'bind'}
                for target, source in expected.items()]}

    def test_standard_manual_files_and_settings(self):
        with patch.dict(os.environ, {}, clear=True):
            update.settings(self.base)
        update.validate_files(self.base, self.official)
        self.assertEqual(update.current_version(self.base), 'v1.0.5')
        for name in ['compose.yaml', 'origin-entrypoint.sh', 'panel.sh']:
            with self.subTest(name=name):
                original = (self.base / name).read_bytes()
                (self.base / name).write_bytes(original + b'custom')
                with self.assertRaises(SystemExit):
                    update.validate_files(self.base, self.official)
                (self.base / name).write_bytes(original)

    def test_conflicting_settings_rejected_without_execution(self):
        for setting in ['COMPOSE_PROJECT_NAME=private', 'COMPOSE_FILE=custom.yaml',
                        'COMPOSE_PROFILES=nginx,cloudflare', 'COMPOSE_ENV_FILES=private.env',
                        'COMPOSE_FILE=$(touch forbidden)']:
            (self.base / '.env').write_text(setting)
            with patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
                update.settings(self.base)
        (self.base / '.env').write_text('COMPOSE_FILE=compose.yaml\n')
        with patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': 'other'}, clear=True), self.assertRaises(SystemExit):
            update.settings(self.base)
        (self.base / 'compose.override.yaml').write_text('custom')
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            update.settings(self.base)

    def test_container_identity_and_mount_conflicts(self):
        containers = [self.container('db'), self.container('api')]
        with patch.object(update, 'run', side_effect=[subprocess.CompletedProcess([], 0, 'db api'),
                                                     subprocess.CompletedProcess([], 0, json.dumps(containers))]):
            update.validate_containers(self.base)
        for mutation in ['project', 'directory', 'files', 'volume', 'stopped', 'replica']:
            containers = [self.container('db'), self.container('api')]
            labels = containers[1]['Config']['Labels']
            if mutation == 'project':
                labels['com.docker.compose.project'] = 'private'
            elif mutation == 'directory':
                labels['com.docker.compose.project.working_dir'] = '/other'
            elif mutation == 'files':
                labels['com.docker.compose.project.config_files'] = str(self.base / 'custom.yaml')
            elif mutation == 'volume':
                containers[0]['Mounts'][0]['Type'] = 'volume'
            elif mutation == 'stopped':
                containers[1]['State']['Running'] = False
            else:
                replica = self.container('api')
                replica['Id'] = 'replica'
                containers.append(replica)
            with self.subTest(mutation=mutation), patch.object(update, 'run', side_effect=[
                    subprocess.CompletedProcess([], 0, 'db api'),
                    subprocess.CompletedProcess([], 0, json.dumps(containers))]), self.assertRaises(SystemExit):
                update.validate_containers(self.base)

    def test_checksum_is_unique_and_pinned(self):
        def fetch(url, target):
            self.assertEqual(url, update.RELEASES + '/v1.0.5/SHA256SUMS')
            target.write_text(self.sums)
        entry = 'a' * 64 + '  xpayincus-dashboard-v1.0.5-compose.tar.gz\n'
        with patch.object(update, 'fetch', side_effect=fetch):
            self.sums = entry
            self.assertEqual(update.checksum('v1.0.5', self.base), 'a' * 64)
            for invalid in [entry * 2, entry.replace('v1.0.5', 'v1.0.4'), entry.replace('a' * 64, 'bad')]:
                self.sums = invalid
                with self.assertRaises(SystemExit):
                    update.checksum('v1.0.5', self.base)

    def test_resolve_checks_pinned_registry_digest_without_latest(self):
        (self.base / '.state').mkdir()
        digest = 'sha256:' + 'a' * 64
        for matching in [False, True]:
            commands = []

            def run(args, **kwargs):
                commands.append(args)
                return subprocess.CompletedProcess(args, 0, json.dumps({'digest': digest}))

            def inspect(args, **kwargs):
                self.assertEqual(args[-1], '{{json .RepoDigests}}')
                reference = args[3].rsplit(':', 1)[0]
                return subprocess.CompletedProcess(args, 0, json.dumps([reference + '@' + digest] if matching else []))

            with patch.object(update, 'run', side_effect=run), \
                    patch.object(update.subprocess, 'run', side_effect=inspect) as inspect_mock, \
                    patch.object(update, 'fetch') as fetch, patch.dict(os.environ, {}, clear=True):
                update.resolve_images(self.base, self.base / 'compose.yaml')
                fetch.assert_not_called()
            images = ['ghcr.io/xiaolong-taiwan/xpayincus-api:v1.0.5',
                      'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.5']
            self.assertEqual(commands, [
                ['docker', 'buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}']
                for image in images])
            self.assertEqual(inspect_mock.call_count, len(images))
            self.assertEqual((self.base / '.state/pull-required').exists(), not matching)

    def test_resolve_rejects_custom_images_and_invalid_digest(self):
        (self.base / '.state').mkdir()
        with patch.object(update, 'run', return_value=subprocess.CompletedProcess([], 0, '{"digest":"bad"}')), \
                patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            update.resolve_images(self.base, self.base / 'compose.yaml')
        override = self.base / 'compose.release.yaml'
        override.write_text(override.read_text().replace('ghcr.io/xiaolong-taiwan/', 'private/'))
        with patch.object(update, 'run') as run, patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            update.resolve_images(self.base, self.base / 'compose.yaml')
        run.assert_not_called()

    def run_flow(self, failure=None, version='v1.0.5', prerelease=False):
        def fetch(url, target):
            self.commands.append(('fetch', url))
            target.write_text(json.dumps({'tag_name': version, 'draft': False, 'prerelease': prerelease}))

        def run(args, **kwargs):
            self.commands.append(tuple(args))
            operation = args[-2] if 'export' in args else args[-1]
            if failure == operation:
                raise subprocess.CalledProcessError(1, args)
            if operation == 'export':
                Path(args[-1]).write_bytes(b'fixture custom dump')
            return subprocess.CompletedProcess(args, 0, '')

        def stage(base, selected, scratch, name):
            self.commands.append(('stage', selected))
            return self.official, 'a' * 64

        with patch.object(sys, 'argv', ['update', str(self.base)]), \
                patch.object(update, 'fetch', side_effect=fetch), \
                patch.object(update, 'stage', side_effect=stage), \
                patch.object(update, 'validate_containers'), \
                patch.object(update, 'activate', side_effect=lambda *args: self.commands.append(('activate',))), \
                patch.object(update, 'run', side_effect=run), patch.dict(os.environ, {}, clear=True):
            try:
                update.main()
            except (SystemExit, subprocess.CalledProcessError):
                if not failure and version == 'v1.0.5' and not prerelease:
                    raise
            else:
                self.assertFalse(failure)

    def test_update_order_and_private_preservation(self):
        for name in ['secrets/key', 'config/local', 'data/postgres/PG_VERSION', 'source/custom', 'tls/key']:
            target = self.base / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'private\x00$(do not execute)')
        private = {str(file): file.read_bytes() for file in self.base.rglob('*') if file.is_file()}
        self.run_flow()
        export = next(i for i, command in enumerate(self.commands) if 'export' in command)
        activate = self.commands.index(('activate',))
        up = next(i for i, command in enumerate(self.commands) if command[-1] == 'up')
        self.assertLess(export, activate)
        self.assertLess(activate, up)
        self.assertEqual(private, {name: Path(name).read_bytes() for name in private})
        self.assertTrue(list((self.base / 'backups').glob('before-update-*/panel.dump')))

    def test_backup_failure_never_activates_or_starts(self):
        self.run_flow(failure='export')
        self.assertNotIn(('activate',), self.commands)
        self.assertFalse(any(command[-1] == 'up' for command in self.commands))

    def test_up_failure_retains_backup(self):
        self.run_flow(failure='up')
        self.assertTrue(list((self.base / 'backups').glob('before-update-*/panel.dump')))

    def test_downgrade_and_prerelease_rejected_before_download(self):
        for version, prerelease in [('v1.0.4', False), ('v01.0.5', False), ('main', False), ('v1.0.5', True)]:
            self.commands = []
            self.run_flow(version=version, prerelease=prerelease)
            self.assertFalse(any(command[0] == 'stage' for command in self.commands))

    @unittest.skipIf(os.name == 'nt', '需要 Linux 原生符號連結')
    def test_manual_adoption_and_managed_switch(self):
        store = self.base / '.bootstrap'
        store.mkdir()
        scratch = self.base / 'scratch'
        scratch.mkdir()
        backup = self.base / 'backup'
        backup.mkdir()
        for name in update.FILES:
            shutil.copyfile(self.base / name, backup / name)
        for suffix in ['first', 'second']:
            target = self.base / suffix
            release = target / '.bootstrap' / ('release-' + 'a' * 64 + '-' + suffix)
            release.mkdir(parents=True)
            for name in update.FILES:
                shutil.copyfile(self.official / name, release / name)
            (target / '.bootstrap/current').symlink_to(release.name)
            update.activate(self.base, target, scratch, backup)
            for name in update.FILES:
                self.assertEqual(os.readlink(self.base / name), f'.bootstrap/current/{name}')
                self.assertEqual((self.base / name).read_bytes(), (self.official / name).read_bytes())
            update.validate_files(self.base, self.official)
            if suffix == 'first':
                (self.base / 'update.py').unlink()
                (self.base / '.bootstrap/current/update.py').unlink()
                (self.official / 'update.py').unlink()
                update.validate_files(self.base, self.official)
                shutil.copyfile(COMPOSE / 'update.py', self.official / 'update.py')
        self.assertEqual(len(list(store.glob('release-*'))), 2)

    @unittest.skipIf(os.name == 'nt', '需要 Linux flock 與 fd 繼承')
    def test_inherited_lock_allows_children_and_rejects_competitor(self):
        import fcntl
        state = self.base / '.state'
        state.mkdir()
        with (state / 'operation.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.dup2(lock.fileno(), 9)
            self.addCleanup(os.close, 9)
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                update.run(['bash', str(self.base / 'panel.sh'), 'init'], capture_output=True, text=True)
            self.assertIn('init 需要', caught.exception.stderr)
            self.assertNotIn('另一個', caught.exception.stderr)
            competitor = subprocess.run(['flock', '-n', str(state / 'operation.lock'), 'true'])
            self.assertNotEqual(competitor.returncode, 0)


if __name__ == '__main__':
    unittest.main()
