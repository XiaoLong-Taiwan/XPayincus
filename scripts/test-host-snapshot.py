import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('host_snapshot', ROOT / 'XPayincus-Agent/components/host-snapshot.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.target = self.directory / 'rfw-status.json'
        self.target.write_text('previous')

    def result(self, data):
        return subprocess.CompletedProcess([], 0, data)

    def test_publish_bounds_and_readonly_metadata(self):
        with patch.object(snapshot.subprocess, 'run', return_value=self.result(b'{"schemaVersion":1}')) as run:
            snapshot.publish('rfw', self.directory)
        value = json.loads(self.target.read_text())
        self.assertTrue(value['readOnly'])
        self.assertIsInstance(value['collectedAtUnix'], int)
        self.assertEqual(run.call_args.args[0][-1], 'status')
        self.assertEqual(list(self.directory.iterdir()), [self.target])
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)

    def test_failed_collection_preserves_previous(self):
        with patch.object(snapshot.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['rfw'])):
            with self.assertRaises(subprocess.CalledProcessError):
                snapshot.publish('rfw', self.directory)
        self.assertEqual(self.target.read_text(), 'previous')

    def test_invalid_or_oversized_json_preserves_previous(self):
        for data in (b'invalid', b'[]', b'{"schemaVersion":2}', b' ' * 65537):
            with patch.object(snapshot.subprocess, 'run', return_value=self.result(data)):
                with self.assertRaises(ValueError):
                    snapshot.publish('rfw', self.directory)
            self.assertEqual(self.target.read_text(), 'previous')

    def test_failed_replace_preserves_previous_and_cleans_temporary(self):
        with patch.object(snapshot.subprocess, 'run', return_value=self.result(b'{"schemaVersion":1}')):
            with patch.object(snapshot.os, 'replace', side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    snapshot.publish('rfw', self.directory)
        self.assertEqual(self.target.read_text(), 'previous')
        self.assertEqual(list(self.directory.iterdir()), [self.target])

    def test_zfs_invocation_is_readonly_collector(self):
        with patch.object(snapshot.subprocess, 'run', return_value=self.result(b'{"schemaVersion":1}')) as run:
            snapshot.publish('zfs', self.directory)
        self.assertEqual(Path(run.call_args.args[0][1]).name, 'zfs-status.py')
        self.assertTrue((self.directory / 'zfs-status.json').is_file())


if __name__ == '__main__':
    unittest.main()
