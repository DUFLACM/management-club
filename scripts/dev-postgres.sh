#!/usr/bin/env bash
# 本地开发 PostgreSQL（Homebrew postgresql@18）：初始化并启动在 127.0.0.1:5433，创建 acm_club 库。
# 已有实例时仅确保数据库存在。测试库 acm_club_test 由集成测试自动管理。
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@18/bin}"
PGDATA="$(dirname "$0")/../.local-pg/data"
PORT=5433

if ! command -v "$PG_BIN/initdb" >/dev/null 2>&1; then
  echo "未找到 $PG_BIN/initdb（brew install postgresql@18 或设置 PG_BIN）" >&2
  exit 1
fi

if ! "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "» 初始化数据库簇（superuser=acm，本地 trust 认证）"
    "$PG_BIN/initdb" -D "$PGDATA" -U acm --encoding=UTF8 --locale=C
  fi
  echo "» 启动 PostgreSQL :$PORT"
  "$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" \
    -l "$(dirname "$PGDATA")/pg.log" start
fi

for db in acm_club acm_club_test; do
  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U acm -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U acm -d postgres -c "CREATE DATABASE $db"
    echo "✓ 创建数据库 $db"
  fi
  # Prisma pg 适配器写入无偏移 UTC 串：会话时区固定 UTC（生产部署文档同样要求）
  "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U acm -d "$db" -c "ALTER DATABASE $db SET timezone TO 'UTC';" >/dev/null
  "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U acm -d "$db" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null
done

echo "✓ PostgreSQL 就绪：postgresql://acm@127.0.0.1:$PORT/acm_club"
