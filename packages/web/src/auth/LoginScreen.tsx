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
  return (
    <div className="rc-login">
      <section className="rc-login__card rc-glass">
        <header className="rc-login__brand">
          <span className="rc-login__mark" aria-hidden="true">
            <Icon name="terminal" size={20} />
          </span>
          <span className="display rc-login__wordmark">remote-coder</span>
        </header>

        <p className="rc-login__lede">Enter the access token from your server to connect.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onAuthenticated(token);
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

          <button type="submit" className="rc-login__connect">
            Connect
          </button>
        </form>

        <div className="rc-login__divider" role="presentation" />

        <button type="button" className="rc-login__dev" onClick={() => onAuthenticated("")}>
          Connect without a token (local dev)
        </button>

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
  /* Transparent so the global warm-dark atmosphere (grain + vignette + the soft top lift) shows
     through behind the floating glass card — the accents are the coral mark + the Connect CTA. */
  background: transparent;
}
/* The login card — liquid glass (translucent warm fill + heavy blur, the 4-layer thickness shadow,
   refraction rim + specular sweep) floating over the warm-dark atmosphere. The .rc-glass class on the
   element supplies the material + the ::before/::after; this only sizes + rounds it. */
.rc-login__card {
  width: min(92vw, 400px);
  display: grid; gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-5);
  border-radius: var(--radius-lg);
}
.rc-login__brand { display: flex; align-items: center; gap: var(--sp-3); }
/* The coral brand mark — a clay-coral tile with a soft glow + inset top highlight (spec .mark). The
   ONE coral moment in the brand row; the terminal glyph reads in warm near-white. */
.rc-login__mark {
  width: 40px; height: 40px; flex: none;
  display: grid; place-items: center;
  border-radius: var(--radius-sm);
  background: var(--tile-bg);
  color: #fff3ea;
  box-shadow: inset 0 1px 0 rgba(255, 240, 230, 0.6), 0 6px 16px -6px rgba(247, 124, 68, 0.85),
    0 0 16px -3px rgba(247, 124, 68, 0.45);
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
/* The single coral primary — the Connect CTA. A clay-coral gradient with the liquid-glass glow halo
   + inset top highlight, DARK ink label (--on-accent), never white (spec). */
.rc-login__connect {
  min-height: var(--tap-min);
  border: none; border-radius: var(--radius); cursor: pointer;
  background: var(--accent-grad);
  color: var(--on-accent);
  font-family: var(--font-display); font-weight: 600; font-size: var(--fs-base);
  box-shadow: var(--shadow-pop);
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.rc-login__connect:hover { transform: translateY(-1px); box-shadow: var(--shadow-pop), 0 12px 44px -8px rgba(247, 124, 68, 0.55); }
.rc-login__divider { height: 1px; background: var(--border); }
.rc-login__dev {
  min-height: var(--tap-min);
  background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius); cursor: pointer;
  color: var(--text-muted); font: inherit;
  transition: color 120ms ease, border-color 120ms ease;
}
.rc-login__dev:hover { color: var(--text); border-color: var(--text-faint); }
.rc-login__note { margin: 0; color: var(--text-faint); font-size: var(--fs-xs); text-align: center; }
`;
