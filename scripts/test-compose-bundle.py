import ast
import hashlib
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
VERSION = (ROOT / 'VERSION').read_text().strip()


class ComposeBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'source'
        self.output = self.base / 'output'
        self.source.mkdir()
        shutil.copyfile(ROOT / 'VERSION', self.source / 'VERSION')
        self.compose = self.source / 'XPayincus/deploy/compose'
        shutil.copytree(COMPOSE, self.compose)
        self.override = {'services': {name: {'image': f'ghcr.io/xiaolong-taiwan/xpayincus-{suffix}:{VERSION}'}
                                     for name, suffix in [('api', 'api'), ('user', 'panel-web'), ('admin', 'panel-web')]}}
        (self.compose / 'compose.release.yaml').write_text(json.dumps(self.override))

    def package(self, success=True):
        result = subprocess.run(['node', str(ROOT / 'scripts/package-compose-bundle.mjs'),
                                 str(self.source), str(self.output)], capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.output / f'xpayincus-compose-{VERSION}.tar.gz').exists())
        return self.output / f'xpayincus-compose-{VERSION}.tar.gz'

    def test_real_archive_matches_download_validator(self):
        (self.compose / '.env').write_text('fixture-private')
        (self.compose / 'unexpected.txt').write_text('excluded')
        (self.source / 'XPayincus/server').mkdir()
        (self.source / 'XPayincus/server/app.ts').write_text('excluded')
        archive_path = self.package()
        script = (COMPOSE / 'download.sh').read_text(encoding='utf-8')
        code = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        tree = ast.parse(code)
        files = next(ast.literal_eval(node.value) for node in tree.body
                     if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'files' for target in node.targets))
        expected = {'VERSION', *(f'XPayincus/deploy/compose/{name}' for name in (*files, 'compose.release.yaml', 'update.py'))}
        with tarfile.open(archive_path) as archive:
            self.assertEqual({member.name for member in archive}, expected)
            self.assertEqual(len(archive.getmembers()), 18)
            for member in archive:
                self.assertTrue(member.isfile())
                self.assertGreater(member.size, 0)
                self.assertLessEqual(member.size, 2097152)
                self.assertEqual(archive.extractfile(member).read(), (self.source / member.name).read_bytes())
        scratch = self.base / 'scratch'
        scratch.mkdir()
        shutil.copyfile(archive_path, scratch / 'source.tar.gz')
        destination = self.base / 'deployment'
        (destination / '.bootstrap').mkdir(parents=True)
        args = ['bootstrap', str(scratch), str(destination), 'install', VERSION,
                hashlib.sha256(archive_path.read_bytes()).hexdigest(), archive_path.name]

        def symlink(target, location):
            Path(location).write_text(target)

        with patch.object(sys, 'argv', args), patch('os.symlink', side_effect=symlink), patch('subprocess.run'):
            exec(compile(code, 'download-validator', 'exec'), {})
        receipt = json.loads(next((destination / '.bootstrap').glob('release-*/receipt.json')).read_text())
        self.assertEqual(receipt['artifact'], archive_path.name)
        self.assertEqual(receipt['sha256'], args[5])
        self.assertEqual(json.loads(next((destination / '.bootstrap').glob('release-*/compose.release.yaml')).read_text()), self.override)

    def test_missing_empty_oversized_version_and_override_rejected(self):
        target = self.compose / 'update.py'
        original = target.read_bytes()
        for content in [None, b'', b'x' * 2097153]:
            if content is None:
                target.unlink()
            else:
                target.write_bytes(content)
            self.package(False)
        target.write_bytes(original)
        (self.source / 'VERSION').write_text('v0.0.0')
        self.package(False)
        shutil.copyfile(ROOT / 'VERSION', self.source / 'VERSION')
        (self.compose / 'compose.release.yaml').write_text('{}')
        self.package(False)

    @unittest.skipIf(os.name == 'nt', 'Windows 符號連結需額外權限')
    def test_symlink_rejected(self):
        target = self.compose / 'update.py'
        target.unlink()
        target.symlink_to(COMPOSE / 'update.py')
        self.package(False)


if __name__ == '__main__':
    unittest.main()
