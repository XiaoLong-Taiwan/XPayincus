#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def publish(component, directory=Path('/run/xpayincus')):
    tools = Path(__file__).resolve().parent
    command = (['python3', str(tools / 'rfw-manage.py'), 'status'] if component == 'rfw'
               else ['python3', str(tools / 'zfs-status.py')])
    result = subprocess.run(command, check=True, capture_output=True, timeout=60)
    if len(result.stdout) > 65536:
        raise ValueError('Snapshot exceeds Agent input limit')
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get('schemaVersion') != 1:
        raise ValueError('Invalid component snapshot schema')
    value['readOnly'] = True
    value['collectedAtUnix'] = int(time.time())
    data = (json.dumps(value, ensure_ascii=False) + '\n').encode()
    if len(data) > 65536:
        raise ValueError('Snapshot exceeds Agent input limit')
    fd, temporary = tempfile.mkstemp(prefix=f'.{component}-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, directory / f'{component}-status.json')
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description='Publish read-only host component snapshots')
    parser.add_argument('component', choices=['rfw', 'zfs'])
    args = parser.parse_args()
    publish(args.component)


if __name__ == '__main__':
    main()
