// The board's stream events on the page (public-release B4.1c): a token that
// drops off the server's board leaves the page's board too, a reconnect's
// snapshot is the whole board and not an addition to it, and a token page
// open on a token that dropped off checks it again, which on a hosted page
// trades it from the check (B5.1b).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubDom, textOf } from "./support/stubdom.js";
import { S, checked, rows } from "../public/js/core/store.js";
import { onBoardEvent } from "../public/js/boardEvents.js";
import { checks } from "../public/js/pages/token.js";
import { setBoardView } from "../public/js/pages/launches.js";

const dom = stubDom();

const addr = (i) => "0x" + String(i).padStart(40, "0");
const row = (i, over = {}) => ({
  token: addr(i), curve: addr(900 + i), creator: addr(800 + i),
  symbol: "T" + i, name: "token " + i, status: "ready", band: "CLEAN", score: 4, sellable: true, graduated: false,
  v4: null, fdvEth: 1, raised: 0.03, progress: 0.1, threshold: 4.27642857, holders: 10, devBuyPct: 2, bundlePct: 0,
  tokensPerEth: 6e8, feeBps: 100, priorLaunches: 0, priorDead: 0, findings: [], top10Pct: 40,
  block: 100 + i, launchedAt: Math.floor(Date.now() / 1000) - 600, ...over,
});

// The stub page has no CSS global; a new card's flash escapes its token with it.
globalThis.CSS = { escape: (s) => s };

/** Apply an event and return the tokens the board's table draws for it (the stub keeps what was appended). */
function drawnAfter(type, data) {
  dom.el("#lrows").appended.length = 0;
  onBoardEvent(type, data);
  return dom.el("#lrows").appended.map((el) => el.markup.match(/data-token="([^"]+)"/)[1]).sort();
}

function fresh(mode, board) {
  dom.reset();
  rows.clear();
  checks.clear();
  checked.clear();
  Object.assign(S, {
    mode, cfg: null, stats: { price: { ethUsd: 2000, stale: false } }, boardReady: true, connected: true,
    openToken: null, conn: null, wallet: null, heldFromLedger: null, tradeSide: "buy", customAmount: "", buySize: 0.01,
    hist: { points: [], since: null }, histFor: null,
  });
  setBoardView({ f: "all", q: "", sort: "new", dir: 1, layout: "table", col: "new" });
  onBoardEvent("snapshot", board);
}

test("an evict removes the card, and nothing else", () => {
  fresh("hosted", []);
  assert.deepEqual(drawnAfter("snapshot", [row(1), row(2), row(3)]), [addr(1), addr(2), addr(3)]);
  const after = drawnAfter("evict", { token: addr(1).toUpperCase().replace("0X", "0x") });
  assert.equal(rows.has(addr(1)), false, "in any casing");
  assert.deepEqual(after, [addr(2), addr(3)]);
  // A second evict of the same token, or of one never here, changes nothing.
  onBoardEvent("evict", { token: addr(1) });
  onBoardEvent("evict", { token: addr(9) });
  assert.equal(rows.size, 2);
});

test("a snapshot is the whole board: cards the server no longer has go", () => {
  fresh("hosted", [row(1), row(2), row(3)]);
  const after = drawnAfter("snapshot", [row(2), row(4)]);
  assert.deepEqual([...rows.keys()].sort(), [addr(2), addr(4)]);
  assert.deepEqual(after, [addr(2), addr(4)]);
});

test("a row still adds and updates a card", () => {
  fresh("hosted", [row(1)]);
  onBoardEvent("row", row(2));
  onBoardEvent("row", row(1, { symbol: "NEW" }));
  assert.equal(rows.size, 2);
  assert.equal(rows.get(addr(1)).symbol, "NEW");
});

test("hosted: the open token page of a token that dropped off checks it again, and trades from the check", async () => {
  fresh("hosted", [row(1), row(2)]);
  dom.el("#shell").dataset.page = "token";
  S.openToken = addr(1);
  // A check from while it was on the board: it names the board, so it is dropped.
  checks.set(addr(1), { state: "done", data: { token: addr(1), onBoard: true }, error: null, at: 1 });
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return {
      status: 200,
      json: async () => ({
        token: addr(1), symbol: "T1", name: "token 1", band: "CLEAN", score: 4, findings: [],
        onBoard: false, checkedAt: Date.now(),
        stats: {
          curve: addr(901), creator: addr(801), launchedAt: null, launchBlock: 101, holders: 10, devBuyPct: 2, creatorPct: 1,
          bundlePct: 0, top10Pct: 40, priorLaunches: 0, priorDead: 0, raised: 0.03, threshold: 4.27, progress: 0.1,
          fdvEth: 1, tokensPerEth: 6e8, feeBps: 100, sellable: true, graduated: false, readyToGraduate: false, v4: null,
        },
      }),
    };
  };
  onBoardEvent("evict", { token: addr(1) });
  assert.deepEqual(asked, ["/api/check?addr=" + addr(1)], "the page checks it again");
  await new Promise((r) => setTimeout(r, 0));
  const page = textOf(dom.el("#tokbody").markup);
  assert.match(page, /Price from the check at/);
  assert.match(page, /Not on the board, so no price history is kept/);
  assert.ok(checked.has(addr(1)), "a row to trade from");
});

test("an evict of another token leaves the open page alone", () => {
  fresh("hosted", [row(1), row(2)]);
  dom.el("#shell").dataset.page = "token";
  S.openToken = addr(1);
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return { status: 200, json: async () => ({ points: [] }) }; };
  onBoardEvent("evict", { token: addr(2) });
  assert.equal(asked.filter((u) => u.startsWith("/api/check")).length, 0);
  assert.equal(rows.has(addr(1)), true);
});
