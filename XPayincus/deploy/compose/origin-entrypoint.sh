set -eu
set +x

FRONTEND_HOST="${FRONTEND_URL#https://}"
FRONTEND_HOST="${FRONTEND_HOST%%:*}"
ADMIN_FRONTEND_HOST="${ADMIN_FRONTEND_URL#https://}"
ADMIN_FRONTEND_HOST="${ADMIN_FRONTEND_HOST%%:*}"
export FRONTEND_HOST ADMIN_FRONTEND_HOST
exec /docker-entrypoint.sh nginx -g 'daemon off;'
