import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import { NODE_ENV } from "./Env";

// A server-side request to an address that came from outside (an admin's
// feed URL, an image URL inside an imported file, an old site's file path):
// only http(s) on the public internet - never this server, its private
// network or a cloud metadata address. The address is checked on every hop
// (redirects are followed by hand, each one checked) and on the IP the
// socket really connects to (the DNS answer is checked inside `lookup`, so
// a name that resolves to a public IP for the check and to 127.0.0.1 for
// the connection - DNS rebinding - is refused too). Bodies are capped in
// size while they stream, and the whole request in time.
//
// Developers who need to read a local test server set
// SAFE_FETCH_ALLOW_PRIVATE=1 outside production.

// two lists: a BlockList matches IPv4 rules against IPv4-mapped IPv6 and back
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped / -compatible / NAT64: an IPv4 address in IPv6 clothes
  ["::ffff:0:0", 96],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(addr, prefix, "ipv6");

const allowPrivate = () => NODE_ENV !== "production" && process.env.SAFE_FETCH_ALLOW_PRIVATE === "1";

/** true for loopback, private, link-local, metadata, multicast, reserved... */
export const isPrivateAddress = (ip: string): boolean => {
  const v = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(v);
  if (family === 4) return blocked4.check(v, "ipv4");
  if (family === 6) return blocked6.check(v, "ipv6");
  return true;
};

export class UnsafeUrlError extends Error {
  constructor(why: string) {
    super(`unsafe url: ${why}`);
  }
}

/** a parsed http(s) URL with no credentials and no private literal host; throws UnsafeUrlError */
export const parsePublicUrl = (raw: string | URL): URL => {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UnsafeUrlError("bad url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("protocol");
  if (url.username || url.password) throw new UnsafeUrlError("credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new UnsafeUrlError("host");
  if (allowPrivate()) return url;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    throw new UnsafeUrlError("host");
  if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError("private address");
  return url;
};

/** parsePublicUrl + every address the name resolves to is public */
export const assertPublicUrl = async (raw: string | URL): Promise<URL> => {
  const url = parsePublicUrl(raw);
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return url;
  const addrs = await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new UnsafeUrlError("dns");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("private address");
  return url;
};

// the socket's own DNS lookup: the answer is checked right before connecting
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (...a: unknown[]) => void)(err);
    const list = (addresses as unknown as dns.LookupAddress[]) || [];
    if (!list.length || (!allowPrivate() && list.some((a) => isPrivateAddress(a.address)))) {
      const e = Object.assign(new UnsafeUrlError("private address"), { code: "EUNSAFEADDR" });
      return (callback as (...a: unknown[]) => void)(e);
    }
    if ((options as dns.LookupOptions).all) return (callback as (...a: unknown[]) => void)(null, list);
    return (callback as (...a: unknown[]) => void)(null, list[0].address, list[0].family);
  });
};

export type SafeFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** whole request incl. redirects (default 30s) */
  timeoutMs?: number;
  /** body cap; a bigger body fails the request (default 25MB) */
  maxBytes?: number;
  /** 0 = a redirect is an error (default 5) */
  maxRedirects?: number;
  signal?: AbortSignal;
};

type Hop = { status: number; headers: Headers; body: Buffer };

const toHeaders = (raw: http.IncomingHttpHeaders) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
  }
  return headers;
};

const isRedirect = (status: number, headers: Headers) => status >= 300 && status < 400 && !!headers.get("location");

// production: node's http(s) with the checked `lookup`, so the IP the socket
// connects to is the one that was checked (no DNS-rebinding window)
const pinnedHop = (url: URL, opts: SafeFetchOptions, maxBytes: number, signal: AbortSignal) =>
  new Promise<Hop>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: opts.method || "GET",
        headers: { "user-agent": "NoyanAI/1.0", "accept-encoding": "identity", ...(opts.headers || {}) },
        lookup: safeLookup,
        signal,
      },
      (res) => {
        const status = res.statusCode || 0;
        const headers = toHeaders(res.headers);
        // a redirect's body is not read
        if (isRedirect(status, headers)) {
          res.resume();
          return resolve({ status, headers, body: Buffer.alloc(0) });
        }
        if (Number(res.headers["content-length"] || 0) > maxBytes) {
          res.destroy();
          return reject(new Error("too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new Error("too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("aborted")));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });

// elsewhere (development, the tests' stubbed global fetch): the same checks
// before each hop - the name's addresses resolved and checked - through fetch
const fetchHop = async (url: URL, opts: SafeFetchOptions, maxBytes: number, signal: AbortSignal): Promise<Hop> => {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: opts.headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : new Uint8Array(opts.body),
    redirect: "manual",
    signal,
  });
  if (isRedirect(res.status, res.headers)) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: Buffer.alloc(0) };
  }
  if (Number(res.headers.get("content-length") || 0) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(Buffer.from(value));
  }
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
};

/**
 * fetch() for an outside address: returns a standard Response (body already
 * read, within maxBytes). Throws UnsafeUrlError for a private/non-http
 * address (on any hop), an Error for a timeout, an oversize body or a
 * network failure.
 */
export const safeFetch = async (raw: string | URL, opts: SafeFetchOptions = {}): Promise<Response> => {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const hopOf = NODE_ENV === "production" ? pinnedHop : fetchHop;
  let url = parsePublicUrl(raw);
  let current = opts;
  for (let hop = 0; ; hop++) {
    const res = await hopOf(url, current, maxBytes, signal);
    if (isRedirect(res.status, res.headers)) {
      if (hop >= maxRedirects) throw new Error("too many redirects");
      url = parsePublicUrl(new URL(res.headers.get("location")!, url));
      // a 303 (and a POST's 301/302) becomes a GET without a body
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (current.method || "GET") !== "GET"))
        current = { ...current, method: "GET", body: undefined };
      continue;
    }
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
    const headers = new Headers(res.headers);
    // the body is already decoded (fetch) or was asked as identity (http)
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(nullBody ? null : new Uint8Array(res.body), { status, headers });
  }
};
