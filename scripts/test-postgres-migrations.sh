#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

repo_root="$(git rev-parse --show-toplevel)"
panel_dir="${1:-XPayincus}"
server_dir="$repo_root/$panel_dir/server"
temp_dir="$(mktemp -d)"
run_id="${temp_dir##*/}"
run_id="${run_id//[^a-zA-Z0-9]/}"
empty_database="xpayincus_empty_${run_id}"
previous_database="xpayincus_previous_${run_id}"
created_databases=()

cleanup() {
  local exit_code=$?
  set +e
  for database in "${created_databases[@]}"; do
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$database\"" >/dev/null 2>&1
  done
  rm -rf "$temp_dir"
  exit "$exit_code"
}

trap cleanup EXIT

if ! git -C "$repo_root" rev-parse --verify --quiet 'refs/tags/v1.0.21^{commit}' >/dev/null; then
  printf 'Required Git tag not found: v1.0.21\n' >&2
  exit 1
fi

run_migrations() {
  local migrations_dir="$1"
  local database_url="$2"
  local label="$3"
  local work_dir="$temp_dir/run-$label"
  mkdir -p "$work_dir/prisma"
  cp "$server_dir/prisma.config.ts" "$work_dir/prisma.config.ts"
  cp "$server_dir/prisma/schema.prisma" "$work_dir/prisma/schema.prisma"
  cp -R "$migrations_dir" "$work_dir/prisma/migrations"
  (cd "$work_dir" && DATABASE_URL="$database_url" pnpm --dir "$repo_root/$panel_dir" exec prisma migrate deploy --config "$work_dir/prisma.config.ts")
  printf 'Migration stage completed: %s\n' "$label"
}

database_url_for() {
  local database="$1"
  DATABASE_URL="$DATABASE_URL" node -e '
    const database = process.argv[1];
    const url = new URL(process.env.DATABASE_URL);
    const pathSegments = url.pathname.split("/");
    pathSegments[pathSegments.length - 1] = database;
    url.pathname = pathSegments.join("/");
    process.stdout.write(url.toString());
  ' "$database"
}

empty_url="$(database_url_for "$empty_database")"
previous_url="$(database_url_for "$previous_database")"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$empty_database\"" >/dev/null
created_databases+=("$empty_database")
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$previous_database\"" >/dev/null
created_databases+=("$previous_database")
run_migrations "$server_dir/prisma/migrations" "$empty_url" empty

previous_migrations="$temp_dir/previous-migrations"
mkdir -p "$temp_dir/tag-source"
git -C "$repo_root" archive refs/tags/v1.0.21 XPayincus/server/prisma/migrations | tar -x -C "$temp_dir/tag-source"
mv "$temp_dir/tag-source/XPayincus/server/prisma/migrations" "$previous_migrations"
rm -rf "$temp_dir/tag-source"
run_migrations "$previous_migrations" "$previous_url" previous
run_migrations "$server_dir/prisma/migrations" "$previous_url" previous-upgrade

echo "PostgreSQL migration checks passed for an empty database and the previous migration state."
