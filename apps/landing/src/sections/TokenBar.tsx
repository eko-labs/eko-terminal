import { useEffect, useState } from "react";

type Token = { address: string; symbol?: string };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Copy text: the Clipboard API, else a selected textarea and execCommand (older or locked-down browsers). */
const copyText = (text: string): Promise<void> =>
  navigator.clipboard?.writeText(text).catch(() => legacyCopy(text)) ?? legacyCopy(text);
function legacyCopy(text: string): Promise<void> {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
}
/** One config read per page, shared by the intro's bar and the page's. */
let loaded: Promise<Token | null> | null = null;
const loadToken = () =>
  (loaded ??= fetch("/v1/config")
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { token?: Token } | null) =>
      c?.token && ADDRESS.test(c.token.address) ? { address: c.token.address, ...(c.token.symbol ? { symbol: c.token.symbol } : {}) } : null)
    .catch(() => null));

/**
 * The project's token contract address with a copy button, across the top of the page. It comes from the edge's
 * /v1/config (`token`, set by EKO_TOKEN_ADDRESS), so it can be set or changed without a new build; nothing shows until
 * the edge serves one. `floating`: over the opening animation, which covers the page until it ends or is skipped.
 */
export default function TokenBar({ floating = false }: { floating?: boolean }) {
  const [token, setToken] = useState<Token | null>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    void loadToken().then((t) => { if (live) setToken(t); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  if (!token) return null;
  const label = token.symbol ? `$${token.symbol} CA` : "CA";
  const copy = () => void copyText(token.address).then(() => setCopied("ok"), () => setCopied("failed"));
  return (
    <div className={`eko-token-bar${floating ? " floating" : ""}`}>
      <button type="button" className={`eko-token-ca${copied === "ok" ? " copied" : ""}`} onClick={copy} aria-label={`Copy ${label}: ${token.address}`}>
        <span className="eko-token-label">{label}</span>
        <span className="eko-token-addr" title={token.address}>{floating ? `${token.address.slice(0, 6)}…${token.address.slice(-4)}` : token.address}</span>
        <span className="eko-token-act" aria-live="polite">{copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}</span>
      </button>
    </div>
  );
}
