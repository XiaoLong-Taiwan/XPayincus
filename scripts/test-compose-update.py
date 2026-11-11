import importlib.util
import contextlib
import io
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
        update.JOURNAL, update.JOURNAL_DATA, update.PLAN_ONLY = None, {}, False
        self.addCleanup(setattr, update, 'JOURNAL', None)
        self.addCleanup(setattr, update, 'PLAN_ONLY', False)
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

    def run_flow(self, failure=None, version='v1.0.5', prerelease=False, plan=False):
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

        def activate(*args):
            if failure == 'activate':
                raise OSError('fixture switch failed')
            self.commands.append(('activate',))

        with patch.object(sys, 'argv', ['update', str(self.base)] + (['--plan'] if plan else [])), \
                patch.object(update, 'fetch', side_effect=fetch), \
                patch.object(update, 'stage', side_effect=stage), \
                patch.object(update, 'validate_containers'), \
                patch.object(update, 'activate', side_effect=activate), \
                patch.object(update, 'run', side_effect=run), patch.dict(os.environ, {}, clear=True):
            try:
                update.dispatch()
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

    def test_plan_never_backs_up_switches_or_writes_journal(self):
        self.run_flow(plan=True)
        self.assertNotIn(('activate',), self.commands)
        self.assertFalse(any('export' in command or command[-1] == 'up' for command in self.commands))
        self.assertFalse((self.base / '.state/update-journal.json').exists())

    def test_journal_success_and_failure_preserve_backup_evidence(self):
        self.run_flow()
        file = self.base / '.state/update-journal.json'
        data = json.loads(file.read_text())
        self.assertEqual(data['status'], 'complete')
        self.assertTrue(data['backupComplete'])
        self.assertTrue(data['activated'])
        self.assertEqual(data['backupSha256'], update.backup_digest(Path(data['backup']) / 'panel.dump'))
        self.commands = []
        self.run_flow(failure='up')
        data = json.loads(file.read_text())
        self.assertEqual(data['status'], 'failed')
        self.assertTrue(data['backupComplete'])
        self.assertTrue(list((self.base / '.state').glob('update-*.json')))

    def test_unfinished_journal_is_not_overwritten(self):
        state = self.base / '.state'
        state.mkdir()
        file = state / 'update-journal.json'
        original = '{"format":"incudal-update-journal-v1","status":"interrupted"}'
        file.write_text(original)
        with patch.object(sys, 'argv', ['update', str(self.base)]), self.assertRaises(SystemExit):
            update.dispatch()
        self.assertEqual(file.read_text(), original)

    def test_recovery_rejects_missing_backup_without_running_commands(self):
        state = self.base / '.state'
        state.mkdir()
        (state / 'update-journal.json').write_text(json.dumps({
            'format': 'incudal-update-journal-v1', 'status': 'interrupted', 'backupComplete': False}))
        with patch.object(update, 'run') as run, self.assertRaises(SystemExit):
            update.recover_update(self.base, '--resume-up')
        run.assert_not_called()

    def test_backup_failure_never_activates_or_starts(self):
        self.run_flow(failure='export')
        self.assertNotIn(('activate',), self.commands)
        self.assertFalse(any(command[-1] == 'up' for command in self.commands))

    def test_compose_validation_failure_never_backs_up_or_activates(self):
        self.run_flow(failure='--quiet')
        self.assertNotIn(('activate',), self.commands)
        self.assertFalse(any('export' in command or command[-1] == 'up' for command in self.commands))

    def test_download_failure_never_activates(self):
        with patch.object(update, 'run', side_effect=subprocess.CalledProcessError(22, ['bash'])), \
                self.assertRaises(SystemExit) as caught:
            update.fetch(f'https://api.github.com/repos/{update.REPOSITORY}/releases/latest', self.base / 'metadata')
        self.assertIn('最新正式 Release 查詢', str(caught.exception))
        self.assertIn('未切換', str(caught.exception))

    def test_up_failure_retains_backup(self):
        self.run_flow(failure='up')
        self.assertTrue(list((self.base / 'backups').glob('before-update-*/panel.dump')))

    def test_switch_failure_retains_backup_and_does_not_start(self):
        self.run_flow(failure='activate')
        self.assertTrue(list((self.base / 'backups').glob('before-update-*/panel.dump')))
        self.assertFalse(any(command[-1] == 'up' for command in self.commands))

    @unittest.skipIf(os.name == 'nt', '需要 Linux 原生符號連結')
    def test_manual_switch_failure_restores_original_files(self):
        store = self.base / '.bootstrap'
        store.mkdir()
        scratch = self.base / 'scratch'
        scratch.mkdir()
        backup = self.base / 'backup'
        backup.mkdir()
        target = self.base / 'target'
        release = target / '.bootstrap/release-fixture'
        release.mkdir(parents=True)
        (target / '.bootstrap/current').symlink_to(release.name)
        before = {name: (self.base / name).read_bytes() for name in update.FILES}
        for name, content in before.items():
            (backup / name).write_bytes(content)
            (release / name).write_bytes(content)
        replace = os.replace

        def fail_switch(source, destination):
            if Path(destination).name == 'panel.sh':
                raise OSError('fixture switch failed')
            return replace(source, destination)

        with patch.object(update.os, 'replace', side_effect=fail_switch), self.assertRaises(OSError):
            update.activate(self.base, target, scratch, backup)
        self.assertEqual(before, {name: (self.base / name).read_bytes() for name in before})
        self.assertFalse((store / 'current').exists())

    def test_downgrade_and_prerelease_rejected_before_download(self):
        for version, prerelease in [('v1.0.4', False), ('v01.0.5', False), ('main', False), ('v1.0.5', True)]:
            self.commands = []
            journal = self.base / '.state/update-journal.json'
            if journal.exists():
                journal.unlink()
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


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        code = (COMPOSE / 'download.sh').read_text(encoding='utf-8').split("<<'DOWNLOAD_PY'\n", 1)[1].split('\nDOWNLOAD_PY\n', 1)[0]
        self.module = {'__name__': 'download_fixture'}
        exec(compile(code, 'download-fixture', 'exec'), self.module)
        self.calls = []
        self.responses = []
        self.target = self.base / 'download'
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def curl(self, args, **kwargs):
        self.calls.append((args, kwargs))
        status, headers, body = self.responses.pop(0)
        Path(args[args.index('--dump-header') + 1]).write_text('HTTP/2 ' + str(status) + '\n' + headers)
        Path(args[args.index('--output') + 1]).write_bytes(body)
        return subprocess.CompletedProcess(args, 0, str(status), 'untrusted signed query must not print')

    def download(self, url=None):
        with patch('subprocess.run', side_effect=self.curl):
            self.module['download'](url or self.module['API'] + '/latest', self.target, 2097152, 'fixture 階段')

    def test_rate_limit_and_permission_diagnostics(self):
        for status, headers, expected in [(403, 'x-ratelimit-remaining: 0\nx-ratelimit-reset: 123\n', '限流'),
                                           (403, '', '權限'), (401, '', '認證失敗'), (429, 'retry-after: 60\n', '限流')]:
            self.responses = [(status, headers, b'private response')]
            with self.assertRaises(self.module['DownloadError']) as caught:
                self.download()
            message = str(caught.exception)
            self.assertIn(expected, message)
            self.assertIn('HTTP ' + str(status), message)
            self.assertIn('fixture 階段', message)
            self.assertNotIn('private response', message)
            self.assertFalse(self.target.exists())

    def test_token_only_in_stdin_for_exact_api_origin_and_stripped_on_redirect(self):
        token = self.base / 'token'
        token.write_text('fixture_secret')
        token.chmod(0o600)
        os.environ['XPAYINCUS_GITHUB_TOKEN_FILE'] = str(token)
        self.responses = [(302, 'location: https://release-assets.githubusercontent.com/asset?signature=secret\n', b''), (200, '', b'asset')]
        self.download()
        self.assertIn('fixture_secret', self.calls[0][1]['input'])
        self.assertEqual(self.calls[1][1]['input'], '')
        self.assertTrue(all('fixture_secret' not in str(args) for args, kwargs in self.calls))
        self.assertNotIn('--location', self.calls[0][0])
        self.assertEqual(self.target.read_bytes(), b'asset')

    def test_untrusted_redirect_rejected_without_token_leak(self):
        self.responses = [(302, 'location: https://evil.example/path?signature=secret\n', b'')]
        with self.assertRaises(self.module['DownloadError']) as caught:
            self.download()
        self.assertNotIn('signature', str(caught.exception))
        self.assertEqual(len(self.calls), 1)

    def test_invalid_token_is_rejected_before_network(self):
        token = self.base / 'token'
        token.write_text('fixture\nheader-injection')
        token.chmod(0o600)
        os.environ['XPAYINCUS_GITHUB_TOKEN_FILE'] = str(token)
        with self.assertRaises(self.module['DownloadError']):
            self.download()
        self.assertEqual(self.calls, [])

    def test_transport_failure_is_sanitized_and_keeps_previous_file(self):
        self.target.write_bytes(b'previous')
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([], 28, '000', 'token signed-query')), \
                self.assertRaises(self.module['DownloadError']) as caught:
            self.module['download'](self.module['API'] + '/latest', self.target, 1024, 'fixture')
        self.assertIn('curl exit=28', str(caught.exception))
        self.assertNotIn('signed-query', str(caught.exception))
        self.assertEqual(self.target.read_bytes(), b'previous')

    def test_official_asset_fallback_is_pinned_and_does_not_authenticate_browser_url(self):
        version = 'v1.0.8'
        metadata = {'tag_name': version, 'draft': False, 'prerelease': False,
                    'assets': [{'name': 'SHA256SUMS', 'id': 123}]}
        self.responses = [(403, '', b'blocked'), (200, '', json.dumps(metadata).encode()), (200, '', b'checksums')]
        with contextlib.redirect_stderr(io.StringIO()):
            self.download(self.module['RELEASES'] + version + '/SHA256SUMS')
        self.assertEqual(self.calls[0][1]['input'], '')
        self.assertEqual(self.calls[1][0][-1], self.module['API'] + '/tags/' + version)
        self.assertEqual(self.calls[2][0][-1], self.module['API'] + '/assets/123')
        self.assertEqual(self.target.read_bytes(), b'checksums')

    def test_fallback_rejects_wrong_version_and_missing_asset(self):
        for metadata in [{'tag_name': 'v0.0.1', 'draft': False, 'prerelease': False},
                         {'tag_name': 'v1.0.8', 'draft': False, 'prerelease': False, 'assets': []}]:
            self.responses = [(403, '', b''), (200, '', json.dumps(metadata).encode())]
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(self.module['DownloadError']):
                self.download(self.module['RELEASES'] + 'v1.0.8/SHA256SUMS')
            self.assertFalse(self.target.exists())

    def test_http_error_removes_query_and_preserves_existing_target(self):
        self.target.write_bytes(b'previous')
        self.responses = [(302, 'location: https://release-assets.githubusercontent.com/file?signature=secret\n', b''), (403, '', b'private')]
        with self.assertRaises(self.module['DownloadError']) as caught:
            self.download()
        self.assertNotIn('signature', str(caught.exception))
        self.assertEqual(self.target.read_bytes(), b'previous')

    def test_latest_resolves_once_and_pins_minimal_bundle_checksum(self):
        version = 'v1.0.8'
        artifact = f'xpayincus-compose-{version}.tar.gz'
        metadata = {'tag_name': version, 'draft': False, 'prerelease': False, 'assets': [{'name': artifact}]}
        self.responses = [(200, '', json.dumps(metadata).encode()), (200, '', ('a' * 64 + '  ' + artifact + '\n').encode())]
        with patch('subprocess.run', side_effect=self.curl):
            self.assertEqual(self.module['resolve']('latest'), version + ' ' + 'a' * 64)
        self.assertEqual([args[-1] for args, kwargs in self.calls], [self.module['API'] + '/latest', self.module['RELEASES'] + version + '/SHA256SUMS'])

    def test_latest_rejects_prerelease_missing_bundle_and_duplicate_checksum(self):
        artifact = 'xpayincus-compose-v1.0.8.tar.gz'
        valid = {'tag_name': 'v1.0.8', 'draft': False, 'prerelease': False, 'assets': [{'name': artifact}]}
        for metadata in [{**valid, 'prerelease': True}, {**valid, 'tag_name': 'main'}, {**valid, 'assets': []}]:
            self.responses = [(200, '', json.dumps(metadata).encode())]
            with patch('subprocess.run', side_effect=self.curl), self.assertRaises(self.module['DownloadError']):
                self.module['resolve']('latest')
        entry = ('a' * 64 + '  ' + artifact + '\n').encode()
        self.responses = [(200, '', json.dumps(valid).encode()), (200, '', entry * 2)]
        with patch('subprocess.run', side_effect=self.curl), self.assertRaises(self.module['DownloadError']):
            self.module['resolve']('latest')

    def test_minimal_bundle_403_uses_pinned_api_asset(self):
        artifact = 'xpayincus-compose-v1.0.8.tar.gz'
        metadata = {'tag_name': 'v1.0.8', 'draft': False, 'prerelease': False, 'assets': [{'name': artifact, 'id': 789}]}
        self.responses = [(403, '', b'blocked'), (200, '', json.dumps(metadata).encode()), (200, '', b'bundle')]
        with contextlib.redirect_stderr(io.StringIO()):
            self.download(self.module['RELEASES'] + 'v1.0.8/' + artifact)
        self.assertEqual(self.calls[-1][0][-1], self.module['API'] + '/assets/789')

    def test_target_stage_only_requests_minimal_bundle(self):
        def fetch(url, target):
            target.write_text('a' * 64 + '  xpayincus-compose-v1.0.8.tar.gz\n')
        destination = self.base / 'target'
        destination.mkdir()
        (destination / 'update.py').write_text('fixture')
        with patch.object(update, 'fetch', side_effect=fetch), patch.object(update, 'run') as run:
            update.stage(COMPOSE, 'v1.0.8', self.base, 'target')
        self.assertEqual(run.call_args.args[0][2], 'install-bundle')


if __name__ == '__main__':
    unittest.main()
