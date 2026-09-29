// Palette, mirroring the tokens in app.css. Needed as values because SVG
// strokes are written as attributes here, not as CSS.
export const GRN = "#3fd68c", RED = "#ff5f57", AMB = "#ffb340",
      GREY = "#6d6d77", DIM = "#4a4a52", VIO = "#a78bfa";

export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** The product's name until /api/config says otherwise (public-release Q1). */
export const BRAND = "Clank Uwu Model";

/**
 * The one official domain (L1 N-D1; the user, 2026-09-24). It moved here from
 * cumtrade.com, which only redirects to it. This is the only place the page
 * writes it.
 */
export const SITE_DOMAIN = "clankuwu.com";

/**
 * Where the source is published (public-release O1.4b). NOT CREATED YET:
 * `<repository>` is a placeholder, shown as it is, like the domain. Once it is
 * a URL, the About page links to it, and to the checker's rules at the commit
 * the page was released from.
 */
export const SOURCE_REPO = "<repository>";

/**
 * This project's token on clank.trade (public-release Q1, Q7). The operator
 * holds it, and the About page says so plainly, with its address, so anyone
 * can find it on the board and check it like any other launch.
 */
export const PROJECT_TOKEN = { symbol: "$CUM", address: "0xB90AD88c8ECD9F22a05Cd8Cb365542614F279ca9" };

/**
 * The release stage, shown on a hosted page only (F5.3, the user, 2026-09-23):
 * the badge beside the brand, the notice bar, and the About page's section on
 * it. "" drops all three, so leaving beta is a one-line change here.
 */
export const STAGE = "Beta";

/**
 * Where to report problems: the operator's public dev account on X, which the
 * user chose to publish (2026-09-23). The About page links to it, with
 * rel="noopener noreferrer".
 */
export const CONTACT = { label: "@0xzer0ai on X", href: "https://x.com/0xzer0ai" };
/** The community's Telegram group (the user, 2026-09-27: "https://t.me/clankuwu deploy this on website"). */
export const COMMUNITY = { label: "t.me/clankuwu on Telegram", href: "https://t.me/clankuwu" };

/**
 * The version of the terms this site shows, as a date. Signing in to cumAI
 * accepts exactly these, and the trading wallet signs nothing else
 * (stage C, C-D2). The gateway's TERMS_VERSION must match it: C6 moves this
 * with the terms' text, and C7 moves the gateway's straight after.
 */
export const TERMS_VERSION = "2026-09-26";
