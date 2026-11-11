#!/usr/bin/env python3
"""Read-only ZFS snapshot; never loads modules or imports pools."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess


def command(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=15,
                                env={**os.environ, 'LC_ALL': 'C'})
        return {'ok': result.returncode == 0, 'output': result.stdout.strip(),
                'error': result.stderr.strip() if result.returncode else None}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'ok': False, 'output': '', 'error': str(error)}


def collect(next_kernel):
    kernel = os.uname().release
    loaded = Path('/sys/module/zfs').is_dir()
    version_file = Path('/sys/module/zfs/version')
    result = {'schemaVersion': 1, 'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'readOnly': True, 'kernel': kernel, 'moduleLoaded': loaded,
              'moduleVersion': version_file.read_text().strip() if version_file.exists() else None,
              'toolsVersion': command('zfs', 'version'), 'pools': [], 'errors': [],
              'nextKernel': {'kernel': next_kernel, 'ready': None, 'loadTested': False}}
    if next_kernel:
        magic = command('modinfo', '-k', next_kernel, '-F', 'vermagic', 'zfs')
        version = command('modinfo', '-k', next_kernel, '-F', 'version', 'zfs')
        dependencies = command('modprobe', '--show-depends', '--set-version', next_kernel, 'zfs')
        result['nextKernel'].update(ready=bool(magic['ok'] and magic['output'].split()
            and magic['output'].split()[0] == next_kernel and version['ok'] and dependencies['ok']),
            moduleVersion=version['output'] or None, vermagic=magic['output'] or None,
            dependencies=dependencies)
    if not loaded:
        return result
    listing = command('zpool', 'list', '-Hp', '-o', 'name,health,size,alloc,free,cap')
    if not listing['ok']:
        result['errors'].append(listing)
        return result
    for row in listing['output'].splitlines():
        fields = row.split('\t')
        if len(fields) != 6:
            result['errors'].append({'error': 'Unexpected zpool list row', 'output': row})
            continue
        name, health, size, allocated, free, capacity = fields
        status = command('zpool', 'status', '-p', name)
        text = status['output']
        scan = re.search(r'^\s*scan:\s*(.*(?:\n[ \t]+.*)*)', text, re.MULTILINE)
        errors = re.search(r'^errors:\s*(.*)', text, re.MULTILINE)
        devices = []
        for line in text.splitlines():
            match = re.match(r'^\s*(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED)\s+(\d+)\s+(\d+)\s+(\d+)\s*$', line)
            if match:
                device, state, read, write, checksum = match.groups()
                devices.append({'name': device, 'state': state, 'readErrors': int(read),
                                'writeErrors': int(write), 'checksumErrors': int(checksum)})
        scan_text = scan.group(1).strip() if scan else None
        result['pools'].append({'name': name, 'health': health, 'sizeBytes': int(size),
            'allocatedBytes': int(allocated), 'freeBytes': int(free), 'capacityPercent': float(capacity.rstrip('%')),
            'errors': errors.group(1) if errors else None, 'devices': devices,
            'scan': {'text': scan_text, 'scrub': bool(scan_text and 'scrub' in scan_text),
                     'resilver': bool(scan_text and 'resilver' in scan_text),
                     'inProgress': bool(scan_text and 'in progress' in scan_text)}, 'status': status})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--next-kernel', help='Explicit boot target; omitted means unknown, never guessed')
    args = parser.parse_args()
    if args.next_kernel and not re.fullmatch(r'[A-Za-z0-9._+~-]+', args.next_kernel):
        parser.error('Invalid kernel release')
    print(json.dumps(collect(args.next_kernel), ensure_ascii=False))


if __name__ == '__main__':
    main()
