/**
 * 网络字节汇总：勿因 virtual:true 误杀 eth0；仍跳过 docker/veth
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNetworkSkipSet,
  isSkippableNetIface,
  sumNetworkBytes,
} from '../../dist/src/infrastructure/http/utils/system-metrics.js';

describe('isSkippableNetIface / buildNetworkSkipSet', () => {
  it('eth0 即使 virtual:true 也不跳过', () => {
    assert.equal(isSkippableNetIface('eth0', { virtual: true, internal: false }), false);
    assert.equal(isSkippableNetIface('ens33', { virtual: true }), false);
    const skip = buildNetworkSkipSet([
      { iface: 'eth0', virtual: true, internal: false },
      { iface: 'lo', internal: true },
      { iface: 'veth0', virtual: true },
      { iface: 'docker0', virtual: true },
    ]);
    assert.equal(skip.has('eth0'), false);
    assert.equal(skip.has('lo'), true);
    assert.equal(skip.has('veth0'), true);
    assert.equal(skip.has('docker0'), true);
  });

  it('sumNetworkBytes 计入 eth0，跳过 vEthernet', () => {
    const { rx, tx } = sumNetworkBytes(
      [
        { iface: 'eth0', rx_bytes: 1000, tx_bytes: 200 },
        { iface: 'vEthernet (Default Switch)', rx_bytes: 99999, tx_bytes: 99999 },
        { iface: 'lo', rx_bytes: 50, tx_bytes: 50 },
      ],
      buildNetworkSkipSet([{ iface: 'lo', internal: true }]),
    );
    assert.equal(rx, 1000);
    assert.equal(tx, 200);
  });
});
