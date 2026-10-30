"use strict";

const dns = require("node:dns").promises;
const net = require("node:net");

const blocked = new net.BlockList();
const blockedV4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const blockedV6 = [
  ["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
];
for (const [subnet, prefix] of blockedV4) blocked.addSubnet(subnet, prefix, "ipv4");
for (const [subnet, prefix] of blockedV6) blocked.addSubnet(subnet, prefix, "ipv6");

function isPublicAddress(address, family) {
  const version = family || net.isIP(address);
  if (version === 4) return !blocked.check(address, "ipv4");
  if (version === 6) {
    // Treat all IPv4-mapped IPv6 literals as non-public rather than risk
    // bypassing the IPv4 deny list through alternate address notation.
    if (/^::ffff:/i.test(address)) return false;
    return !blocked.check(address, "ipv6");
  }
  return false;
}

function assertReadOnlyMethod(method, body) {
  const normalized = String(method || "GET").trim().toUpperCase();
  if (normalized !== "GET" || (body !== undefined && body !== null && body !== "")) {
    const error = new Error("Studio api_fetch currently permits GET without a body only. Mutating HTTP actions require a separate approval capability.");
    error.code = "approval_required";
    throw error;
  }
}

async function resolvePublicHttpTarget(value, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(value);
  } catch {
    const error = new Error("External API URL must be an absolute HTTP(S) URL.");
    error.code = "invalid_external_url";
    throw error;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("Only HTTP and HTTPS external API URLs are supported.");
    error.code = "invalid_external_url";
    throw error;
  }
  if (url.username || url.password) {
    const error = new Error("Credentials embedded in external API URLs are not allowed.");
    error.code = "invalid_external_url";
    throw error;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".test")
  ) {
    const error = new Error("Local and internal network hostnames are blocked.");
    error.code = "blocked_network_target";
    throw error;
  }

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    const error = new Error("External API hostname could not be resolved.");
    error.code = "dns_resolution_failed";
    throw error;
  }
  if (!Array.isArray(records) || records.length === 0) {
    const error = new Error("External API hostname returned no addresses.");
    error.code = "dns_resolution_failed";
    throw error;
  }

  // Reject the entire hostname if any returned address is private, loopback,
  // link-local, multicast, documentation, reserved, or otherwise non-public.
  for (const record of records) {
    if (!record || !isPublicAddress(record.address, record.family)) {
      const error = new Error("External API hostname resolves to a non-public IP address; request blocked.");
      error.code = "blocked_network_target";
      throw error;
    }
  }

  return { url, address: records[0] };
}

module.exports = { isPublicAddress, assertReadOnlyMethod, resolvePublicHttpTarget };
