import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def modinfo(module, field):
    return subprocess.check_output(
        ["modinfo", "-F", field, str(module)], text=True
    ).strip()


def verify(stage):
    kernel = os.environ["TARGET_KERNEL"]
    if os.environ["TARGET_ARCH"] != "amd64":
        raise ValueError("Only amd64 is supported")
    if not re.fullmatch(r"6\.12\.[0-9]{1,6}\+deb13-cloud-amd64", kernel):
        raise ValueError("Kernel outside allowlist")
    modules = sorted((stage / "modules").glob("*.ko"))
    if not modules or not (stage / "modules/zfs.ko").is_file():
        raise ValueError("Missing built ZFS modules")
    zfs_version = modinfo(stage / "modules/zfs.ko", "version")
    if not re.fullmatch(r"[0-9][0-9A-Za-z.+_~-]{0,100}", zfs_version):
        raise ValueError("Invalid actual ZFS version")
    records = []
    for module in modules:
        data = module.read_bytes()
        if module.is_symlink() or data[:6] != b"\x7fELF\x02\x01" or data[18:20] != b"\x3e\x00":
            raise ValueError(f"Not an amd64 ELF module: {module.name}")
        vermagic = modinfo(module, "vermagic")
        if not vermagic.split() or vermagic.split()[0] != kernel:
            raise ValueError(f"Kernel vermagic mismatch: {module.name}")
        version = modinfo(module, "version")
        if version != zfs_version:
            raise ValueError(f"ZFS module version mismatch: {module.name}")
        records.append({
            "path": f"modules/{module.name}",
            "version": version,
            "vermagic": vermagic,
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    metadata = {
        "schemaVersion": 1,
        "distribution": "debian-13",
        "kernel": kernel,
        "architecture": os.environ["TARGET_ARCH"],
        "zfsVersion": zfs_version,
        "zfsPackageVersion": os.environ["ZFS_PACKAGE_VERSION"],
        "sourcePackageSha256": os.environ["SOURCE_SHA256"],
        "headerPackage": os.environ["HEADER_PACKAGE"],
        "headerPackageVersion": os.environ["HEADER_VERSION"],
        "sourceCommit": os.environ["SOURCE_COMMIT"],
        "moduleSigning": "unsigned",
        "loadTested": False,
        "modules": records,
    }
    (stage / "metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    (stage / "SHA256SUMS").write_text(
        "".join(f"{item['sha256']}  {item['path']}\n" for item in records),
        encoding="utf-8",
    )


if __name__ == "__main__":
    verify(Path(sys.argv[1]))
