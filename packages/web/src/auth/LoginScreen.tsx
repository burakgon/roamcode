import { useState } from "react";
import { Icon } from "../ui/Icon";

export interface LoginScreenProps {
  onAuthenticated: (token: string) => void;
  initialError?: string;
}

/**
 * The first impression — a calm, centered token-entry card (Variant A). The wordmark sits in the
 * display font over a soft radial wash; the token field carries a clear label, a lock affordance,
 * and an assertively-announced error state; "Connect" is the single amber primary action. A quiet
 * tokenless local-dev path stays available beneath a hairline divider.
 */
export function LoginScreen({ onAuthenticated, initialError }: LoginScreenProps) {
  const [token, setToken] = useState("");
  // The tokenless "local dev" path only works on a loopback bind (the server refuses it otherwise → a
  // confusing 401). Hide it on a real/remote deployment so it isn't an attractive-nuisance dead end.
  const isLocalDev =
    typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(location.hostname);
  return (
    <div className="rc-login">
      <section className="rc-login__card rc-glass--float">
        <header className="rc-login__brand">
          <span className="rc-login__mark" aria-hidden="true">
            <Icon name="terminal" size={20} />
          </span>
          <span className="display rc-login__wordmark">Remote Coder</span>
        </header>

        <p className="rc-login__lede">
          Enter the access token your server printed — it&apos;s in the connect link (re-open that link on this device),
          or copy it from the server console. If a link stopped working, it may have rotated — open the latest one.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Trim — a pasted token with trailing whitespace/newline would otherwise 401. Empty falls
            // through to the explicit "Connect without a token" path (don't silently collapse the two).
            const t = token.trim();
            if (!t) return;
            onAuthenticated(t);
          }}
          className="rc-login__form"
        >
          {initialError && (
            <div role="alert" aria-live="assertive" className="rc-login__error">
              <Icon name="alert" size={16} />
              <span>{initialError}</span>
            </div>
          )}

          <label className="rc-login__field">
            <span className="rc-login__label">Access token</span>
            <span className="rc-login__input">
              <span className="rc-login__input-icon" aria-hidden="true">
                <Icon name="lock" size={16} />
              </span>
              <input
                id="token"
                name="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                placeholder="paste your token"
              />
            </span>
          </label>

          <button type="submit" className="rc-login__connect" disabled={token.trim() === ""}>
            Connect
          </button>
        </form>

        {isLocalDev && (
          <>
            <div className="rc-login__divider" role="presentation" />
            <button type="button" className="rc-login__dev" onClick={() => onAuthenticated("")}>
              Connect without a token (local dev)
            </button>
          </>
        )}

        <p className="rc-login__note">The token is stored in this browser only (localStorage).</p>
      </section>

      <style>{loginCss}</style>
    </div>
  );
}

const loginCss = `
.rc-login {
  min-height: 100%;
  display: grid; place-items: center;
  padding: var(--sp-5);
  /* The clean near-black base + the one faint top glow behind the floating card; the accents are the
     coral mark glyph + the Connect CTA. */
  background-color: var(--bg);
  background-image: var(--top-glow);
}
/* The login card — a clean floating-glass card (the .rc-glass--float class supplies the subtle fill +
   blur + the --line-2 border); this only sizes + rounds it. */
.rc-login__card {
  width: min(92vw, 400px);
  display: grid; gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-5);
  border-radius: var(--radius-lg);
}
.rc-login__brand { display: flex; align-items: center; gap: var(--sp-3); }
/* The brand mark — a flat elevated tile + a --line-2 edge; the ONE coral here is the GLYPH (spec
   .mark), NOT a coral fill. No glow. */
.rc-login__mark {
  width: 36px; height: 36px; flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius-sm);
  background: var(--tile-bg);
  border: 1px solid var(--tile-edge);
  color: var(--coral);
}
.rc-login__wordmark { font-size: var(--fs-2xl); letter-spacing: 0.01em; color: var(--text); }
.rc-login__lede { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
.rc-login__form { display: grid; gap: var(--sp-4); }
.rc-login__error {
  display: flex; align-items: center; gap: var(--sp-2);
  color: var(--err); font-size: var(--fs-sm);
  background: var(--err-bg); border: 1px solid var(--err-border);
  border-radius: var(--radius-sm); padding: var(--sp-2) var(--sp-3);
}
.rc-login__field { display: grid; gap: var(--sp-2); }
.rc-login__label { font-size: var(--fs-sm); color: var(--text-muted); }
.rc-login__input {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: var(--tap-min);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0 var(--sp-3);
  transition: border-color 120ms ease;
}
.rc-login__input:focus-within { border-color: var(--accent-line); box-shadow: var(--focus-glow); }
.rc-login__input-icon { color: var(--text-faint); display: grid; place-items: center; }
.rc-login__input input {
  flex: 1; min-width: 0; min-height: var(--tap-min);
  background: transparent; border: none; outline: none;
  color: var(--text); font-family: var(--font-mono); font-size: var(--fs-base);
}
.rc-login__input input::placeholder { color: var(--text-faint); }
/* The single coral primary — the Connect CTA. A FLAT coral fill, DARK ink label (--on-accent), never
   white (spec). No glow. */
.rc-login__connect {
  min-height: var(--tap-min);
  border: none; border-radius: var(--radius); cursor: pointer;
  background: var(--accent-grad);
  color: var(--on-accent);
  font-family: var(--font-display); font-weight: 600; font-size: var(--fs-base);
  transition: filter 120ms ease;
}
.rc-login__connect:hover:not(:disabled) { filter: brightness(1.08); }
.rc-login__connect:disabled { opacity: 0.45; cursor: default; }
.rc-login__divider { height: 1px; background: var(--border); }
.rc-login__dev {
  min-height: var(--tap-min);
  background: transparent; border: 1px solid var(--border-strong);
  border-radius: var(--radius); cursor: pointer;
  color: var(--text-muted); font: inherit;
  transition: color 120ms ease, border-color 120ms ease;
}
.rc-login__dev:hover { color: var(--text); border-color: var(--border-strong); }
.rc-login__note { margin: 0; color: var(--text-faint); font-size: var(--fs-xs); text-align: center; }
`;
