# 生产级性能 / 韧性测试

零第三方压测依赖（纯 Node `fetch`）。面向真实 AgentRuntime HTTP 面。

## 命令

```bash
# CI 可门禁：自举短跑 /health
pnpm test:perf:smoke

# CI 短门禁：自举 load + soak + 校验 /metrics.http（cigate profile，跑 dist）
pnpm test:perf:gate

# 写入本次报告（可选）
pnpm test:perf:gate -- --json data/temp/perf-cigate-latest.json

# 负载（30s / 50 并发，自举）
pnpm test:load -- --self --target health --concurrency 100 --duration 30s

# 使用预设档位
pnpm test:load -- --profile local --self
pnpm test:bench -- --profile prodgate --base-url http://127.0.0.1:8080
pnpm test:soak -- --profile soak30m --base-url http://127.0.0.1:8080

# 压力阶梯
pnpm test:stress -- --self --target health --max-concurrency 200 --max-p99-ms 250

# 轻量混沌（客户端注入）
pnpm test:chaos -- --self --target health --inject-rate 0.05 --duration 20s
```

对已运行实例：

```bash
node tests/perf/run-perf.mjs load --base-url http://127.0.0.1:8080 --target mixed --api-key <key>
```

## 目标

| id | 路径 | 鉴权 |
|----|------|------|
| health | `/health` | 否 |
| metrics / metrics_prom | `/metrics` | 否 |
| status | `/status` | 否 |
| api_health | `/api/health` | 是* |
| plugins_summary / plugins_tasks | `/api/plugins/*` | 是* |
| mixed | 70% health + 20% summary + 10% prom | 混合 |

\*本机 `127.*` 默认可免 Key；远程务必 `--api-key` 或配置 `XRK_API_KEY` / `config/server_config/api_key.json`。

## 预设 Profiles

| profile | 用途 |
|---------|------|
| smoke | CI 门禁（宽松 SLO） |
| cigate | CI/本机短门禁：自举 load+soak+`/metrics.http`（`pnpm test:perf:gate`） |
| local | 本机开发压测 |
| staging | 预发混合流量 |
| prodgate | 放行前硬门槛模板 |
| soak30m | 30 分钟浸泡验收 |

## SLO 门禁

```bash
node tests/perf/run-perf.mjs load --self --target health \
  --max-p99-ms 100 --max-error-rate 0.01 --min-rps 200 --json data/temp/perf-load.json
```

**cigate 基线**：`tests/baselines/perf-cigate-baseline.json`（同机对照；硬门槛见 `profiles.mjs` `cigate.slo`）。契约测：`tests/framework/perf-cigate-baseline.test.mjs`。

## 生产注意

1. 持续压测前关闭或放宽 `server.rateLimit`（非私网 IP 会撞限流）。
2. `/api/health` 依赖 Redis；测就绪面时先确保 Redis。
3. 勿对写接口做无差别加压。
4. soak ≥30m 才宜作为泄漏/连接稳定性验收；默认 10m 为开发冒烟。
5. 引擎单测：`tests/framework/perf-engine.test.mjs`（已入 `test:fast`）。
6. 泄漏/句柄轻量面：`pnpm test:perf:smoke` + `tests/framework/load-stress-light.test.mjs`（含 Disposables 高频 dispose）+ `disposables-concurrency.test.mjs`（逆序清理 / ALS 并发）。
7. 服务端混沌：`pnpm test:chaos -- --self --chaos-mode server --chaos-error-rate 0.2`（需 `XRK_CHAOS_ENABLED`，仅测试实例）。
