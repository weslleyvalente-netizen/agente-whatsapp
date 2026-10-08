#!/usr/bin/env bash
# scripts/build-seller-isolation-sql.sh
# Junta as 4 migrations de isolamento por vendedor em um arquivo único, em uma transação,
# e registra as versões no histórico do Supabase CLI. Para colar no SQL Editor do Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/seller-isolation-migrations.sql}"
FILES=$(ls supabase/migrations/20261008120*_seller_isolation_*.sql | sort)
{
  echo "-- Isolamento por vendedor (RLS): 4 migrations em UMA transação (tudo ou nada)."
  echo "-- Só restringe quando organizations.settings.seller_isolation_enabled = 'true'; aplicar não muda nada sozinho."
  echo "begin;"
  for f in $FILES; do echo; echo "-- ===== $(basename "$f") ====="; cat "$f"; done
  echo
  echo "insert into supabase_migrations.schema_migrations(version, name) values"
  echo "$FILES" | sed -E "s#.*/([0-9]+)_(.*)\.sql#('\1','\2')#" | paste -sd, -
  echo "on conflict (version) do nothing;"
  echo
  echo "commit;"
} > "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
