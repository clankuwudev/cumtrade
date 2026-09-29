// ====================================================================== //
// what the trading wallet's money steps say                              //
// ====================================================================== //
//
// The words every step that moves money, or backs up the key, repeats
// (public-release W4 and W2.2). One place, so the backup sheet, the panel,
// the fund step and the withdraw step cannot drift apart.
//
// Against clone sites, each money step names the site it is on: a clone
// copies our page, but it cannot show our origin in its own address bar.

/** The warning, with no cap (W2.2): beside the balance in the panel. */
export const MONEY_WARNING = "Trading money only. This wallet signs trades without asking you. Anyone who " +
  "controls this page's code, or this browser while you are logged in, can move what is in it. Keep here only " +
  "what you are ready to trade.";

/** What Withdraw all leaves behind (W2.2). */
export const TOKENS_STAY = "Tokens stay here. Sell them first, or keep them: your backup key controls them too.";

/** Why a Google or X visitor is asked to connect a wallet before Fund or Withdraw all (TW4). */
export const WHY_MAIN = "Withdrawals only go to a wallet you connect.";

/**
 * The site this page is on, read from the page itself: its host, with the
 * port when there is one ("cumtrade.com", "localhost:8790"), and no scheme
 * (the user, 2026-09-23). Never a name from our server or from storage.
 */
export const here = () => String(globalThis.location?.host ?? "");

/** The domain line of a money step (the edge cases' clone sites). */
export const domainLine = (origin = here()) => `You are on ${origin}. Only fund a trading wallet on this site.`;

/**
 * The backup sheet's and the fund step's warning: one short paragraph, beta
 * first (the user, 2026-09-23).
 */
export const betaLine = (origin = here()) => `Beta: new software. Keep only trading money here. ${domainLine(origin)}`;
