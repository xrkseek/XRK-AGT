#!/usr/bin/env node
/** 子服连通性冒烟（本地 tests/，不入库） */
import { SUBSERVER_RUNTIME_CATALOG } from '#utils/subserver-runtimes.js';

const args = process.argv.slice(2);
const host = getArg('--host') || '127.0.0.1';
const timeoutMs = Number(getArg('--timeout')) || 8000;
const runtimeFilter = getArg('--runtime')?.split(',').map((s) => s.trim()).filter(Boolean);

/** @type {Record<string, { method?: string, path: string, body?: unknown, expectOk?: boolean }[]>} */
const PROBES = {
  pyserver: [
    { path: '/health' },
    { path: '/api/system/ping' },
    { path: '/api/system/groups' }
  ],
  goserver: [
    { path: '/health' },
    { path: '/api/system/ping' },
    { method: 'POST', path: '/api/hash-tools/sha256', body: { text: 'xrk' }, expectOk: true }
  ],
  phpserver: [
    { path: '/health' },
    { path: '/api/system/ping' },
    { method: 'POST', path: '/api/string-tools/length', body: { text: 'hello' }, expectOk: true }
  ],
  jserver: [
    { path: '/health' },
    { path: '/api/system/ping' },
    { method: 'POST', path: '/api/json-tools/format', body: { text: '{"a":1}' }, expectOk: true }
  ],
  netserver: [
    { path: '/health' },
    { path: '/api/system/ping' },
    { method: 'POST', path: '/api/uuid-tools/generate', body: {}, expectOk: true }
  ],
  rustserver: [
    { path: '/health' },
    { path: '/api/system/ping' },
    { method: 'POST', path: '/api/regex-tools/match', body: { text: 'abc123', pattern: '\\d+' }, expectOk: true }
  ]
};

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function probe(baseUrl, spec) {
  const method = spec.method || 'GET';
  const url = `${baseUrl}${spec.path}`;
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (spec.body != null) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(spec.body);
  }
  const started = Date.now();
  const response = await fetch(url, init);
  const elapsed = Date.now() - started;
  let json = null;
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('json')) json = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (spec.expectOk && json && typeof json === 'object' && json.ok === false) {
    throw new Error(json.error || json.detail || 'ok=false');
  }
  return { elapsed, status: response.status };
}

async function testRuntime(id, meta) {
  const baseUrl = `http://${host}:${meta.port}`;
  const probes = PROBES[id] || [{ path: '/health' }];
  const results = [];
  for (const spec of probes) {
    const label = `${spec.method || 'GET'} ${spec.path}`;
    try {
      const { elapsed, status } = await probe(baseUrl, spec);
      results.push({ label, ok: true, status, ms: elapsed });
    } catch (error) {
      results.push({ label, ok: false, error: error.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  return {
    id,
    label: meta.label,
    port: meta.port,
    baseUrl,
    ok: failed.length === 0,
    results,
    error: failed.length ? failed.map((f) => `${f.label}: ${f.error}`).join('; ') : ''
  };
}

async function main() {
  const ids = Object.keys(SUBSERVER_RUNTIME_CATALOG).filter(
    (id) => !runtimeFilter?.length || runtimeFilter.includes(id)
  );
  console.log(`子服冒烟 host=${host} timeout=${timeoutMs}ms\n`);
  const reports = [];
  for (const id of ids) {
    const report = await testRuntime(id, SUBSERVER_RUNTIME_CATALOG[id]);
    reports.push(report);
    console.log(`[${report.ok ? 'OK' : 'FAIL'}] ${id} @ ${report.baseUrl}`);
    for (const r of report.results) {
      console.log(r.ok ? `       ✓ ${r.label} ${r.status} ${r.ms}ms` : `       ✗ ${r.label} — ${r.error}`);
    }
    console.log('');
  }
  const passed = reports.filter((r) => r.ok).length;
  console.log(`合计: ${passed}/${reports.length} 通过`);
  if (passed < reports.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
