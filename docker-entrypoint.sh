#!/bin/sh

PORT=${XRK_SERVER_PORT:-8080}

if [ "$1" = "subserver" ]; then
    cd /app/subserver/pyserver || {
        echo "错误: 无法切换到 /app/subserver/pyserver 目录" >&2
        exit 1
    }

    mkdir -p /app/data/subserver
    [ ! -f /app/data/subserver/config.yaml ] && \
        cp /app/subserver/pyserver/config/default_config.yaml /app/data/subserver/config.yaml 2>/dev/null || true

    if [ -x ".venv/bin/python" ]; then
        exec .venv/bin/python main.py
    fi
    if command -v python3 >/dev/null 2>&1; then
        exec python3 main.py
    fi
    echo "错误: 未找到 Python 解释器（.venv 或 python3）" >&2
    exit 1
fi

if [ "$1" = "server" ]; then
    if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER:-}" ]; then
        [ -f /app/data/server_bots/redis.yaml ] && \
            sed -i 's/host: "127.0.0.1"/host: "redis"/g; s/host: 127.0.0.1/host: "redis"/g' /app/data/server_bots/redis.yaml 2>/dev/null || true

        [ -f /app/data/server_bots/mongodb.yaml ] && \
            sed -i 's/host: "127.0.0.1"/host: "mongodb"/g; s/host: 127.0.0.1/host: "mongodb"/g' /app/data/server_bots/mongodb.yaml 2>/dev/null || true
    fi

    exec node --no-warnings --no-deprecation dist/start.js server "$PORT"
fi

echo "错误: 未知命令 '$1'，请使用 'server' 或 'subserver'" >&2
exit 1
