import crypto from "crypto";

// The cryptography the Moadian API asks for, on Node's own crypto (no extra
// dependency): an RS256 JWS for the token and for each invoice, the JWS
// wrapped in an RSA-OAEP-256 + A256GCM JWE under the tax organisation's
// public key, the taxpayer's RSA key pair and its certificate request (CSR),
// and the private key sealed at rest.

export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// sigT is the signing time the spec makes critical, in seconds precision
const sigT = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export const signJws = (payload: unknown, privateKeyPem: string, certificate?: string) => {
  const header: Record<string, unknown> = { alg: "RS256", typ: "jose", sigT: sigT(), crit: ["sigT"], cty: "text/plain" };
  const cert = (certificate || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (cert) header.x5c = [cert];
  const input = `${b64url(JSON.stringify(header))}.${b64url(typeof payload === "string" ? payload : JSON.stringify(payload))}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input), privateKeyPem);
  return `${input}.${b64url(sig)}`;
};

// the tax organisation's key comes as base64 DER (SPKI) or PEM
const publicKeyOf = (key: string) =>
  key.includes("BEGIN")
    ? crypto.createPublicKey(key)
    : crypto.createPublicKey({ key: Buffer.from(key.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });

export const encryptJwe = (plaintext: string, serverKey: string, kid: string) => {
  const header = b64url(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM", kid }));
  const cek = crypto.randomBytes(32);
  const ek = crypto.publicEncrypt(
    { key: publicKeyOf(serverKey), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    cek,
  );
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [header, b64url(ek), b64url(iv), b64url(ct), b64url(cipher.getAuthTag())].join(".");
};

// ------------------------------------------------------------------ keys

export const newKeyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

// public key as the portal's upload box takes it: base64 without the armour
export const bareKey = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

// DER, just enough of it for a PKCS#10 request
const len = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    let v = n >> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const printable = (s: string) => tlv(0x13, Buffer.from(s, "ascii"));
const rdn = (o: string, value: Buffer) => set(seq(oid(o), value));

export type CsrSubject = { name: string; nationalId: string; organization?: string };

// the request the portal (or a CA) signs into the certificate the token's
// x5c carries: C=IR, O, OU and CN the taxpayer's name, serialNumber the
// national id
export const makeCsr = (privateKeyPem: string, publicKeyPem: string, subject: CsrSubject) => {
  const name = seq(
    rdn("2.5.4.6", printable("IR")),
    rdn("2.5.4.10", utf8(subject.organization || "Non-Governmental")),
    rdn("2.5.4.11", utf8(subject.name)),
    rdn("2.5.4.3", utf8(subject.name)),
    rdn("2.5.4.5", printable(subject.nationalId.replace(/\D/g, "") || "0")),
  );
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const info = seq(tlv(0x02, Buffer.from([0])), name, spki, Buffer.from([0xa0, 0x00]));
  const sig = crypto.sign("RSA-SHA256", info, privateKeyPem);
  const der = seq(info, seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00])), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`;
};

// ------------------------------------------------------- sealed at rest

// AES-256-GCM under a key derived from the server's JWT secret (kept across
// setup.sh re-runs); a database dump alone does not give the private key
const sealKey = () => crypto.createHash("sha256").update(`moadian:${process.env.JWT_SECRET || ""}`).digest();

export const seal = (plain: string) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${b64url(iv)}.${b64url(ct)}.${b64url(c.getAuthTag())}`;
};

export const unseal = (sealed: string) => {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== "v1") throw new Error("bad sealed value");
  const d = crypto.createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
};
