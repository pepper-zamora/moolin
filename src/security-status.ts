import type { ConnectionState } from "./connection-manager";
import type { CertificateDetails, TlsInfo } from "./telnet";

export type Security = "trusted" | "untrusted" | "plaintext";

// How long the popup lingers after the pointer leaves the shield or popup,
// so it can be crossed from one to the other.
const HIDE_DELAY_MS = 200;

const NAME_ATTRIBUTES: Record<string, string> = {
  CN: "Common name",
  O: "Organization",
  OU: "Organizational unit",
  L: "Locality",
  ST: "State or province",
  C: "Country",
  emailAddress: "Email",
  serialNumber: "Serial number",
  DC: "Domain component",
};

// Plain-language versions of the OpenSSL/Node codes in certValidationError.
const VALIDATION_ERRORS: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: "The certificate is self-signed.",
  SELF_SIGNED_CERT_IN_CHAIN: "The certificate chain ends in an untrusted self-signed root.",
  UNABLE_TO_GET_ISSUER_CERT: "The certificate's issuer is unknown.",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "The certificate's issuer is unknown.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The certificate's issuer couldn't be verified.",
  CERT_HAS_EXPIRED: "The certificate has expired.",
  CERT_NOT_YET_VALID: "The certificate isn't valid yet.",
  CERT_REVOKED: "The certificate has been revoked.",
  ERR_TLS_CERT_ALTNAME_INVALID: "The certificate is for a different host name.",
};

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function securityOf(state: ConnectionState): Security | null {
  if (state.status !== "connected") return null;
  if (!state.tls) return "plaintext";
  return state.tls.certValid ? "trusted" : "untrusted";
}

function formatName(entries: Array<[string, string]>): string {
  return entries.map(([key, value]) => `${key}=${value}`).join(", ") || "unknown";
}

// "Server certificate", then "Intermediate" up to a final self-issued "Root".
export function certificateRole(cert: CertificateDetails, index: number, count: number): string {
  if (index === 0) return "Server certificate";
  const selfIssued = formatName(cert.subject) === formatName(cert.issuer);
  return index === count - 1 && selfIssued ? "Root certificate" : "Intermediate certificate";
}

// A definition list; rows with no value are left out. Every value is set as
// text, never HTML: it all comes from the server.
function details(rows: Array<[string, string | string[] | undefined, boolean?]>): HTMLDListElement {
  const list = make("dl");
  for (const [label, value, mono] of rows) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    if (values.length === 0) continue;
    list.append(make("dt", label));
    const dd = make("dd", undefined, mono ? "mono" : undefined);
    values.forEach((line, i) => {
      if (i > 0) dd.append(make("br"));
      dd.append(line);
    });
    list.append(dd);
  }
  return list;
}

function certificateSection(cert: CertificateDetails, index: number, count: number): HTMLElement[] {
  const subject: Array<[string, string]> = cert.subject.map(([key, value]) => [NAME_ATTRIBUTES[key] ?? key, value]);
  return [
    make("h3", certificateRole(cert, index, count)),
    details([
      ...subject,
      ["Alternative names", cert.subjectAltNames],
      ["Issued by", formatName(cert.issuer)],
      ["Valid from", cert.validFrom],
      ["Valid until", cert.validTo],
      ["Public key", cert.publicKey],
      ["Signature", cert.signatureAlgorithm],
      ["Key usage", cert.extendedKeyUsage],
      ["Certificate authority", cert.isCa ? "Yes" : "No"],
      ["Authority info", cert.infoAccess],
      ["Serial number", cert.serialNumber, true],
      ["SHA-256", cert.fingerprintSha256, true],
      ["SHA-1", cert.fingerprintSha1, true],
    ]),
  ];
}

export function validationProblem(tls: TlsInfo): string {
  const code = tls.certValidationError ?? "";
  const known = Object.entries(VALIDATION_ERRORS).find(([key]) => code.includes(key));
  return known ? `${known[1]} (${code})` : `Verification failed: ${code || "unknown error"}.`;
}

// The status bar's far-right shield and the details popup it opens on hover.
export class SecurityStatus {
  private readonly shield = element<HTMLSpanElement>("security-shield");
  readonly popup = element<HTMLDivElement>("security-popup");
  private readonly statusBar = element<HTMLDivElement>("status-bar");
  private state: ConnectionState | null = null;
  private hideTimer: number | undefined;

  constructor(
    // Called after the popup hides, to hand focus back.
    private readonly onHide: () => void,
  ) {
    for (const el of [this.shield, this.popup]) {
      el.addEventListener("mouseenter", () => this.show());
      el.addEventListener("mouseleave", () => this.scheduleHide());
    }
  }

  update(state: ConnectionState): void {
    this.state = state;
    const security = securityOf(state);
    this.shield.hidden = security === null;
    if (security === null) {
      this.hide();
      return;
    }
    this.shield.dataset.security = security;
    this.shield.setAttribute(
      "aria-label",
      { trusted: "Secure connection", untrusted: "Untrusted certificate", plaintext: "Not secure" }[security],
    );
    if (!this.popup.hidden) this.render(state, security);
  }

  // Text selected inside the popup, for Copy.
  selectedText(): string {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !this.popup.contains(selection.anchorNode)) return "";
    return selection.toString();
  }

  isHovered(): boolean {
    return !this.popup.hidden && this.popup.matches(":hover");
  }

  private show(): void {
    window.clearTimeout(this.hideTimer);
    const security = this.state && securityOf(this.state);
    if (!this.state || !security) return;
    if (this.popup.hidden) this.render(this.state, security);
    this.popup.style.bottom = `${window.innerHeight - this.statusBar.getBoundingClientRect().top + 4}px`;
    this.popup.hidden = false;
  }

  private scheduleHide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  private hide(): void {
    window.clearTimeout(this.hideTimer);
    if (this.popup.hidden) return;
    this.popup.hidden = true;
    this.onHide();
  }

  private render(state: ConnectionState, security: Security): void {
    this.popup.dataset.security = security;
    const title = make("div", undefined, "popup-title");
    const icon = make("span", undefined, "security-icon");
    icon.dataset.security = security;
    icon.append(this.shield.querySelector("svg")?.cloneNode(true) ?? "");
    title.append(
      icon,
      { trusted: "Secure connection", untrusted: "Encrypted, but not verified", plaintext: "Not secure" }[security],
    );
    const content: HTMLElement[] = [title];
    const tls = state.tls;
    if (!tls) {
      content.push(
        make(
          "p",
          "This connection isn't encrypted: anything sent over it, including your password, can be read " +
            "by anyone along the network path. Turn on Use TLS for this world if the server supports it.",
        ),
        details([["Server", state.address ?? undefined]]),
      );
    } else {
      content.push(
        make(
          "p",
          tls.certValid
            ? "The connection is encrypted and the server's certificate is trusted."
            : `The connection is encrypted, but the server's identity couldn't be verified. ${validationProblem(tls)} ` +
                "This world is set to accept untrusted certificates.",
        ),
        details([
          ["Server", state.address ?? undefined],
          ["Protocol", tls.protocol],
          ["Cipher", tls.cipherName],
          ["Key exchange", tls.keyExchange],
        ]),
      );
      tls.certificates.forEach((cert, i) => {
        content.push(...certificateSection(cert, i, tls.certificates.length));
      });
    }
    this.popup.replaceChildren(...content);
  }
}
