import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'XPayincus/server/templates/install.sh').read_text()
BASH = os.environ.get('AGENT_TEST_BASH', 'bash')


def function(name):
    return re.search(r'^' + name + r'\(\) \{.*?^\}', SOURCE, re.M | re.S).group()


class HostInstallTrustTests(unittest.TestCase):
    def run_import(self, token='fixture-uuid', config=True, trust='panel', failure='', known=False,
                   trust_details=None):
        script = r'''
set -euo pipefail
exec 3>&1
step() { :; }
log() { printf '%s\n' "$*"; }
error() { printf '%s\n' "$*" >&2; }
rm() { :; }
mktemp() { printf '/unused-certificate'; }
refresh_panel_trust() { printf 'hmac\n'; return 43; }
curl() {
  local arg input
  for arg in "$@"; do [[ "$arg" != *fixture-uuid* ]] || exit 91; done
  input=$(cat)
  [[ "$input" == 'url = "https://panel.example.org/api/hosts/cert/fixture-uuid"' ]] || exit 92
  printf 'token-download\n'
  [[ "$FAILURE" != download ]]
}
openssl() {
  [[ "$FAILURE" != certificate ]] || return 1
  [[ "$FAILURE" != fingerprint || "$*" != *DER* ]] || return 1
  [[ "$*" != *DER* ]] || printf 'fixture-certificate'
}
incus() {
  case "$*" in
    'config trust list --format csv -c n')
      [[ "$FAILURE" != list ]] || return 1
      printf '%s\n' "$TRUST" ;;
    'config trust list --format json')
      [[ "$FAILURE" != details ]] || return 1
      printf '%s\n' "$TRUST_DETAILS" ;;
    'config trust show '*) [[ "$KNOWN" == 1 ]] ;;
    'config trust add-certificate '*)
      printf 'add %s\n' "${@: -1}" >&3
      [[ "$FAILURE" != add ]] ;;
    *) printf 'unexpected mutation\n'; exit 93 ;;
  esac
}
import_cert
printf 'continue-agent-install\n'
'''
        if trust_details is None:
            trust_details = json.dumps([{
                'fingerprint': hashlib.sha256(b'fixture-certificate').hexdigest(),
                'type': 'client', 'restricted': False,
            }])
        env = dict(os.environ, TOKEN=token, PANEL_URL='https://panel.example.org',
                   AGENT_CONFIG_FILE='/bin/bash' if config else '/dev/null/absent',
                   TRUST=trust, FAILURE=failure, KNOWN=str(int(known)),
                   TRUST_DETAILS=trust_details)
        return subprocess.run([BASH, '--noprofile', '--norc', '-s'],
                              input=function('import_cert') + '\n' + script,
                              env=env, capture_output=True, text=True, timeout=15)

    def test_uuid_ignores_stale_config_and_preserves_old_trust(self):
        for config in (False, True):
            for trust in ('', 'panel', 'panel-' + 'a' * 64):
                with self.subTest(config=config, trust=trust):
                    result = self.run_import(config=config, trust=trust)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('token-download', result.stdout)
                    self.assertIn('add panel', result.stdout)
                    self.assertIn('continue-agent-install', result.stdout)
                    self.assertNotIn('hmac', result.stdout)
                    if trust:
                        self.assertIn('保留旧信任，不会自动清理', result.stdout)
                        self.assertNotIn('保留至安装完成后验证', result.stdout)

    def test_existing_certificate_is_idempotent(self):
        result = self.run_import(known=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('add ', result.stdout)
        self.assertIn('已确认 client 类型且不受限', result.stdout)
        self.assertIn('continue-agent-install', result.stdout)

    def test_existing_certificate_requires_unrestricted_client(self):
        fingerprint = hashlib.sha256(b'fixture-certificate').hexdigest()
        valid = {'fingerprint': fingerprint, 'type': 'client', 'restricted': False}
        cases = [
            [dict(valid, restricted=True)],
            [dict(valid, type='server')],
            [dict(valid, type='metrics')],
            [dict(valid, restricted='false')],
            [{'fingerprint': fingerprint, 'type': 'client'}],
            [{'fingerprint': fingerprint, 'restricted': False}],
            [dict(valid, fingerprint='a' * 64)],
            [valid, valid],
            [], None, {}, [None],
        ]
        for details in [json.dumps(case) for case in cases] + ['invalid-json']:
            with self.subTest(details=details):
                result = self.run_import(known=True, trust_details=details)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('client 类型且 restricted 为 false', result.stderr)
                self.assertNotIn('add ', result.stdout)
                self.assertNotIn('continue-agent-install', result.stdout)
                self.assertNotIn('hmac', result.stdout)

    def test_existing_certificate_details_failure_stops_install(self):
        result = self.run_import(known=True, failure='details')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('无法确认或权限不符', result.stderr)
        self.assertNotIn('add ', result.stdout)
        self.assertNotIn('continue-agent-install', result.stdout)

    def test_no_token_keeps_hmac_failure_without_fallback(self):
        result = self.run_import(token='')
        self.assertEqual(result.returncode, 43)
        self.assertEqual(result.stdout, 'hmac\n')

    def test_bootstrap_failures_stop_before_agent_install(self):
        for failure in ('download', 'certificate', 'list', 'fingerprint', 'add'):
            with self.subTest(failure=failure):
                result = self.run_import(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('continue-agent-install', result.stdout)
                self.assertNotIn('hmac', result.stdout)
                if failure != 'add':
                    self.assertNotIn('add ', result.stdout)

    def run_main(self, token='', injected_token='', config='valid', failure='', mode='nat',
                 interactive=False, port='8443'):
        definitions = '\n'.join(function(name) for name in (
            'is_valid_port', 'read_agent_config_value', 'has_valid_agent_trust_config',
            'import_cert', 'main'))
        definitions = definitions.replace('"$EUID"', '"0"')
        script = r'''
set -euo pipefail
MODE='' TOKEN='' LISTEN_PORT=8443 UNINSTALL_DELETE_DATA=false
INJECT_TOKEN="$TEST_INJECTED_TOKEN"
DIM='' NC='' BOLD='' IS_PURE_IPV6=false
for name in show_banner detect_system configure_agent_heartbeat_interval configure_zfs_arc_memory \
            divider setup_kernel install_deps apply_zfs_arc_config install_incus init_incus; do
  eval "$name() { :; }"
done
step() { :; }
log() { printf '%s\n' "$*"; }
info() { printf '%s\n' "$*"; }
error() { printf '%s\n' "$*" >&2; }
warn() { printf '%s\n' "$*" >&2; }
read_token() { printf 'unexpected-token-prompt\n'; exit 94; }
confirm_install() { printf 'confirm\n'; }
refresh_panel_trust() { printf 'hmac\n'; [[ "$FAILURE" != hmac ]]; }
update_incudal_agent_from_config() { printf 'update\n'; }
install_incudal_agent() { printf 'agent-install\n'; }
show_result() { printf 'complete\n'; }
mktemp() { printf '/unused-certificate'; }
rm() { :; }
curl() { cat >/dev/null; printf 'token-download\n'; [[ "$FAILURE" != download ]]; }
openssl() { [[ "$*" != *DER* ]] || printf 'fixture-certificate'; }
incus() {
  case "$*" in
    'config trust list --format csv -c n') printf 'panel\n' ;;
    'config trust show '*) return 1 ;;
    'config trust add-certificate '*) printf 'add\n' ;;
    *) exit 93 ;;
  esac
}
main "$@"
'''
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / 'config.yaml'
            if config != 'missing':
                values = {'panel_url': 'https://panel.example.org',
                          'agent_id': 'agt_' + 'a' * 32, 'agent_secret': 'ias_' + 's' * 43}
                if isinstance(config, dict):
                    values.update(config)
                config_path.write_text('\n'.join(f'{key}: "{value}"' for key, value in values.items()))
            args = ['--mode', mode, '--yes'] if mode else ['--yes']
            args += ['--port', port]
            if token:
                args += ['--token', token]
            env = dict(os.environ, TEST_INJECTED_TOKEN=injected_token,
                       AGENT_CONFIG_FILE=str(config_path), FAILURE=failure,
                       PANEL_URL='https://panel.example.org')
            command = [BASH, '--noprofile', '--norc', '-c', definitions + '\n' + script, '--', *args]
            if interactive:
                master, slave = os.openpty()
                try:
                    return subprocess.run(command, stdin=slave, env=env,
                                          capture_output=True, text=True, timeout=15)
                finally:
                    os.close(slave)
                    os.close(master)
            return subprocess.run(command, stdin=subprocess.DEVNULL, env=env,
                                  capture_output=True, text=True, timeout=15)

    def test_main_without_token_uses_valid_existing_auth(self):
        result = self.run_main()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertLess(result.stdout.index('confirm\n'), result.stdout.index('hmac\n'))
        self.assertEqual(result.stdout.count('hmac\n'), 2)
        self.assertIn('update\n', result.stdout)
        self.assertIn('complete\n', result.stdout)
        self.assertNotIn('token-download', result.stdout)
        self.assertNotIn('unexpected-token-prompt', result.stdout)

    def test_main_valid_ports_reach_existing_auth(self):
        for port in ('1', '65535'):
            with self.subTest(port=port):
                result = self.run_main(port=port)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('hmac\n', result.stdout)
                self.assertIn('complete\n', result.stdout)

    def test_main_invalid_ports_stop_before_confirmation(self):
        for port in ('0', '65536', '100000', 'invalid'):
            with self.subTest(port=port):
                result = self.run_main(port=port)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('--port 必须为 1-65535 的整数', result.stderr)
                self.assertNotIn('command not found', result.stderr)
                self.assertNotIn('confirm\n', result.stdout)
                self.assertNotIn('hmac\n', result.stdout)
                self.assertNotIn('token-download', result.stdout)
                self.assertNotIn('agent-install\n', result.stdout)

    @unittest.skipUnless(os.name == 'posix', 'requires a POSIX terminal')
    def test_interactive_main_existing_auth_skips_token_prompt(self):
        result = self.run_main(interactive=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('hmac\n', result.stdout)
        self.assertIn('complete\n', result.stdout)
        self.assertNotIn('unexpected-token-prompt', result.stdout)

    def test_main_explicit_token_takes_priority_over_existing_config(self):
        for config in ('valid', 'missing', {'agent_secret': ''}):
            for source in ('cli', 'injected'):
                with self.subTest(config=config, source=source):
                    tokens = {'token' if source == 'cli' else 'injected_token': 'fixture-uuid'}
                    result = self.run_main(config=config, **tokens)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertLess(result.stdout.index('confirm\n'), result.stdout.index('token-download\n'))
                    self.assertIn('agent-install\n', result.stdout)
                    self.assertIn('complete\n', result.stdout)
                    self.assertNotIn('hmac\n', result.stdout)
                    self.assertNotIn('update\n', result.stdout)

    def test_main_missing_or_invalid_auth_stops_before_confirmation(self):
        for config in ('missing', {'panel_url': ''}, {'panel_url': 'http://panel.example.org'},
                       {'agent_id': ''}, {'agent_id': 'invalid'},
                       {'agent_secret': ''}, {'agent_secret': 'invalid'}):
            with self.subTest(config=config):
                result = self.run_main(config=config)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('confirm\n', result.stdout)
                self.assertNotIn('hmac\n', result.stdout)
                self.assertNotIn('token-download', result.stdout)
                self.assertNotIn('agent-install\n', result.stdout)

    def test_main_existing_auth_still_requires_noninteractive_mode(self):
        result = self.run_main(mode='')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('confirm\n', result.stdout)

    @unittest.skipUnless(os.name == 'posix', 'requires a POSIX terminal')
    def test_interactive_main_invalid_auth_still_requests_token(self):
        for config in ('missing', {'agent_secret': ''}):
            with self.subTest(config=config):
                result = self.run_main(config=config, interactive=True)
                self.assertEqual(result.returncode, 94, result.stdout + result.stderr)
                self.assertIn('unexpected-token-prompt\n', result.stdout)
                self.assertNotIn('confirm\n', result.stdout)
                self.assertNotIn('hmac\n', result.stdout)

    def test_main_auth_failures_do_not_fall_back(self):
        for tokens, failure, forbidden in [({}, 'hmac', 'token-download'),
                                           ({'token': 'fixture-uuid'}, 'download', 'hmac\n')]:
            with self.subTest(failure=failure):
                result = self.run_main(failure=failure, **tokens)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(forbidden, result.stdout)
                self.assertNotIn('update\n', result.stdout)
                self.assertNotIn('agent-install\n', result.stdout)
                self.assertNotIn('complete\n', result.stdout)

    def test_authorization_and_token_handoff_contracts(self):
        hosts = (ROOT / 'XPayincus/server/src/routes/hosts.ts').read_text()
        agent = (ROOT / 'XPayincus/server/src/routes/agent.ts').read_text()
        credentials = (ROOT / 'XPayincus/server/src/lib/host-agent-credentials.ts').read_text()
        installer = (ROOT / 'XPayincus/server/templates/agent-install.sh').read_text()
        trust = agent.split("}>('/panel-trust/:phase'", 1)[1].split("fastify.get('/install.sh'", 1)[0]
        self.assertIn('const agent = await authenticateAgentRequest(request, reply)', trust)
        self.assertIn("if (!host?.isInstalled) return reply.code(403)", trust)
        self.assertIn('rejectUnauthorized: true', trust)
        self.assertIn('if (!agent || !agent.enabled)', agent)
        self.assertIn('verifyAgentSignature(secret,', agent)
        self.assertIn("code: 'AGENT_NONCE_REPLAY'", agent)
        for path, end in [("'/install.sh/:token'", "'/cert/:token'"),
                          ("'/cert/:token'", "'/:id/verify'")]:
            route = hosts.split(path, 1)[1].split(end, 1)[0]
            self.assertIn('where: { installToken: token }', route)
            self.assertIn('if (host.isInstalled)', route)
            self.assertIn('if (!host.installTokenExpire)', route)
            self.assertIn('if (new Date() > host.installTokenExpire)', route)
        self.assertIn('issueHostAgentInstallToken(host.id, true)', hosts)
        self.assertIn('const rotated = await rotateHostAgentCredentials(hostId, enabled)', credentials)
        self.assertIn('installTokenExpiresAt: { gte: new Date() }', credentials)
        self.assertIn('if (updated.count !== 1)', credentials)
        self.assertIn('unset INCUDAL_AGENT_INSTALL_TOKEN\n  INCUS_STORAGE_DRIVER=', installer)
        self.assertIn('INCUDAL_AGENT_INSTALL_TOKEN="$AGENT_INSTALL_TOKEN"', function('install_incudal_agent'))
        self.assertIn('bash -s -- --host-ready --yes', function('install_incudal_agent'))
        refresh = function('refresh_panel_trust')
        self.assertLess(refresh.index('fetch_authenticated_panel_certificate verify'),
                        refresh.index('incus config trust remove "$old"'))


if __name__ == '__main__':
    unittest.main()
