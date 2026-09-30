// Every word cumAI's playground says (X20 A9, A12; stage C, C4 and C5), in
// one place so a review reads them together: its refusals, clankchan's host
// lines, and the playground's states. Each refusal is one sentence and at
// most one action. The codes are the gateway's (src/gateway); "network" is
// the page's own, for a gateway that can't be reached.
//
// Differences from A9's table, each from a later decision:
// - free_tier_preview is new (C2, C-D7).
// - free_tier_unavailable never says paid keys are unaffected: the free tier
//   may share the paid account (TI Build, 10add15).
// - the sign-in and login lines at the end are new: A9 has none.
// - Picture mode (X15c) has its own words for the codes that mean something
//   else for a picture: PICTURE_TABLE, used by `refusal(e, { picture })`.

/** The actions a refusal may offer. The page draws each one; none is a link out of the site. */
export const ACTIONS = Object.freeze({
  SIGN_IN: "sign-in",
  ADD_ETH: "add-eth",
  NEW_CHAT: "new-chat",
  RETRY: "retry",
  /** Picture mode's Try again when trying again spends one of the day's pictures: its label says so. */
  RETRY_PICTURE: "retry-picture",
});

const UNAVAILABLE = "The playground can't answer right now. Try again shortly.";

/** A time in a refusal, as the page shows it: "14:00 UTC". Null when there isn't one. */
export function utcTime(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)} UTC` : null;
}

/**
 * The refusals, by the gateway's code. `say` is a sentence, or a function of
 * the refusal's fields for one that names a time. `when` names the field
 * that says when it clears, shown after the sentence.
 */
const TABLE = {
  not_signed_in: { say: "Sign in again: your session ended.", action: ACTIONS.SIGN_IN },
  terms_changed: { say: "Sign in again: your session ended.", action: ACTIONS.SIGN_IN },
  free_tier_not_eligible: {
    say: "Free use requires a sent transaction or a small ETH balance on Robinhood Chain.",
    action: ACTIONS.ADD_ETH,
  },
  free_tier_ip_limit: {
    say: "Your network has started its 10 new free accounts today. Wallets already signed up still work.",
    action: null, when: "resets_at",
  },
  free_allowance_used: {
    say: "Today's free use is spent, or this conversation is too long for what is left.",
    action: ACTIONS.NEW_CHAT, when: "resets_at",
  },
  free_tier_exhausted: {
    say: (e) => (utcTime(e.opens_at) ? `The free playground is busy. More opens at ${utcTime(e.opens_at)}.` : "The free playground is busy. More opens within the hour."),
    action: null,
  },
  free_tier_limit: { say: "This conversation is too long for the free playground.", action: ACTIONS.NEW_CHAT },
  looks_like_recovery_phrase: { say: "That looked like a recovery phrase, so it was not sent. Never share one.", action: null },
  free_tier_off: { say: "The playground is paused.", action: null },
  free_tier_preview: { say: "The playground is in a private preview. It opens to everyone soon.", action: null },
  free_tier_unavailable: { say: UNAVAILABLE, action: ACTIONS.RETRY },
  chain_unavailable: { say: UNAVAILABLE, action: ACTIONS.RETRY },
  network: { say: UNAVAILABLE, action: ACTIONS.RETRY },
  // Not in A9: the sign-in's own refusals.
  sign_in_failed: { say: "The sign-in didn't go through. Try again.", action: ACTIONS.SIGN_IN },
  wallet_declined: { say: "Your wallet didn't sign, so nothing was sent.", action: ACTIONS.SIGN_IN },
  wallet_refused: { say: "The trading wallet signs only cumAI's own sign-in, and this wasn't it.", action: null },
  login_failed: { say: "The login to your trading wallet didn't go through. Try again.", action: null },
};

const NOT_MADE = { say: "The picture couldn't be made this time.", action: ACTIONS.RETRY };
const COUNTED = { say: "The picture couldn't be made. It still counts toward today's pictures.", action: ACTIONS.RETRY_PICTURE };

/**
 * Whether a failed picture counted toward the day's (the X15 red team: a
 * free failure counts, so failures can't be farmed). The gateway's sentence
 * says so; where a code is shown in its place, the page has already seen the
 * pictures left fall and marked it `counted`.
 */
const counted = (e) => e?.extra?.counted === true || /counts toward today's free pictures/i.test(String(e?.message ?? ""));
/** A failure, in the words its cost calls for: counted, or not. */
const failed = (e) => (counted(e) ? COUNTED : NOT_MADE);

/** "about 12 minutes", from a refusal's seconds, or null. */
const minutes = (s) => (Number.isFinite(s) && s > 0 ? `about ${Math.max(1, Math.round(s / 60))} minute${Math.round(s / 60) > 1 ? "s" : ""}` : null);

/**
 * Picture mode's refusals (X15c), where a code means something else than in
 * chat. Any other code keeps chat's words. An entry may be a function of the
 * refusal, where its words depend on what it cost.
 */
const PICTURE_TABLE = {
  free_allowance_used: { say: (_e, n) => `Today's ${n} free pictures are used. More at 00:00 UTC.`, action: null },
  picture_withheld: { say: "The picture was withheld by the content check. It still counts toward today's pictures.", action: null },
  picture_failed: failed,
  upstream_timeout: failed,
  upstream_error: failed,
  upstream_unavailable: failed,
  upstream_rate_limited: failed,
  upstream_rejected: failed,
  model_unavailable: failed,
  moderation_unavailable: failed,
  free_tier_unavailable: failed,
  // No answer arrived, so the page can't know: it may have been made, and counted.
  network: { say: "The answer didn't arrive, so the picture may still count toward today's pictures.", action: ACTIONS.RETRY_PICTURE },
  pictures_failing: {
    say: (e) => `Several pictures failed within the hour, so pictures are paused.${minutes(e.retry_after_seconds) ? ` Try again in ${minutes(e.retry_after_seconds)}.` : " Try again later."}`,
    action: null,
  },
  pictures_busy: { say: "Pictures are busy right now, and nothing was counted. Try again in a minute.", action: ACTIONS.RETRY },
  rate_limited: { say: "A free call is already running. Wait for it to finish.", action: null },
  free_pictures_off: { say: "Free pictures are paused.", action: null },
  free_tier_model: { say: "Free pictures changed since this page loaded. Reload it.", action: null },
  free_tier_limit: { say: "Free pictures changed since this page loaded. Reload it.", action: null },
  bad_request: { say: "That prompt couldn't be sent as a picture.", action: null },
};

/** Codes whose sentence is the gateway's own (X7): the page adds nothing. */
const GATEWAYS_OWN = new Set(["content_blocked", "key_cooling_down"]);

/**
 * What the page says for a refusal: `{ say, action, when }`. `when` is the
 * time it clears, or null. A code this table doesn't know reads as
 * "can't answer right now", with Retry, so the page never shows a raw code.
 */
export function refusal(e, { picture = false, perDay = 2 } = {}) {
  const code = typeof e?.code === "string" ? e.code : "network";
  const fields = e?.extra && typeof e.extra === "object" ? e.extra : {};
  if (GATEWAYS_OWN.has(code)) {
    const own = typeof e?.message === "string" && e.message.trim() ? e.message.trim() : UNAVAILABLE;
    return { say: own, action: null, when: null };
  }
  const own = picture ? PICTURE_TABLE[code] : null;
  const row = (typeof own === "function" ? own(e) : own) ?? TABLE[code] ?? (picture ? failed(e) : TABLE.network);
  const say = typeof row.say === "function" ? row.say(fields, perDay) : row.say;
  return { say, action: row.action, when: row.when ? utcTime(fields[row.when]) : null };
}

/**
 * A refusal's title (AP, the user's mockup): a few bold words over its
 * sentence, by the gateway's code. A code without one reads as "Not sent".
 */
const TITLES = {
  not_signed_in: "Signed out",
  terms_changed: "Signed out",
  free_tier_not_eligible: "This wallet isn't eligible yet",
  free_tier_ip_limit: "No new accounts today",
  free_allowance_used: "Today's allowance is used",
  free_tier_exhausted: "The playground is busy",
  free_tier_limit: "This chat is too long",
  looks_like_recovery_phrase: "Not sent",
  free_tier_off: "Paused",
  free_tier_preview: "Private preview",
  free_tier_unavailable: "Not answering",
  chain_unavailable: "Not answering",
  network: "Not answering",
  sign_in_failed: "Sign-in failed",
  wallet_declined: "Not signed",
  wallet_refused: "Not signed",
  login_failed: "Login failed",
  content_blocked: "Blocked",
  key_cooling_down: "Cooling down",
};
const PICTURE_TITLES = {
  free_allowance_used: "No pictures left today",
  picture_withheld: "Withheld",
  network: "No answer",
  pictures_failing: "Pictures paused",
  pictures_busy: "Pictures are busy",
  rate_limited: "One at a time",
  free_pictures_off: "Paused",
  free_tier_model: "Reload the page",
  free_tier_limit: "Reload the page",
  bad_request: "Not sent",
};

/** The title over a refusal's sentence. */
export function refusalTitle(e, { picture = false } = {}) {
  const code = typeof e?.code === "string" ? e.code : "network";
  if (picture && PICTURE_TITLES[code]) return PICTURE_TITLES[code];
  if (picture && !GATEWAYS_OWN.has(code) && !TABLE[code]) return "Picture not made";
  if (picture && PICTURE_TABLE[code]) return "Picture not made";
  return TITLES[code] ?? (TABLE[code] || GATEWAYS_OWN.has(code) ? "Not sent" : TITLES.network);
}

/** The codes the table has words for, for the tests. */
export const KNOWN_CODES = Object.freeze([...Object.keys(TABLE), ...GATEWAYS_OWN]);
/** The codes Picture mode says its own way. */
export const PICTURE_CODES = Object.freeze(Object.keys(PICTURE_TABLE));

/** A single message too long to send, caught before it goes (A8). */
export const tooLong = (bytes, limit) =>
  `This message is ${(bytes / 1000).toFixed(1)} KB, and the free playground takes ${(limit / 1000).toFixed(1)} KB. Shorten it.`;

// ------------------------------------------------------------- the host --
//
// clankchan hosts the page (C-D8): her face and one line, which say what the
// page is doing. Never a model's answer, and never presented as one (C-D5,
// F13): the replies carry the model's name.

/** Her faces, as the site already ships them (src/web/public/art/), and what each shows. */
export const FACES = Object.freeze({
  smug: ["e05-smug", "looking smug"],
  sparkle: ["e08-sparkle", "delighted"],
  sweating: ["e04-sweating", "nervous"],
  sleepy: ["e10-sleepy", "sleepy"],
  hollow: ["e02-hollow", "tired"],
  deadpan: ["e07-deadpan", "deadpan"],
  manic: ["e01-manic", "grinning"],
  shock: ["e11-shock", "shocked"],
});

/** Her line for each state of the page: [face, line]. */
export const HOST = Object.freeze({
  loading: () => ["sleepy", "Checking whether the playground's open."],
  down: () => ["hollow", "The gateway isn't answering. Give it a minute."],
  off: () => ["hollow", "The playground isn't open yet. Browse the models meanwhile."],
  preview: () => ["hollow", "Private preview for now. It opens to everyone soon."],
  previewDenied: () => ["sweating", "This wallet isn't in the preview. It opens to everyone soon."],
  out: () => ["sleepy", "Sign in and I'll open the playground."],
  signing: (own) => ["sparkle", own ? "Your wallet is asking you to sign. It costs nothing." : "Signing in with the trading wallet."],
  in: (left) => ["smug", `Free model's warmed up. ${left} left today.`],
  notEligible: () => ["smug", "Your wallet needs one more step to use the free playground."],
  typing: (model) => ["sparkle", `It's typing. Not me: ${model}.`],
  done: (cost) => ["smug", cost ? `Done. That one cost ${cost}.` : "Done."],
  stopped: () => ["sweating", "Stopped. You only pay for what arrived."],
  refused: () => ["sweating", "That one didn't go through. The note says why."],
  phrase: () => ["shock", "That looked like a recovery phrase, so it wasn't sent. Never share one."],
  fresh: () => ["smug", "Fresh chat. Nothing from the last one is kept."],
  pictures: (left) => ["smug", left === 1 ? "One free picture left today. Make it count." : `${left} free pictures left today.`],
  noPictures: () => ["sleepy", "No free pictures left today. More at 00:00 UTC."],
  drawing: (model) => ["sparkle", `It's drawing. Not me: ${model}.`],
  drawn: () => ["smug", "Done. It was checked before you saw it."],
  models: (n) => ["manic", `${n} models. Pick one and I'll pull its numbers.`],
  modelsDown: () => ["hollow", "The model list isn't answering. Give it a minute."],
  noMatch: () => ["shock", "Nothing matches. Try a maker's name."],
  pickFree: () => ["sparkle", "That one's free today. Try it in the playground."],
  pick: (id, out) => ["manic", `${id}: ${out} per million out. Needs a key, next.`],
  docs: () => ["deadpan", "Change the base URL. That's the whole trick."],
  statusDown: (n) => ["sweating", `${n} ${n === 1 ? "model is" : "models are"} down right now.`],
  statusSlow: (n) => ["hollow", `${n} ${n === 1 ? "model is" : "models are"} failing now and then.`],
  statusFine: () => ["smug", "Everything that's been checked is answering."],
  statusUnknown: () => ["sleepy", "No checks yet. Models show as unknown until calls reach them."],
  statusOff: () => ["hollow", "The status isn't answering. Give it a minute."],
});

// ------------------------------------------------------- the playground --

/** What the playground says in each state before a chat starts. */
export const PLAY = Object.freeze({
  loadingTitle: "Checking the playground.",
  offTag: "Opens soon",
  offTitle: "The playground opens soon.",
  offLine: "Until then, browse the models and their prices, or read how to call the API.",
  previewAsk: "Have preview access?",
  previewDenied: (who) => `Signed in as ${who}. This wallet isn't in the preview.`,
  outTag: "Playground",
  outTitle: "Sign in to chat free.",
  outLine: "One free model, a little each day. Each wallet here is its own account, with its own allowance.",
  outTerms: "Signing in accepts the",
  tradingLogIn: "Your trading wallet: log in with",
  tradingBusy: "logging in…",
  tradingNowhere: "There's no trading wallet on this site.",
  ownHead: "Or your own wallet",
  ownNone: "No wallet found in this browser.",
  newTag: (model) => `New chat · ${model}`,
  newTitle: "Ask it anything.",
  newLine: "Start with a question, an idea, or a little curiosity.",
  warn: "Never share a recovery phrase or private key.",
  hint: "Enter to send · Shift + Enter for a new line",
  used: (n, of) => `${n} of ${of} used`,
  under: "AI can be wrong. Not financial advice or cumLabs support. Chats are not saved.",
  left: (left) => `${left} left today · resets 00:00 UTC`,
  addEth: "Send a few cents of ETH on Robinhood Chain to your trading wallet:",
});

/** Picture mode's words (X15c). */
export const PICTURE = Object.freeze({
  modes: [["text", "Text"], ["picture", "Picture"]],
  shape: "Shape",
  placeholder: "Describe a picture",
  make: "Make",
  making: "Making…",
  progress: "Making your picture… usually under a minute",
  label: "Pictures are made by a model and can be wrong or odd. Checked before you see them. Not kept.",
  left: (left, perDay) => `${left} of ${perDay} pictures left today · resets 00:00 UTC`,
  newTag: (model) => `New picture · ${model}`,
  newTitle: "Describe a picture.",
  newLine: (perDay) => `${perDay} free a day. Pick a shape, then say what you want to see.`,
  tooLong: (n, max) => `This prompt is ${n.toLocaleString("en-US")} characters, and a picture takes ${max.toLocaleString("en-US")}. Shorten it.`,
  download: "Download",
  alt: (prompt) => `A picture made from the prompt: ${prompt}`,
});

/** Picture mode's starting points: no real people, logos or tokens. */
export const SUGGEST_PICTURES = Object.freeze([
  "A cozy pixel-art café on a rainy night, warm window light.",
  "A watercolor map of an imaginary island with a lighthouse.",
  "An isometric tiny city on a floating rock, soft pastel colors.",
  "A robot barista pouring latte art, studio photo.",
]);

/** The new chat's starting points. None asks for advice about a token or a trade. */
export const SUGGEST = Object.freeze([
  "Explain a bonding curve in two sentences.",
  "Write a Python function with retry and backoff.",
  "What does an ERC-20 approval allow?",
  "Explain an OpenAI-compatible API.",
]);

/** Each starting point's card (AP): its label and icon, in SUGGEST's order. */
export const SUGGEST_CARDS = Object.freeze([["Learn", "book"], ["Code", "code"], ["Understand", "bulb"], ["Explore", "sparkle"]]);
/** Picture mode's cards, in SUGGEST_PICTURES' order. */
export const SUGGEST_PICTURE_CARDS = Object.freeze([["Scene", "image"], ["Map", "map"], ["City", "city"], ["Photo", "camera"]]);

// ------------------------------------------------------------ the status --
//
// C5b (C-D10): the words around what GET /v1/status says. Each follows the
// gateway's own rules (src/gateway/status.ts, c-playground.md's C2b notes).
// The supplier stays unnamed (C1).

export const STATUS = Object.freeze({
  label: { live: "live", degraded: "degraded", down: "down", unknown: "unknown", operational: "operational" },
  services: {
    gateway: ["Gateway", "api.clankuwu.com"],
    moderation: ["Moderation", "every prompt, before it leaves"],
    supplier: ["Supplier", "today's model supplier"],
  },
  /** What each state means, as the gateway decides it. */
  legend: {
    live: "answering normally",
    degraded: "a failure among its last five",
    down: "its last three failed",
    unknown: "nothing measured in 3 hours",
  },
  /** An incident, in one sentence. */
  incident: {
    down: "Its last three calls or checks failed.",
    degraded: "A call or check failed among its last five.",
    moderationDegraded: "The prompt checker failed in the last 30 minutes.",
    supplierDegraded: "Over a tenth of the last round of checks failed.",
    supplierDown: "Over half of the last round of checks failed.",
  },
  noIncidents: "No incidents in the last 24 hours.",
  from: "From real calls, and from a one-token check on each model",
  every: (m) => `every ${m} minutes`,
  budget: (b, s) => `under $${b} a day ($${s} spent today)`,
  noChecks: "No scheduled checks yet: a model shows as unknown until real calls reach it.",
  down: "The status isn't answering right now. Try again in a moment.",
});

/**
 * The acknowledgement before the first login to a trading wallet: cumOS's
 * own (trade/acknowledge.js, W1.2), word for word and under its key, so it is
 * asked once for both pages.
 */
export const TRADING_ACK = Object.freeze({
  key: "clank.ack.tw",
  title: "Your trading wallet",
  body: "This wallet signs trades without asking you. Anyone who controls this page's code, or this browser while you are logged in, can move what is in it. Keep here only what you are ready to trade. Verdicts are automated and can be wrong.",
});

/** The standing note (C-D9): there is no xCUM token. */
export const XCUM_NOTE = "There is no xCUM token yet. When there is, its one real address will be posted on this page. Any token called xCUM today is not ours.";
