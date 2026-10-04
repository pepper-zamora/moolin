import { test } from "node:test";
import assert from "node:assert/strict";
import { certificateRole, securityOf, validationProblem } from "./security-status";
import type { CertificateDetails, TlsInfo } from "./telnet";

function tlsInfo(overrides: Partial<TlsInfo> = {}): TlsInfo {
  return { protocol: "TLSv1.3", cipherName: "TLS_AES_128_GCM_SHA256", certValid: true, certificates: [], ...overrides };
}

function cert(subject: string, issuer: string): CertificateDetails {
  return {
    subject: [["CN", subject]],
    issuer: [["CN", issuer]],
    subjectAltNames: [],
    serialNumber: "01",
    validFrom: "",
    validTo: "",
    publicKey: "",
    extendedKeyUsage: [],
    isCa: false,
    infoAccess: [],
    fingerprintSha256: "",
    fingerprintSha1: "",
  };
}

test("securityOf grades a connection only once it's connected", () => {
  const base = { label: "Moo", address: "moo:7777" };
  assert.equal(securityOf({ ...base, status: "connecting", tls: null }), null);
  assert.equal(securityOf({ ...base, status: "disconnected", tls: null }), null);
  assert.equal(securityOf({ ...base, status: "connected", tls: null }), "plaintext");
  assert.equal(securityOf({ ...base, status: "connected", tls: tlsInfo() }), "trusted");
  assert.equal(securityOf({ ...base, status: "connected", tls: tlsInfo({ certValid: false }) }), "untrusted");
});

test("certificateRole names the server, intermediate and self-issued root certificates", () => {
  const chain = [cert("moo.example", "Intermediate"), cert("Intermediate", "Root"), cert("Root", "Root")];
  assert.deepEqual(
    chain.map((c, i) => certificateRole(c, i, chain.length)),
    ["Server certificate", "Intermediate certificate", "Root certificate"],
  );
  // A chain that stops short of a self-issued root ends in an intermediate.
  assert.equal(certificateRole(chain[1], 1, 2), "Intermediate certificate");
  // A self-signed server certificate is still the server's.
  assert.equal(certificateRole(cert("moo", "moo"), 0, 1), "Server certificate");
});

test("validationProblem explains known OpenSSL codes and passes others through", () => {
  assert.equal(
    validationProblem(tlsInfo({ certValid: false, certValidationError: "DEPTH_ZERO_SELF_SIGNED_CERT" })),
    "The certificate is self-signed. (DEPTH_ZERO_SELF_SIGNED_CERT)",
  );
  assert.equal(
    validationProblem(tlsInfo({ certValid: false, certValidationError: "SOMETHING_NEW" })),
    "Verification failed: SOMETHING_NEW.",
  );
  assert.equal(validationProblem(tlsInfo({ certValid: false })), "Verification failed: unknown error.");
});
