import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compose_operations', ROOT / 'XPayincus/deploy/compose/operations.py')
operations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operations)


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def export(self):
        contents = {
            'database.dump': b'fixture archive',
            'source/legacy.env': b'FRONTEND_URL=https://pay.example.org\nADMIN_FRONTEND_URL=https://admin.example.org\nDATABASE_URL=postgresql://private\n',
            'source/schema.prisma': b'fixture schema',
            'secrets/encryption_key': b'original-key',
            'secrets/jwt_secret': b'original-jwt',
            'secrets/cookie_secret': b'original-cookie',
            'secrets/admin_password': b'original-password',
        }
        files = []
        for name, content in contents.items():
            file = self.base / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
            files.append({'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        manifest = {'format': 'incudal-legacy-host-export-v1', 'databaseFormat': 'PostgreSQL custom', 'sourceStopped': False, 'files': files}
        (self.base / 'manifest.json').write_text(json.dumps(manifest))
        (self.base / 'COMPLETE').write_text('complete')
        return argparse.Namespace(export=str(self.base), target_schema=str(self.base / 'source/schema.prisma'))

    def test_inventory_schema_and_secret_mapping_do_not_claim_cutover_ready(self):
        options = self.export()
        before = {str(file): file.read_bytes() for file in self.base.rglob('*') if file.is_file()}
        with patch.object(operations, 'command', return_value=subprocess.CompletedProcess([], 0, '_prisma_migrations')) as run:
            report = operations.migration_plan(options)
        self.assertTrue(report['exportComplete'])
        self.assertFalse(report['switchReady'])
        self.assertEqual(run.call_args.args[0][:2], ['pg_restore', '--list'])
        self.assertEqual(before, {name: Path(name).read_bytes() for name in before})
        self.assertNotIn('original-key', json.dumps(report))
        self.assertNotIn('postgresql://private', json.dumps(report))
        self.assertTrue(any(item['name'] == 'schema-comparison' and item['status'] == 'pass' for item in report['checks']))

    def test_corrupt_archive_and_incomplete_marker_rejected(self):
        options = self.export()
        (self.base / 'database.dump').write_bytes(b'tampered')
        (self.base / 'INCOMPLETE').write_text('interrupted')
        with patch.object(operations, 'command', return_value=None):
            report = operations.migration_plan(options)
        self.assertFalse(report['exportComplete'])
        self.assertTrue(any(item['status'] == 'fail' for item in report['checks']))

    def test_manifest_traversal_and_duplicate_paths_rejected(self):
        options = self.export()
        file = self.base / 'manifest.json'
        manifest = json.loads(file.read_text())
        for entry in [dict(manifest['files'][0], path='../escape'), manifest['files'][0]]:
            file.write_text(json.dumps(dict(manifest, files=manifest['files'] + [entry])))
            with self.assertRaises(ValueError):
                operations.migration_plan(options)

    def test_three_compose_entries_and_release_override(self):
        with patch.dict(os.environ, {}, clear=True):
            for entry in ('docker-compose.yml', 'compose.yaml', 'compose.yaml:compose.release.yaml'):
                args = operations.compose_args(self.base, {'COMPOSE_FILE': entry})
                self.assertEqual(args.count('--file'), len(entry.split(':')))
            (self.base / 'compose.release.yaml').write_text('{}')
            args = operations.compose_args(self.base, {'COMPOSE_FILE': 'docker-compose.yml'})
            self.assertNotIn(str(self.base / 'docker-compose.yml'), args)
            self.assertIn(str(self.base / 'compose.release.yaml'), args)

    def test_origin_and_env_input_are_never_executed(self):
        file = self.base / '.env'
        file.write_text('JWT_SECRET=$(touch forbidden)')
        with self.assertRaises(ValueError):
            operations.env_values(file)
        report = {'checks': []}
        operations.origins(report, {'FRONTEND_URL': 'https://same.example', 'ADMIN_FRONTEND_URL': 'https://same.example'})
        self.assertTrue(any(item['name'] == 'dual-origin' and item['status'] == 'fail' for item in report['checks']))
        self.assertFalse((self.base / 'forbidden').exists())

    def test_recovery_without_journal_does_not_create_state(self):
        report = operations.recovery(argparse.Namespace(base=str(self.base)))
        self.assertFalse(report['automaticDatabaseRollback'])
        self.assertFalse((self.base / '.state').exists())

    def test_native_doctor_queries_readonly_without_password_in_arguments(self):
        (self.base / '.env').write_text('FRONTEND_URL=https://pay.example.org\nADMIN_FRONTEND_URL=https://admin.example.org\nDATABASE_URL=postgresql://incudal:private-password@localhost/incudal\n')
        calls = []

        def command(args, env=None):
            calls.append((args, env))
            return subprocess.CompletedProcess(args, 0, 'node /opt/incudal/server/dist/app.js\n' if args[0] == 'ps' else 'clean\n')

        options = argparse.Namespace(base=str(self.base), mode='native', env_file=None, proxy='external')
        with patch.object(operations, 'command', side_effect=command), patch.object(operations, 'build_opener', side_effect=OSError):
            report = operations.doctor(options)
        query = next(call for call in calls if call[0][0] == 'psql')
        self.assertIn('default_transaction_read_only=on', query[1]['PGOPTIONS'])
        self.assertNotIn('private-password', str(query[0]))
        self.assertNotIn('private-password', json.dumps(report))
        self.assertFalse((self.base / '.state').exists())


if __name__ == '__main__':
    unittest.main()
