import { S } from "../core/store.js";
import { acknowledgeTrading } from "../trade/acknowledge.js";
import { connect, provider as mainProvider } from "./eip6963.js";
import { createSession as createCore } from "./sessionCore.js";

// cumOS's trading-wallet session: the shared session (sessionCore.js) with
// cumOS's state, its acknowledgement sheet and its own-wallet door (F2).

export {
  ACTIVE_KEY, CHANNEL, IDLE_MS, METHOD_KEY, METHODS, OAUTH_PARAMS, SHARE_MS, SKEW_MS, TRADE_LOCK, WARN_MS,
} from "./sessionCore.js";

/**
 * A session with cumOS's own parts; `d` overrides any of them (the tests').
 * @param {Partial<Parameters<typeof createCore>[0]>} [d]
 */
export const createSession = (d = {}) => createCore({
  state: S, acknowledge: acknowledgeTrading, main: { connect, provider: mainProvider }, ...d,
});

/** The page's own session. Inert until main.js calls `detect()` and `boot()` on a hosted page. */
export const session = createSession();
