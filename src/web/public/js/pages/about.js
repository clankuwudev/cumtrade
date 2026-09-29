import { S } from "../core/store.js";
import { $, html, paint } from "../core/dom.js";
import { COMMUNITY, CONTACT, EXPLORER, PROJECT_TOKEN, SITE_DOMAIN, SOURCE_REPO, STAGE, TERMS_VERSION } from "../core/constants.js";
import { BANDS } from "../core/domain.js";
import { MAX_SENDS_PER_MINUTE } from "../trade/constants.js";
import { IDLE_MS } from "../wallet/session.js";
import { apiBody } from "./apiDocs.js";

// ====================================================================== //
// about, terms and privacy (public-release F5.3)                          //
// ====================================================================== //
//
// One page of sections, hosted only: what this is, the beta, advice,
// affiliation, the $CUM disclosure, verdicts, moderation, the trust model,
// the one official domain, the source, the terms and privacy. Each section is
// its own link, #/learn/<id>, which is how the footer reaches Terms and
// Privacy and the beta notice reaches the beta section. Since U6 the page is
// Learn's (pages/learn.js): its contents sit beside it, not on it.
//
// This is legal-adjacent text. Every sentence is meant to be true of the site
// as it ships, and nothing more. The words for affiliation, the conflict,
// privacy and the terms still go through the pre-launch gates (f-client.md,
// F5.3); this is the page they land in.

/** The sections, in order. `when` leaves a section out, such as the beta's once STAGE is "". */
export const ABOUT_SECTIONS = [
  { id: "what", label: "About" },
  { id: "beta", label: "Beta", when: () => Boolean(STAGE) },
  { id: "advice", label: "Not advice" },
  { id: "affiliation", label: "clank.trade" },
  { id: "cum", label: PROJECT_TOKEN.symbol },
  { id: "verdicts", label: "Verdicts" },
  { id: "moderation", label: "Moderation" },
  { id: "trust", label: "Trust" },
  { id: "official", label: "Official site" },
  { id: "source", label: "Source" },
  // Learn lists it under Developers, not About (X21).
  { id: "api", label: "Data API" },
  { id: "terms", label: "Terms" },
  { id: "privacy", label: "Privacy" },
];

const shown = () => ABOUT_SECTIONS.filter((s) => !s.when || s.when());

/** The sections this page shows, in order: Learn's contents list them. */
export const aboutSections = shown;

/** Whether `id` names a section this page shows, so a URL can scroll to it. */
export const isAboutSection = (id) => shown().some((s) => s.id === id);

/** A value not chosen yet, such as `<repository>`. */
const isPlaceholder = (v) => /^<[^>]+>$/.test(v);

/** A value in code type, marked when it holds a placeholder (`<repository>`) so no one mistakes it for the real one. */
const value = (v) => /<[^>]+>/.test(v)
  ? html`<code class="mo ph" title="A placeholder: not chosen yet">${v}</code>`
  : html`<code class="mo">${v}</code>`;

/** A link that leaves the site: a new tab, and no opener or referrer. */
const out = (href, text) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

const site = () => value(`https://${SITE_DOMAIN}`);

const contact = () => html`${out(CONTACT.href, CONTACT.label)} or ${out(COMMUNITY.href, COMMUNITY.label)}`;

/** The commit this page was released from, as its footer names it (H1.2), or null on a local run. */
const releaseSha = () => {
  const t = String($("#release")?.textContent ?? "").trim();
  return /^[0-9a-f]{40}$/.test(t) ? t : null;
};

/**
 * A file of the published source: a link at the released commit once the
 * repository exists and the page was released, otherwise its path.
 */
const sourceFile = (path) => {
  const sha = releaseSha();
  return !isPlaceholder(SOURCE_REPO) && sha
    ? out(`${SOURCE_REPO.replace(/\/+$/, "")}/blob/${sha}/${path}`, html`<code class="mo">${path}</code>`)
    : value(path);
};

const section = (id, title, body, cls = "") =>
  html`<section class="card cardpad about${cls ? " " + cls : ""}" id="about-${id}"><h2>${title}</h2>${body}</section>`;

// ------------------------------------------------------------- sections --

const what = (brand) => section("what", "What this is", html`
  <p>${brand} is a web app for tokens launched on clank.trade, on Robinhood Chain (chain ID 4663).
    It checks each new launch automatically, shows the positions of any address, and lets you trade
    from a wallet you control.</p>
  <p>It never trades on its own. Every trade is one you start.</p>
  <p>It is run by an independent operator. On this page, &ldquo;we&rdquo; means that operator.
    To reach us, write to ${contact()}.</p>`);

const beta = (brand) => section("beta", `This is ${STAGE.toLowerCase()} software`, html`
  <p>${brand} is new. Features can change, move or stop working without notice, and some of them
    have bugs.</p>
  <p>A bug can cost money: a wrong number on the page, a trade that fails, or a trade that does not
    do what you expected. A transaction on the chain cannot be undone.</p>
  <p><b>Keep only trading money in your trading wallet: an amount you are ready to lose.</b></p>
  <p>To report a problem, write to ${contact()}. Say what you did, what you expected and what
    happened. Never send a private key, a recovery phrase or a password. We will never ask for
    one.</p>`, "warn");

const advice = () => section("advice", "Not financial advice", html`
  <p>Nothing on this site is financial, investment, legal or tax advice. A verdict is the result of
    automated checks, not a recommendation to buy, sell or hold anything.</p>
  <p>Tokens launched on clank.trade are highly speculative. Their price can fall fast, and you can
    lose some or all of what you put in. Nothing here promises a profit.</p>`);

const affiliation = (brand) => section("affiliation", "Not affiliated with clank.trade", html`
  <p>${brand} is an independent project. clank.trade did not make it, does not run it, and has not
    reviewed or endorsed it.</p>
  <p>clank.trade&rsquo;s name and marks belong to clank.trade. Where they appear on this site,
    including in the mascot&rsquo;s design, that does not mean clank.trade approved it.</p>
  <p>Nor are we affiliated with Robinhood, Coinbase or Uniswap. We use their networks, services and
    contracts like anyone else.</p>`);

const cum = () => {
  const { symbol, address } = PROJECT_TOKEN;
  return section("cum", `We hold ${symbol}`, html`
    <p><b>We hold ${symbol}, this project&rsquo;s token on clank.trade.</b> Its price matters to us,
      and ${symbol} can appear on the board and in search like any other token.</p>
    <p>Its address is ${value(address)}. Search for it to see its verdict, or open it
      ${out(`https://clank.trade/token/${address}`, "on clank.trade")} or
      ${out(`${EXPLORER}/address/${address}`, "in the explorer")}.</p>
    <p>We also trade tokens launched on clank.trade, including with automated tools of our own, which
      run apart from this site. So we may hold tokens that appear on this board, and buy or sell them
      at any time.</p>
    <p>Judge what you read here knowing that. Every token, ${symbol} and the ones we hold included,
      goes through the same automated checks, and no one can set a single token&rsquo;s verdict by
      hand. The checks are in the published source (below), so you can read them and run them
      yourself.</p>`);
};

const verdicts = () => {
  const labels = Object.values(BANDS).map(([, words]) => words);
  return section("verdicts", "How verdicts are made", html`
    <p>Our server runs the same checks on every launch, against the chain:</p>
    <ul>
      <li><b>Authenticity.</b> The token and its curve are in clank.trade&rsquo;s factory registry.
        This catches impersonators.</li>
      <li><b>Bytecode.</b> The token&rsquo;s code matches the standard launch token&rsquo;s.</li>
      <li><b>Sellability.</b> A buy and then a sell are simulated on the chain.</li>
      <li><b>Distribution.</b> The creator&rsquo;s own buy, and other buys in the launch block.</li>
      <li><b>Creator record.</b> What the creator&rsquo;s earlier launches raised.</li>
      <li><b>Economics.</b> Price, fees, the snipe tax, and progress to graduation.</li>
    </ul>
    <p>Each token then gets one of ${labels.length} verdicts: ${labels.slice(0, -1).join(", ")} or
      ${labels[labels.length - 1]}.</p>
    <p>&ldquo;${BANDS.CLEAN[1]}&rdquo; means only that these checks found nothing wrong when they
      ran. It does not mean a token is a good buy, that its price will hold, or that you will be able
      to sell it later. The checks can be wrong, they cannot see what people will do next, and the
      chain moves on after a check.</p>
    <p>The rules are in the source, in ${sourceFile("src/core/checker/rules.ts")}, at the commit
      named at the foot of every page.</p>
    <p><b>&ldquo;Your sell&rdquo; on the Portfolio is not a verdict.</b> It judges a sale, not a
      token: Paperhand when the tokens sold would fetch more today than the sale got, by at least
      10% of what it got and 0.0005&nbsp;ETH, and Good sell when they would not. It looks back at
      a price that has already moved, so it says nothing about what to do next.</p>`);
};

const moderation = () => section("moderation", "Moderation", html`
  <p>A creator writes a token&rsquo;s name and description and uploads its picture. If those are
    abusive, for example a picture no one should be shown or a name that impersonates a real
    person, we may hide them.</p>
  <p>Hiding never touches a verdict: the token stays on the board, with the same verdict and the
    same findings. Every token we hide will be on a public list in the source, with the reason.</p>
  <p>To report a token, write to ${contact()} with its address and what is wrong with it.</p>`);

/** The trust model: the trading wallet where this origin has one (W1.2), otherwise the visitor's own wallet. */
const trust = () => {
  const idle = Math.round(IDLE_MS / 60_000);
  const body = S.login.here ? html`
  <p>You log in with a browser wallet, a Google account or an X account. The page then gets a
    trading wallet for you from Coinbase&rsquo;s embedded wallet service. You fund it from your own
    wallet, and after that it signs trades with no pop-up.</p>
  <ul>
    <li>We never hold its key. Coinbase holds it, tied to your login. At setup you export it once,
      as a backup.</li>
    <li>Withdraw all sends what it holds to the wallet you connected, and nowhere else.</li>
    <li>After ${idle} minutes with no activity, the page logs you out.</li>
    <li>It sends at most ${MAX_SENDS_PER_MINUTE} transactions a minute.</li>
    <li>Our server has no code that can hold a key or sign a transaction.</li>
  </ul>
  <p>What that does not protect you from:</p>
  <ul>
    <li><b>Whoever controls the code this page runs can move what is in your trading wallet while
      you are logged in,</b> because the page signs without asking you. That includes us, since we
      deploy it, and anyone who takes over our deploy access. Every web wallet works this way.</li>
    <li><b>So keep only trading money in the trading wallet.</b> Keep the rest in a wallet of your
      own.</li>
    <li>Anyone using this browser while you are logged in can trade and withdraw. Do not log in on a
      shared computer.</li>
    <li>A browser extension can read and change any page you open. Nothing we do reaches it.</li>
  </ul>` : html`
  <p>You trade from your own browser wallet. It asks you to confirm every transaction.</p>
  <ul>
    <li>We never hold a key. Our server has no code that can hold one or sign a transaction.</li>
    <li>Before your wallet is asked, the page checks the plan our server sent: which contract it
      calls, what it approves, and the price, against its own reads of the chain.</li>
  </ul>
  <p>What that does not protect you from:</p>
  <ul>
    <li><b>Whoever controls the code this page runs could show you a different plan.</b> That
      includes us, since we deploy it. Read what your wallet asks you to sign before you
      confirm.</li>
    <li>A browser extension can read and change any page you open. Nothing we do reaches it.</li>
  </ul>`;
  return section("trust", "What you are trusting", html`${body}
  <p>Smart-contract wallets, such as a multisig or Coinbase Smart Wallet, have not been tested with
    this site on Robinhood Chain yet. Until they have, trade from an ordinary wallet.</p>`);
};

const official = () => section("official", "One official site", html`
  <p>The only official address of this site is ${site()}. Only log in, and only fund a trading
    wallet, there. Copies of this site can look exactly the same.</p>
  <p><b>We never ask anyone to move funds.</b> We will never ask you to send funds to another
    address, to &ldquo;migrate&rdquo; a wallet, or to use another site. We will never ask for a
    private key, a recovery phrase or a password. Anyone who does is not us.</p>`);

const source = () => section("source", "The source, and checking the live site", html`
  <p>The source of this site, the page and its server, is published under the MIT licence at
    ${isPlaceholder(SOURCE_REPO) ? value(SOURCE_REPO) : out(SOURCE_REPO, SOURCE_REPO)}. Anyone can read
    it, run it and check it.</p>
  <p>Every release is built from one commit of that source, and the foot of every page names the
    commit. To check that the live site is exactly that commit, run this from a copy of the
    source:</p>
  <pre class="mo">node scripts/verify-live.mjs https://${SITE_DOMAIN}</pre>
  <p>It fetches the live page and every file it serves, and compares them with the commit, byte for
    byte.</p>
  <p>The trading wallet&rsquo;s code comes from Coinbase. The source includes how to build it, and
    the hash of the file this site serves.</p>`);

const terms = () => section("terms", "Terms of use", html`
  <p>By using this site, or by signing in to cumAI, you agree to these terms. If you do not agree, do
    not use it. You must be old enough to agree to these terms where you live.</p>
  <p class="mo">Version ${TERMS_VERSION}</p>
  <ol>
    <li>The site is provided as it is, without warranty of any kind.${STAGE ? ` It is ${STAGE.toLowerCase()} software.` : ""}
      It can be wrong, slow or unavailable.</li>
    <li>It is a tool, not a service that trades for you. You decide every trade, and you are
      responsible for it. A transaction on the chain cannot be undone, by you or by us.</li>
    <li>We never hold your funds or your keys, so we cannot recover them, reverse a trade or refund a
      loss.</li>
    <li>Verdicts, prices, positions and profit and loss are estimates from automated reads of the
      chain. They can be late, incomplete or wrong. Check them before you rely on them.</li>
    <li>You are responsible for following the laws that apply to you. Do not use this site where
      trading these tokens is not allowed.</li>
    <li>Do not use the site to break the law, to attack it or its users, or to overload it.</li>
    <li>Logging in, the trading wallet, your browser wallet, Robinhood Chain, Uniswap, clank.trade,
      and the AI model suppliers and makers behind cumAI, are other companies&rsquo; services, under
      their own terms. We are not responsible for them.</li>
    <li>As far as the law allows, we are not liable for any loss that comes from using this site,
      including losses caused by bugs, failed or delayed transactions, wrong data, or those other
      services.</li>
    <li>We may change, pause or stop the site or any part of it, at any time, without notice. We may
      change these terms too. The terms that apply are the ones on this page, at the commit named at
      its foot.</li>
  </ol>
  <h3>cumAI</h3>
  <ol start="10">
    <li>cumAI passes your requests to AI models made by other companies. Their answers are written by
      those models, not by us or by clankchan. They can be wrong, out of date, made up or offensive.
      Check anything that matters before you rely on it.</li>
    <li><b>No answer is financial, investment, legal or tax advice,</b> and nothing a model says is a
      reason to buy, sell or hold any token. The models know nothing live about prices, tokens or
      markets.</li>
    <li>cumAI is not our support. It cannot see your account, your wallets or your trades.</li>
    <li><b>Never paste a recovery phrase, private key, password or API key.</b> cumAI refuses text that
      looks like a recovery phrase, but that check can miss one. Whoever has it has the wallet.</li>
    <li>Every prompt is checked against a content policy before any model sees it. A prompt that breaks
      it is refused, and a key or wallet that keeps sending them is paused for a while. Do not use
      cumAI for anything illegal, to harm anyone, or to get around that check.</li>
    <li><b>The free playground</b> gives each signed-in wallet a small allowance a day and a few free
      pictures, while the day&rsquo;s shared budget lasts. It has no cash value, doesn&rsquo;t carry over, and can&rsquo;t
      be moved or sold. Using several wallets to take more than one allowance is not allowed. We may
      change the allowance, the model or the rules, or stop the playground, at any time.</li>
    <li>Models, their prices and their availability change. The status we show is measured, not
      promised.</li>
    <li><b>Signing in to cumAI means signing a message</b> in your wallet. It costs nothing and moves
      nothing. It names this site, and the version of these terms you accept. When the terms change,
      you&rsquo;re asked to sign in again to accept the new ones.</li>
    <li><b>cumAI can make pictures.</b> A picture is made by another company&rsquo;s model and can be
      wrong, odd or unlike what you asked for. Every picture is checked, with its prompt, against a
      content policy before you see it; one that breaks it is withheld, and still counts against your
      allowance or balance, because it was made. You are responsible for what you ask for and for
      what you do with a picture: don&rsquo;t use one to pass yourself off as a real person or a
      company, as a token&rsquo;s official art, or to break anyone&rsquo;s rights.</li>
  </ol>`);

const privacy = () => section("privacy", "Privacy", html`
  <p>No cookies from us on this site, no analytics, no ads and no trackers. Signing in to cumAI is
    the one exception, below. The page talks only to our servers, to Robinhood Chain&rsquo;s public
    node and, when you log in, to Coinbase.</p>
  <h3>Logging in</h3>
  <p>Logging in with Google, X or a wallet makes an account with Coinbase, not with us. Coinbase sees
    your Google or X identity and your trading wallet&rsquo;s address. Your Google or X identity,
    email and handle never reach our server.</p>
  <h3>What our server receives</h3>
  <ul>
    <li>A wallet&rsquo;s address, when the page looks up its positions or holdings, and when you ask
      our server to prepare a trade from it. That includes your own wallets while they are connected
      or logged in.</li>
    <li>Addresses, and everything done with them, are public on the chain. Even so, our server does
      not record which addresses were looked up or traded. It keeps counts, not addresses.</li>
    <li>Our web server&rsquo;s log keeps each request&rsquo;s method, path, status, size and time. It
      leaves out the query string, your IP address and your browser&rsquo;s headers. Older entries
      are deleted as the log fills: at most five files of 50 MB are kept.</li>
    <li>Your IP address is used in memory, to limit how many requests one network can make. It is
      not written to a log or a file.</li>
    <li><b>Cloudflare:</b> pages and the site&rsquo;s data pass through Cloudflare on the way to you,
      which handles them under its own privacy policy. It sees your IP address and which pages you
      open. cumAI&rsquo;s API, <code>api.clankuwu.com</code>, does not go through it.</li>
  </ul>
  <h3>What your browser keeps</h3>
  <p>This page keeps a few things in your browser: your quick-buy size and slippage; the tokens you
    bought here, so their Sell buttons are still there after a reload; which browser wallet you
    connected last; the login method you used last; the time of your last activity while logged in
    (for the automatic logout); the times of your trading wallet&rsquo;s recent transactions (for
    the limit of ${MAX_SENDS_PER_MINUTE} a minute); whether you have backed up your trading
    wallet&rsquo;s key (filed under a one-way hash of its address, not the address); and whether you have accepted the notices or
    closed the ${STAGE ? STAGE.toLowerCase() + " " : ""}notice. None of it is your address, an email
    or a name, and none of it is sent to us. Coinbase&rsquo;s code keeps its own login session in
    your browser too. Clearing this site&rsquo;s data in your browser removes all of it.</p>
  <h3>cumAI</h3>
  <ul>
    <li><b>Signing in</b> sets one cookie, on <code>api.clankuwu.com</code> only. It holds a random
      token, can&rsquo;t be read by any page&rsquo;s scripts, and lasts 12 hours or until you sign
      out. Our server keeps only a hash of it, in memory, so a restart signs everyone out.</li>
    <li><b>What our records keep:</b> for each wallet that signs in, its address. For each call: which
      model, how many tokens in and out, what it cost, and when; and for each try the model&rsquo;s
      supplier made at it, whether it worked, the supplier&rsquo;s reference number for it, the prices
      it was charged at, and which of your keys made it. <b>Never your prompts, the answers or the
      pictures.</b> These records are how allowances, balances and our own books are kept, so we keep
      them as accounting records. They are backed up, encrypted, off-site.</li>
    <li><b>Your prompts</b> go, through our server, to the model&rsquo;s supplier and on to the company
      that makes the model. Each prompt is also checked by a content classifier run by OpenAI, through
      the same supplier. They handle it under their own privacy policies. We don&rsquo;t store
      it.</li>
    <li><b>Pictures:</b> your prompt goes to the supplier and the model&rsquo;s maker, as above. The
      finished picture comes back through our server, is checked by the same classifier together with
      its prompt, and is passed straight to you. We don&rsquo;t keep it. The supplier keeps its copy
      for about a day.</li>
    <li><b>Checking a new wallet:</b> the first time a wallet signs in to the free playground, our
      server reads that wallet&rsquo;s transaction count and balance on Robinhood Chain, which are
      public anyway.</li>
    <li><b>Your IP address</b> is used in memory, to limit requests and how many new free accounts one
      network can start in a day. It is not written to a log or a file. The API&rsquo;s access log
      keeps each request&rsquo;s method, path, status, size and time, and nothing else: no IP, no
      query string, no headers, so no key and no cookie.</li>
    <li><b>Your chat</b> lives only in the page. A reload or a closed tab loses it. Nothing about it is
      kept in your browser&rsquo;s storage.</li>
  </ul>
  <h3>On the chain</h3>
  <p>Every trade is a public transaction on Robinhood Chain, visible to anyone, for good. It links
    your wallet&rsquo;s address to what you traded.</p>
  <p>Cloudflare, Coinbase, Google, X, your browser wallet, and the AI model suppliers and makers,
    handle your data under their own privacy policies.</p>`);

// ----------------------------------------------------------------- page --

/** The whole page, as markup. */
export function aboutPage() {
  const brand = S.brand;
  const body = {
    what: () => what(brand), beta: () => beta(brand), advice, affiliation: () => affiliation(brand),
    cum, verdicts, moderation, trust, official, source, terms, privacy,
    api: () => section("api", "The data API", apiBody(brand)),
  };
  return html`
    <div class="phead">
      <div>
        <h1>About ${brand}</h1>
        <p>What this site is and is not, what you are trusting when you use it, the terms, and what
          happens to your data.</p>
      </div>
    </div>
    ${shown().map((s) => body[s.id]())}`;
}

/**
 * Draw the page, and scroll to a section when the URL names one
 * (#/learn/terms). A self page has no About page: the router sends it to How
 * it works.
 */
export function renderAbout(id) {
  if (S.mode !== "hosted") return;
  paint($("#aboutbody"), aboutPage());
  if (!id || !isAboutSection(id)) return;
  const el = $("#about-" + id);
  if (!el || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ block: "start" });
  // On a first visit the fonts can land after this, rewrap the sections
  // above and push this one down the page: go back to it once they have.
  const fonts = globalThis.document?.fonts;
  if (fonts?.status === "loading") void fonts.ready.then(() => { if (el.isConnected) el.scrollIntoView({ block: "start" }); });
}
