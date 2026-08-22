import { assertEquals } from "std/assert/mod.ts";
import {
  isTrustedProxy,
  normalizeAddress,
  parseIp,
  parseTrustedProxies,
  resolveClientIp,
} from "../src/utils/clientIp.ts";

/** Shapes a request the way `resolveClientIp` reads one. */
const req = (peer: string | undefined, forwardedFor?: string | string[]) => ({
  socket: { remoteAddress: peer },
  headers: forwardedFor === undefined
    ? {}
    : { "x-forwarded-for": forwardedFor },
});

const bytesOf = (text: string) => Array.from(parseIp(text) ?? []);

Deno.test("parseIp - accepts the four-octet forms and rejects the rest", () => {
  assertEquals(bytesOf("192.168.1.10"), [192, 168, 1, 10]);
  assertEquals(bytesOf("0.0.0.0"), [0, 0, 0, 0]);
  assertEquals(bytesOf("255.255.255.255"), [255, 255, 255, 255]);

  assertEquals(parseIp("256.1.1.1"), null);
  assertEquals(parseIp("1.2.3"), null);
  assertEquals(parseIp("1.2.3.4.5"), null);
  // Leading zeros are octal to some parsers and decimal to others. An
  // allowlist that disagrees with the kernel about what an address means is
  // worse than no allowlist, so this is refused rather than guessed at.
  assertEquals(parseIp("010.1.1.1"), null);
  assertEquals(parseIp(""), null);
  assertEquals(parseIp("not-an-ip"), null);
});

Deno.test("parseIp - expands IPv6, including the :: elision", () => {
  assertEquals(bytesOf("::1").length, 16);
  assertEquals(bytesOf("::1")[15], 1);
  assertEquals(
    bytesOf("2001:db8::1"),
    [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  );
  assertEquals(bytesOf("fe80::0000:0000:0000:0001").length, 16);

  assertEquals(parseIp("2001:db8::1::2"), null, "two elisions are ambiguous");
  assertEquals(parseIp("2001:db8:1"), null, "too few groups without ::");
  assertEquals(parseIp("2001:zzzz::1"), null);
});

Deno.test("parseIp - collapses IPv4-mapped IPv6 to plain IPv4", () => {
  // The runtime can report a v4 peer either way; an operator writing
  // "10.0.0.0/8" has no way to predict which, and no reason to care.
  assertEquals(bytesOf("::ffff:10.1.2.3"), [10, 1, 2, 3]);
  assertEquals(bytesOf("::ffff:0a01:0203"), [10, 1, 2, 3]);
});

Deno.test("normalizeAddress - strips ports, brackets and zone ids", () => {
  assertEquals(normalizeAddress("1.2.3.4:5678"), "1.2.3.4");
  assertEquals(normalizeAddress("[2001:db8::1]:443"), "2001:db8::1");
  assertEquals(normalizeAddress("[::1]"), "::1");
  assertEquals(normalizeAddress("fe80::1%eth0"), "fe80::1");
  assertEquals(normalizeAddress("  1.2.3.4  "), "1.2.3.4");
  // A bare IPv6 address is all colons; taking the last one for a port would
  // corrupt every unbracketed v6 address that arrives.
  assertEquals(normalizeAddress("2001:db8::1"), "2001:db8::1");
});

Deno.test("parseTrustedProxies - parses addresses, CIDRs and aliases", () => {
  assertEquals(parseTrustedProxies(undefined).length, 0);
  assertEquals(parseTrustedProxies("").length, 0);

  assertEquals(parseTrustedProxies("10.0.0.1").length, 1);
  assertEquals(parseTrustedProxies("10.0.0.0/8, 192.168.0.0/16").length, 2);
  assertEquals(parseTrustedProxies("private").length, 4);
  assertEquals(parseTrustedProxies("loopback,private").length, 6);
});

Deno.test("parseTrustedProxies - drops bad entries instead of throwing", () => {
  // A typo in one CIDR must narrow what is trusted, never widen it, and never
  // take the server down at boot.
  const ranges = parseTrustedProxies("10.0.0.0/8, nonsense, 1.2.3.4/99, ::1");
  assertEquals(ranges.length, 2);
  assertEquals(isTrustedProxy("10.9.9.9", ranges), true);
  assertEquals(isTrustedProxy("1.2.3.4", ranges), false);
  assertEquals(isTrustedProxy("::1", ranges), true);
});

Deno.test("isTrustedProxy - matches on the prefix, including odd bit counts", () => {
  const eight = parseTrustedProxies("10.0.0.0/8");
  assertEquals(isTrustedProxy("10.255.255.255", eight), true);
  assertEquals(isTrustedProxy("11.0.0.1", eight), false);

  const twelve = parseTrustedProxies("172.16.0.0/12");
  assertEquals(isTrustedProxy("172.16.0.1", twelve), true);
  assertEquals(isTrustedProxy("172.31.255.254", twelve), true);
  assertEquals(isTrustedProxy("172.32.0.1", twelve), false);
  assertEquals(isTrustedProxy("172.15.255.255", twelve), false);

  const seven = parseTrustedProxies("fc00::/7");
  assertEquals(isTrustedProxy("fd12:3456::1", seven), true);
  assertEquals(isTrustedProxy("fe80::1", seven), false);

  // Families do not cross-match, whichever way round they are written.
  assertEquals(isTrustedProxy("::1", eight), false);
  assertEquals(isTrustedProxy("10.0.0.1", seven), false);
});

Deno.test("isTrustedProxy - an empty allowlist trusts nothing", () => {
  assertEquals(isTrustedProxy("127.0.0.1", []), false);
  assertEquals(
    isTrustedProxy(undefined, parseTrustedProxies("private")),
    false,
  );
});

Deno.test("resolveClientIp - with no allowlist, the socket peer is the client", () => {
  // The pre-existing behaviour, and what a directly-exposed server wants.
  assertEquals(resolveClientIp(req("203.0.113.7"), []), "203.0.113.7");
  assertEquals(
    resolveClientIp(req("203.0.113.7", "198.51.100.9"), []),
    "203.0.113.7",
    "an unlisted peer's forwarding header is worth nothing",
  );
});

Deno.test("resolveClientIp - reads the header once the peer is trusted", () => {
  const trusted = parseTrustedProxies("private");
  assertEquals(
    resolveClientIp(req("10.0.0.5", "198.51.100.9"), trusted),
    "198.51.100.9",
  );
  // This is the finding: two clients behind one proxy must land in two
  // buckets, not share the proxy's.
  assertEquals(
    resolveClientIp(req("10.0.0.5", "198.51.100.10"), trusted),
    "198.51.100.10",
  );
});

Deno.test("resolveClientIp - a client cannot forge its way past the walk", () => {
  const trusted = parseTrustedProxies("private");
  // The client sent "X-Forwarded-For: 1.2.3.4"; our proxy appended the address
  // it actually saw. The walk runs right to left, so the appended entry is
  // what it reaches first and the forged one is never returned.
  assertEquals(
    resolveClientIp(req("10.0.0.5", "1.2.3.4, 198.51.100.9"), trusted),
    "198.51.100.9",
  );
});

Deno.test("resolveClientIp - skips our own hops and stops at the first that is not", () => {
  const trusted = parseTrustedProxies("private, 203.0.113.1");
  assertEquals(
    resolveClientIp(
      req("10.0.0.5", "198.51.100.9, 203.0.113.1, 10.0.0.9"),
      trusted,
    ),
    "198.51.100.9",
  );
});

Deno.test("resolveClientIp - falls back to the peer when the chain says nothing", () => {
  const trusted = parseTrustedProxies("private");

  assertEquals(resolveClientIp(req("10.0.0.5"), trusted), "10.0.0.5");
  assertEquals(resolveClientIp(req("10.0.0.5", ""), trusted), "10.0.0.5");
  // Every hop was one of ours: there is no client address in here to charge.
  assertEquals(
    resolveClientIp(req("10.0.0.5", "10.0.0.9, 192.168.1.1"), trusted),
    "10.0.0.5",
  );
  // Garbage in the part of the chain the walk has to cross discredits it:
  // an unparseable entry must not be able to hide the hop behind it.
  assertEquals(
    resolveClientIp(req("10.0.0.5", "198.51.100.9, junk, 10.0.0.9"), trusted),
    "10.0.0.5",
  );
});

Deno.test("resolveClientIp - garbage past the trust boundary is just noise", () => {
  // Everything to the left of the answer is client-supplied and already not
  // believed, so junk there is no more interesting than a forged address.
  const trusted = parseTrustedProxies("private");
  assertEquals(
    resolveClientIp(req("10.0.0.5", "junk, 198.51.100.9"), trusted),
    "198.51.100.9",
  );
});

Deno.test("resolveClientIp - normalizes what it returns and what it matches", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8");
  // A v4-mapped peer still matches a v4 allowlist entry, and a hop that
  // arrived with a port is keyed without it — otherwise every request from one
  // client lands in its own bucket.
  assertEquals(
    resolveClientIp(req("::ffff:10.0.0.5", "198.51.100.9:41234"), trusted),
    "198.51.100.9",
  );
  assertEquals(
    resolveClientIp(req("10.0.0.5", "[2001:db8::1]:443"), trusted),
    "2001:db8::1",
  );
});

Deno.test("resolveClientIp - a repeated header is one chain", () => {
  // Two proxies each adding their own X-Forwarded-For arrives as a list; the
  // order across them is the same order as within one.
  const trusted = parseTrustedProxies("private");
  assertEquals(
    resolveClientIp(req("10.0.0.5", ["198.51.100.9", "10.0.0.9"]), trusted),
    "198.51.100.9",
  );
});

Deno.test("resolveClientIp - a missing peer collapses to one shared bucket", () => {
  // Not "no limit": an address we cannot determine must still be counted
  // somewhere, and the safe somewhere is a bucket shared with every other
  // unattributable request.
  assertEquals(resolveClientIp(req(undefined), []), "unknown");
  assertEquals(resolveClientIp(req(""), []), "unknown");
});
