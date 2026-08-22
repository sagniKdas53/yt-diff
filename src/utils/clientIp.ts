/**
 * Deciding which address a request actually came from.
 *
 * The admission rate-limit tier runs before authentication, so an address is
 * the only thing it can key on. Behind the intended deployment — TLS
 * terminated at a reverse proxy — the socket peer is the *proxy*, identical
 * for every client, so keying on it puts every user in one bucket and lets one
 * noisy client lock out everyone else.
 *
 * `X-Forwarded-For` carries the real client, but it is a request header: any
 * client can send one. It is only worth anything when the hop that appended it
 * is known to be ours, which is why nothing here is believed unless the socket
 * peer matches a configured trusted proxy. With `TRUSTED_PROXIES` unset the
 * socket peer is the answer, exactly as before.
 */

/** A parsed address: 4 bytes for IPv4, 16 for IPv6. */
type IpBytes = Uint8Array;

/** One entry of the trusted-proxy allowlist, as an address plus prefix bits. */
export interface TrustedProxyRange {
  bytes: IpBytes;
  prefixBits: number;
}

/**
 * Named shorthands for the ranges an operator would otherwise have to spell
 * out. `private` is the one that matters in practice: a compose network hands
 * the proxy a 172.16/12 address that changes between deployments, so pinning
 * the literal address is not something an operator can do up front.
 */
const ALIASES: Record<string, string[]> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  private: [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
  ],
};

function parseIpv4(text: string): IpBytes | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    // Reject "01" and "" outright: a leading zero is octal in some parsers and
    // decimal in others, and an allowlist that disagrees with the kernel about
    // what an address means is worse than no allowlist.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text: string): IpBytes | null {
  if (!text.includes(":")) return null;

  // An IPv4-mapped tail ("::ffff:1.2.3.4") is expanded to two groups first, so
  // the rest of this only ever deals in hextets.
  let body = text;
  const lastColon = body.lastIndexOf(":");
  const tail = body.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    body = `${body.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = body.split("::");
  if (halves.length > 2) return null;

  const toGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : null;
  if (head === null) return null;
  if (halves.length === 2 && rest === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const filler = 8 - head.length - rest!.length;
    if (filler < 1) return null;
    groups = [...head, ...new Array(filler).fill(0), ...rest!];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >>> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/**
 * Parses an address to bytes, collapsing IPv4-mapped IPv6 to plain IPv4.
 *
 * The collapse is what makes an allowlist written as `10.0.0.0/8` still match
 * a peer the runtime reports as `::ffff:10.1.2.3` — a distinction the operator
 * has no way to predict and no reason to care about.
 */
export function parseIp(text: string): IpBytes | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const v4 = parseIpv4(trimmed);
  if (v4) return v4;

  const v6 = parseIpv6(trimmed);
  if (!v6) return null;

  const mapped = V4_MAPPED_PREFIX.every((byte, i) => v6[i] === byte);
  return mapped ? v6.slice(12) : v6;
}

/**
 * Strips the decoration an address can pick up in transit.
 *
 * `X-Forwarded-For` entries and socket peers both turn up with ports
 * (`1.2.3.4:5678`), brackets (`[::1]`) and IPv6 zone identifiers (`fe80::1%eth0`)
 * attached. A port is only stripped from an IPv4 form or a bracketed IPv6 one —
 * a bare `::1` is all colons, and taking the last one for a port would corrupt
 * every unbracketed IPv6 address.
 */
export function normalizeAddress(raw: string): string {
  let text = raw.trim();
  if (text === "") return "";

  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return "";
    text = text.slice(1, close);
  } else {
    const firstColon = text.indexOf(":");
    if (firstColon !== -1 && firstColon === text.lastIndexOf(":")) {
      text = text.slice(0, firstColon);
    }
  }

  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  return text;
}

/**
 * Parses `TRUSTED_PROXIES` into ranges.
 *
 * Unparseable entries are dropped rather than thrown on: a typo in one CIDR
 * should narrow what is trusted, never widen it and never take the server down
 * at boot. `config.ts` cannot log, so the caller reports what survived.
 */
export function parseTrustedProxies(
  raw: string | undefined,
): TrustedProxyRange[] {
  if (!raw) return [];

  const entries = raw
    .split(",")
    .flatMap((entry) => {
      const token = entry.trim().toLowerCase();
      return ALIASES[token] ?? [entry.trim()];
    })
    .filter((entry) => entry !== "");

  const ranges: TrustedProxyRange[] = [];
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    const addressPart = slash === -1 ? entry : entry.slice(0, slash);
    const bytes = parseIp(normalizeAddress(addressPart));
    if (!bytes) continue;

    const maxBits = bytes.length * 8;
    let prefixBits = maxBits;
    if (slash !== -1) {
      const declared = Number(entry.slice(slash + 1));
      if (!Number.isInteger(declared) || declared < 0 || declared > maxBits) {
        continue;
      }
      prefixBits = declared;
    }
    ranges.push({ bytes, prefixBits });
  }
  return ranges;
}

function withinRange(address: IpBytes, range: TrustedProxyRange): boolean {
  if (address.length !== range.bytes.length) return false;

  const wholeBytes = range.prefixBits >>> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (address[i] !== range.bytes[i]) return false;
  }

  const remainder = range.prefixBits & 7;
  if (remainder === 0) return true;

  const mask = 0xff << (8 - remainder) & 0xff;
  return (address[wholeBytes] & mask) === (range.bytes[wholeBytes] & mask);
}

/** True when `address` falls inside any configured trusted range. */
export function isTrustedProxy(
  address: string | undefined,
  trusted: TrustedProxyRange[],
): boolean {
  if (!address || trusted.length === 0) return false;
  const bytes = parseIp(normalizeAddress(address));
  if (!bytes) return false;
  return trusted.some((range) => withinRange(bytes, range));
}

/**
 * Resolves the address to charge a request against.
 *
 * Walks `X-Forwarded-For` right to left — the rightmost entry is the hop
 * closest to us, the one our own proxy appended — and stops at the first
 * address that is not itself a trusted proxy. That is the furthest point in
 * the chain we have a reason to believe, and it is what a client cannot forge:
 * anything it prepends stays to the *left* of the entries our proxies wrote,
 * so it is never what the walk returns.
 *
 * Returns the socket peer whenever the chain cannot be believed — no
 * allowlist, an untrusted peer, an absent or unparseable header. The result is
 * a rate-limit key, so a missing address collapses to a shared `"unknown"`
 * bucket rather than to no limit at all.
 */
export function resolveClientIp(
  request: {
    socket: { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
  },
  trusted: TrustedProxyRange[],
): string {
  const peer = normalizeAddress(request.socket.remoteAddress ?? "");
  const fallback = peer === "" ? "unknown" : peer;

  if (!isTrustedProxy(peer, trusted)) return fallback;

  const header = request.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return fallback;

  const hops = raw.split(",").map(normalizeAddress).filter((hop) => hop !== "");
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    // Garbage in the stretch being crossed discredits the walk — an
    // unparseable entry must not hide the hop behind it. Garbage further left
    // is never reached, and is no more interesting than a forged address.
    if (!parseIp(hop)) return fallback;
    if (!isTrustedProxy(hop, trusted)) return hop;
  }

  // Every hop was one of ours. Nothing further to attribute this to.
  return fallback;
}
