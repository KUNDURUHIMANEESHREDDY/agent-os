"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isPublicAddress,
  assertReadOnlyMethod,
  resolvePublicHttpTarget,
} = require("./network-policy");

test("blocks private, loopback, link-local, and reserved IPv4 addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1"]) {
    assert.equal(isPublicAddress(ip, 4), false, ip);
  }
  assert.equal(isPublicAddress("93.184.216.34", 4), true);
});

test("blocks local, unique-local and mapped IPv6 addresses", () => {
  for (const ip of ["::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1"]) {
    assert.equal(isPublicAddress(ip, 6), false, ip);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111", 6), true);
});

test("rejects local hostnames, unsupported schemes and embedded URL credentials", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(resolvePublicHttpTarget("http://localhost", lookup), { code: "blocked_network_target" });
  await assert.rejects(resolvePublicHttpTarget("http://metadata.google.internal", lookup), { code: "blocked_network_target" });
  await assert.rejects(resolvePublicHttpTarget("file:///etc/passwd", lookup), { code: "invalid_external_url" });
  await assert.rejects(resolvePublicHttpTarget("https://user:pass@example.com", lookup), { code: "invalid_external_url" });
});

test("rejects a hostname when any DNS answer is non-public", async () => {
  const lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ];
  await assert.rejects(resolvePublicHttpTarget("https://example.com", lookup), { code: "blocked_network_target" });
});

test("returns a pinned public address for DNS-rebinding resistant requests", async () => {
  const address = { address: "93.184.216.34", family: 4 };
  const result = await resolvePublicHttpTarget("https://example.com/data", async () => [address]);
  assert.equal(result.url.hostname, "example.com");
  assert.deepEqual(result.address, address);
});

test("api_fetch is read-only until action-bound approval exists", () => {
  assert.doesNotThrow(() => assertReadOnlyMethod("GET", undefined));
  assert.throws(() => assertReadOnlyMethod("POST", { action: "create" }), { code: "approval_required" });
  assert.throws(() => assertReadOnlyMethod("DELETE"), { code: "approval_required" });
  assert.throws(() => assertReadOnlyMethod("GET", "unexpected body"), { code: "approval_required" });
});
