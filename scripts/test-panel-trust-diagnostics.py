import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'XPayincus/server/templates/install.sh').read_text()
SCRIPT = SOURCE.split("python3 - \"$phase\" \"$target\" <<'PY'\n", 1)[1].split('\nPY', 1)[0]
SENSITIVE = 'private-response-credential-marker'


class PanelTrustDiagnosticsTests(unittest.TestCase):
    def run_failure(self, failure=None, origin='https://panel.example.org', payload=None):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'certificate'
            output = io.StringIO()
            with patch.dict(os.environ, {
                'PANEL_TRUST_URL': origin,
                'PANEL_TRUST_ID': 'agt_' + 'a' * 32,
                'PANEL_TRUST_SECRET': 'ias_' + 's' * 43,
            }), patch.object(sys, 'argv', ['trust', 'certificate', str(target)]), \
                    patch('urllib.request.build_opener') as opener, contextlib.redirect_stderr(output):
                opener.return_value.open.side_effect = failure
                opener.return_value.open.return_value.__enter__.return_value.read.return_value = payload
                with self.assertRaises(SystemExit) as stopped:
                    exec(compile(SCRIPT, 'panel-trust', 'exec'), {})
                self.assertEqual(stopped.exception.code, 1)
            self.assertFalse(target.exists())
            self.assertNotIn(SENSITIVE, output.getvalue())
            self.assertNotIn('ias_' + 's' * 43, output.getvalue())
            return output.getvalue()

    def test_http_body_headers_and_reason_are_private(self):
        body = io.BytesIO(SENSITIVE.encode())
        error = urllib.error.HTTPError('https://panel.example.org', 502, SENSITIVE, {'X-Private': SENSITIVE}, body)
        self.assertIn('HTTP 502', self.run_failure(error))
        self.assertEqual(body.tell(), 0)

    def test_network_and_unexpected_errors_are_private(self):
        for error in [urllib.error.URLError(SENSITIVE), RuntimeError(SENSITIVE)]:
            with self.subTest(error=type(error).__name__):
                self.run_failure(error)

    def test_invalid_url_is_private(self):
        self.run_failure(origin='https://user:' + SENSITIVE + '@panel.example.org')

    def test_invalid_response_and_proof_are_private(self):
        for payload in [SENSITIVE.encode(), b'invalid\n' + SENSITIVE.encode(), b'x' * 65537]:
            with self.subTest(length=len(payload)):
                self.run_failure(payload=payload)

    def test_api_logs_only_fixed_diagnostics(self):
        source = (ROOT / 'XPayincus/server/src/routes/agent.ts').read_text()
        route = source.split("}>('/panel-trust/:phase'", 1)[1].split("fastify.get('/install.sh'", 1)[0]
        self.assertIn("code: 'PANEL_TRUST_HOST_UNREACHABLE'", route)
        self.assertIn("code: 'PANEL_TRUST_OPERATION_FAILED'", route)
        self.assertNotIn('err: error', route)
        self.assertNotIn('error.message', route)


if __name__ == '__main__':
    unittest.main()
