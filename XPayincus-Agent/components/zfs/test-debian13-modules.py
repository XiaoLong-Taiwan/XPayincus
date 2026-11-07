import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "verifier", Path(__file__).with_name("verify-debian13-modules.py")
)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
KERNEL = "6.12.107+deb13-cloud-amd64"


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.stage = Path(self.temp.name)
        (self.stage / "modules").mkdir()
        data = bytearray(64)
        data[:6] = b"\x7fELF\x02\x01"
        data[18:20] = b"\x3e\x00"
        self.module = self.stage / "modules/zfs.ko"
        self.module.write_bytes(data)
        env = {
            "TARGET_KERNEL": KERNEL,
            "TARGET_ARCH": "amd64",
            "ZFS_PACKAGE_VERSION": "2.3.2-2",
            "HEADER_PACKAGE": f"linux-headers-{KERNEL}",
            "HEADER_VERSION": "6.12.107-1",
            "SOURCE_SHA256": "a" * 64,
            "SOURCE_COMMIT": "b" * 40,
        }
        self.environment = patch.dict(os.environ, env)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def info(self, module, field):
        return "2.3.2-2" if field == "version" else f"{KERNEL} SMP preempt mod_unload modversions "

    def test_metadata_uses_module_version_and_hash(self):
        with patch.object(verifier, "modinfo", self.info):
            verifier.verify(self.stage)
        metadata = json.loads((self.stage / "metadata.json").read_text())
        self.assertEqual(metadata["zfsVersion"], "2.3.2-2")
        self.assertFalse(metadata["loadTested"])
        self.assertEqual(metadata["modules"][0]["sha256"], verifier.hashlib.sha256(self.module.read_bytes()).hexdigest())

    def test_rejects_wrong_vermagic(self):
        with patch.object(verifier, "modinfo", side_effect=lambda module, field: "2.3.2-2" if field == "version" else "6.12.1 SMP"):
            with self.assertRaisesRegex(ValueError, "vermagic mismatch"):
                verifier.verify(self.stage)
        self.assertFalse((self.stage / "metadata.json").exists())

    def test_rejects_wrong_elf_architecture(self):
        data = bytearray(self.module.read_bytes())
        data[18:20] = b"\xb7\x00"
        self.module.write_bytes(data)
        with patch.object(verifier, "modinfo", self.info):
            with self.assertRaisesRegex(ValueError, "amd64 ELF"):
                verifier.verify(self.stage)

    def test_rejects_missing_zfs(self):
        self.module.rename(self.stage / "modules/spl.ko")
        with self.assertRaisesRegex(ValueError, "Missing"):
            verifier.verify(self.stage)

    def test_rejects_empty_version(self):
        with patch.object(verifier, "modinfo", return_value=""):
            with self.assertRaisesRegex(ValueError, "actual ZFS version"):
                verifier.verify(self.stage)

    def test_rejects_mixed_module_versions(self):
        (self.stage / "modules/spl.ko").write_bytes(self.module.read_bytes())
        with patch.object(verifier, "modinfo", side_effect=lambda module, field: "0.0.0" if module.name == "spl.ko" and field == "version" else self.info(module, field)):
            with self.assertRaisesRegex(ValueError, "version mismatch"):
                verifier.verify(self.stage)


if __name__ == "__main__":
    unittest.main()
