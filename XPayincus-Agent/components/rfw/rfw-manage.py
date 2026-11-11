#!/usr/bin/env python3
import argparse
import difflib
import fcntl
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

UNIT = Path('/etc/systemd/system/rfw.service')
STATE = Path('/var/lib/rfw')
BINARY = '/root/rfw/rfw'


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=45).stdout


def replace(path, data):
    fd, name = tempfile.mkstemp(prefix='.rfw-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def arguments(path):
    data = json.loads(path.read_text())
    if not isinstance(data, list) or len(data) > 128 or not all(isinstance(v, str) and len(v) <= 4096 for v in data):
        raise ValueError('Rules must be a JSON array of CLI arguments')
    for value in data:
        if not value or any(c in value for c in '\n\r\0%$') or value in ('--help', '--version', '-h', '-V'):
            raise ValueError('Unsafe systemd argument')
    # The Rust checker accepts run options only; subcommands and shell input are rejected.
    run(BINARY, 'check', *data)
    return data


def candidate(args):
    quoted = ' '.join('"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"' for value in [BINARY, *args])
    return ('[Unit]\nDescription=RFW XDP firewall\nAfter=network-online.target\nWants=network-online.target\n'
            '[Service]\nType=simple\nExecStart=' + quoted + '\nRestart=on-failure\nRestartSec=5\n'
            'KillSignal=SIGTERM\nTimeoutStopSec=20\n[Install]\nWantedBy=multi-user.target\n')


def attached():
    generation = json.loads(Path('/run/rfw/generation.json').read_text())
    links = json.loads(run('ip', '-j', '-details', 'link', 'show', 'dev', generation['interface']))
    def ids(value):
        if isinstance(value, dict):
            return [v for k, v in value.items() if k == 'id'] + [i for v in value.values() for i in ids(v)]
        if isinstance(value, list):
            return [i for v in value for i in ids(v)]
        return []
    return generation['programId'] in ids(links[0].get('xdp', {}))


def restart():
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'rfw.service')
    for _ in range(40):
        try:
            run('systemctl', 'is-active', '--quiet', 'rfw.service')
            if attached():
                return
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise RuntimeError('RFW did not publish a matching actual XDP attachment')


def main():
    parser = argparse.ArgumentParser(description='Independent Rust/systemd RFW rule management')
    parser.add_argument('action', choices=['show', 'diff', 'check', 'apply', 'rollback', 'status', 'export'])
    parser.add_argument('rules', type=Path, nargs='?', help='JSON argv array for diff/check/apply')
    parser.add_argument('--output', type=Path, help='Atomic JSON stats snapshot for external historical sampling')
    args = parser.parse_args()
    if args.action == 'show':
        text = UNIT.read_text()
        starts = [line[len('ExecStart='):] for line in text.splitlines() if line.startswith('ExecStart=')]
        print(json.dumps({'unit': text, 'configuredArgv': [shlex.split(v) for v in starts]}))
        return
    if args.action == 'status':
        generation = json.loads(Path('/run/rfw/generation.json').read_text())
        status = json.loads(run(BINARY, 'status', '--iface', generation['interface']))
        status['readOnly'] = True
        status['actualXdpAttached'] = attached()
        if json.loads(Path('/run/rfw/generation.json').read_text()) != generation:
            raise RuntimeError('RFW generation changed during sample; retry')
        print(json.dumps(status))
        return
    if args.action == 'export':
        snapshot = run(BINARY, 'stats', '--json')
        json.loads(snapshot)
        if args.output:
            replace(args.output, snapshot)
        else:
            print(snapshot, end='')
        return
    if args.action in ('check', 'diff', 'apply'):
        if args.rules is None:
            parser.error('rules JSON path is required')
        new = candidate(arguments(args.rules))
        if args.action == 'check':
            print(json.dumps({'valid': True, 'addressFamily': 'IPv4'}))
            return
        if args.action == 'diff':
            old = UNIT.read_text() if UNIT.exists() else ''
            print(''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile=str(UNIT), tofile='candidate')), end='')
            return
    if os.geteuid() != 0:
        parser.error('apply/rollback require root')
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'manage.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old = UNIT.read_text() if UNIT.exists() else None
        active = subprocess.run(['systemctl', 'is-active', '--quiet', 'rfw.service'], timeout=15).returncode == 0
        backup = STATE / 'previous.service'
        if args.action == 'rollback':
            new = backup.read_text()
        try:
            if args.action == 'apply':
                if old is not None:
                    replace(backup, old)
            replace(UNIT, new)
            restart()
        except Exception as error:
            try:
                run('systemctl', 'stop', 'rfw.service')
                if old is None:
                    UNIT.unlink(missing_ok=True)
                else:
                    replace(UNIT, old)
                run('systemctl', 'daemon-reload')
                if active:
                    restart()
            except Exception as rollback_error:
                raise RuntimeError(f'Apply failed: {error}; rollback failed: {rollback_error}') from error
            raise RuntimeError(f'Apply failed; previous service restored: {error}') from error
        print(json.dumps({'applied': True, 'actualXdpVerified': True}))


if __name__ == '__main__':
    main()
