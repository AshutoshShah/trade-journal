import test from 'node:test';
import assert from 'node:assert/strict';
import { failKey } from '../worker/auth.js';

test('IPv4 addresses count on their own', () => {
  assert.equal(failKey('203.0.113.9'), '203.0.113.9');
});

test('IPv6 addresses count by their /64', () => {
  const a = failKey('2001:db8:abcd:12:1:2:3:4');
  assert.equal(a, '2001:db8:abcd:12::/64');
  assert.equal(failKey('2001:db8:abcd:12:ffff::1'), a);
  assert.equal(failKey('2001:0DB8:ABCD:0012::9'), a);
  assert.notEqual(failKey('2001:db8:abcd:13::1'), a);
  assert.equal(failKey('2001:db8::1'), '2001:db8:0:0::/64');
});

test('a missing address has one shared bucket', () => {
  assert.equal(failKey(null), 'unknown');
});
