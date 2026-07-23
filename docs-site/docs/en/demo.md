# Online Demo

The demo environment is for quickly trying the XPayincus user portal and admin console. It is not a production deployment entrypoint and must not be used for real payment, secret, delivery or private-data testing.

## Entrypoints

This repository does not provide a public demo. Use your own user and admin domains after deployment.

## Boundaries

- Do not enter real payment details, API keys, SMTP passwords or other sensitive configuration in non-production environments.
- For production deployments, use your own user portal and admin domains. See [One-click Install](/en/deployment/one-click-install) and [Environment Variables](/en/deployment/environment).
- The demo is only for reviewing the UI, feature layout and basic workflows. Do not use it as a production environment.

## Difference From Production

- `panel.example.com` and `admin.example.com` are placeholder domains in the docs and must be replaced with your own domains.
- Production requires your own PostgreSQL database, the Redis service kept by the installer, Incus hosts, Agent, payment providers, SMTP, object storage and notification channels.
