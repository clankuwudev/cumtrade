// The board repaints a card only when its signature changes, so the signature
// has to change exactly when what the card shows changes — no more (the whole
// board repaints on every price tick) and no less (a card silently goes stale).
import { test } from "node:test";
import assert from "node:assert/strict";
import { S } from "../public/js/core/store.js";
import { cardSig } from "../public/js/pages/launches.js";
import { backup } from "../public/js/wallet/backup.js";

// A made-up launch: a synthetic token and creator, round figures.
const row = (over = {}) => ({
  token: "0x00000000000000000000000000000000000070A1", status: "ready", band: "CLEAN",
  score: 10, symbol: "TKN", name: "Token", sellable: true, graduated: false,
  fdvEth: 1.62, raised: 0.0405, progress: 0.0095, threshold: 4.2764, holders: 7,
  devBuyPct: 12.5, bundlePct: 1.5, tokensPerEth: 620.17e6, creator: "0xC0DE",
  priorLaunches: 0, priorDead: 0, findings: [], top10Pct: 100,
  ...over,
});

test("a price tick that changes no displayed figure leaves the signature alone", () => {
  S.stats = { price: { ethUsd: 2400.0 } };
  const before = cardSig(row());
  S.stats = { price: { ethUsd: 2400.1 } }; // still "$3.9K" and "$97.20"
  assert.equal(cardSig(row()), before);
});

test("a price tick that does change a displayed figure changes the signature", () => {
  // Under $100 the raise shows cents, so a $0.90 move in ETH is visible there
  // ("$97.20" -> "$97.24") even though the market cap still reads "$3.9K".
  S.stats = { price: { ethUsd: 2400.0 } };
  const before = cardSig(row());
  S.stats = { price: { ethUsd: 2400.9 } };
  assert.notEqual(cardSig(row()), before);
});

test("a change that is displayed changes the signature", () => {
  S.stats = { price: { ethUsd: 2400 } };
  const base = cardSig(row());
  assert.notEqual(cardSig(row({ holders: 5 })), base);
  assert.notEqual(cardSig(row({ band: "AVOID" })), base);
  assert.notEqual(cardSig(row({ fdvEth: 3 })), base); // $3.9K -> $7.2K
  // Graduating changes what the card says about where it trades, so it repaints.
  assert.notEqual(cardSig(row({ graduated: true })), base);
  // The trade bar is chrome outside the row, and is signed too.
  S.buySize = 0.02;
  assert.notEqual(cardSig(row()), base);
  S.buySize = 0.01;
});

test("different content never shares a signature across a field boundary", () => {
  S.stats = { price: { ethUsd: 2400 } };
  // Neighbouring numbers: "12" + "3.4%" and "1" + "23.4%" are the same text.
  assert.notEqual(
    cardSig(row({ holders: 12, devBuyPct: 3.4 })),
    cardSig(row({ holders: 1, devBuyPct: 23.4 })),
  );
  // Symbol and name are set by whoever deploys the token, so a separator
  // inside one must not move text into the next. The old "\x01" join failed
  // exactly this, and quotes would fail any encoding that did not escape them.
  assert.notEqual(
    cardSig(row({ symbol: "A\x01B", name: "C" })),
    cardSig(row({ symbol: "A", name: "B\x01C" })),
  );
  assert.notEqual(
    cardSig(row({ symbol: 'A","B', name: "C" })),
    cardSig(row({ symbol: "A", name: 'B","C' })),
  );
});

test("on a hosted page, connecting, switching chain and funding each repaint the card", () => {
  S.stats = { price: { ethUsd: 2400 } };
  S.mode = "hosted";
  try {
    const conn = (over) => ({
      info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" },
      address: "0x00000000000000000000000000000000000A11cE", chainId: 4663, balanceWei: 10n ** 16n, ...over,
    });
    S.conn = null;
    const disconnected = cardSig(row());
    S.conn = conn({ chainId: 1 });
    const wrongChain = cardSig(row());
    S.conn = conn({ balanceWei: 0n });
    const unfunded = cardSig(row());
    S.conn = conn({});
    const funded = cardSig(row());
    assert.equal(new Set([disconnected, wrongChain, unfunded, funded]).size, 4);
    // Another unfunded account shows another address to fund.
    S.conn = conn({ balanceWei: 0n, address: "0x000000000000000000000000000000000000B0b0" });
    assert.notEqual(cardSig(row()), unfunded);
    // The balance changing without crossing zero draws nothing new.
    S.conn = conn({ balanceWei: 2n * 10n ** 16n });
    assert.equal(cardSig(row()), funded);
  } finally {
    S.mode = "self";
    S.conn = null;
  }
});

test("with a trading wallet, logging in, backing up, the first balance read and funding each repaint the card", () => {
  S.stats = { price: { ethUsd: 2400 } };
  S.mode = "hosted";
  S.login = { ...S.login, here: true };
  const TRADING = "0x0000000000000000000000000000000000006006";
  try {
    const tw = (over) => ({ address: TRADING, method: "google", balanceWei: 10n ** 16n, ...over });
    S.trading = null;
    const loggedOut = cardSig(row());
    // Logged in, with no backup confirmation (W4): the card says so, and
    // confirming repaints it. (This run has no storage: the confirmation
    // lasts the run.)
    S.trading = tw({});
    const notBackedUp = cardSig(row());
    assert.notEqual(notBackedUp, loggedOut);
    backup.confirm(TRADING);
    assert.notEqual(cardSig(row()), notBackedUp, "confirming the backup repaints the card");
    S.trading = tw({ balanceWei: null });
    const reading = cardSig(row());
    S.trading = tw({ balanceWei: 0n });
    const unfunded = cardSig(row());
    S.trading = tw({});
    const funded = cardSig(row());
    assert.equal(new Set([loggedOut, notBackedUp, reading, unfunded, funded]).size, 5);
    // The balance moving without crossing zero draws nothing new, and nor
    // does the visitor's own wallet, which never trades here.
    S.trading = tw({ balanceWei: 3n * 10n ** 16n });
    assert.equal(cardSig(row()), funded);
    S.conn = { info: { uuid: "u", name: "Wallet", icon: "", rdns: "test" }, address: "0x00000000000000000000000000000000000A11cE", chainId: 1, balanceWei: 0n };
    assert.equal(cardSig(row()), funded);
    // Logging out repaints it back.
    S.trading = null;
    assert.equal(cardSig(row()), loggedOut);
  } finally {
    S.mode = "self";
    S.login = { ...S.login, here: false };
    S.trading = null;
    S.conn = null;
  }
});
