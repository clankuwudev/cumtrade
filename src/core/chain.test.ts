// V1 of docs/specs/pons-venue.md: the venue is a choice, and a wrong one is
// fatal rather than a silent default.
//
//   npm run test:venue
import { strict as assert } from "node:assert";
import { FACTORIES, factoryAt, genesisFloor, selectVenue, VENUE, VENUES, VENUE_KEYS } from "./chain.js";

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  catch (e) { failures++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${(e as Error).message}`); }
};

console.log("\nvenue selection");

check("unset means clank.trade, with both of its factories", () => {
  const v = selectVenue(undefined);
  assert.equal(v.key, "clank");
  // The first keeps its genesis; the second was deployed at 69,067,760 and
  // took over launching on 2026-09-22 (B1.5).
  assert.deepEqual(v.factories.map((f) => [f.address, f.genesisBlock]), [
    ["0xb45beb38f21be1d29e6b9c6e9dc4222d1c12f1f1", 63917462n],
    ["0x798daaa0707c1e538bb5acf0867ac0e1a84cccf2", 69067760n],
  ]);
  assert.equal(genesisFloor(v), 63917462n, "a scan of both starts at the older genesis");
});

check("VENUE=pons selects Pons, with its own genesis", () => {
  const v = selectVenue("pons");
  assert.equal(v.key, "pons");
  assert.deepEqual(v.factories.map((f) => f.address), ["0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"]);
  // Measured 2026-08-04 by bisecting log windows; flooring a scan needs it.
  assert.equal(genesisFloor(v), 27823666n);
});

check("a factory is listed by exact address, in any case, and nothing else is", () => {
  const clank = VENUES.clank;
  assert.equal(factoryAt("0x798DAAA0707C1E538BB5ACF0867AC0E1A84CCCF2", clank)?.genesisBlock, 69067760n);
  assert.equal(factoryAt("0xb45beb38f21be1d29e6b9c6e9dc4222d1c12f1f1", clank)?.genesisBlock, 63917462n);
  // Pons and 0x0ada4e70 emit the very same Launch event. Neither is clank.trade.
  assert.equal(factoryAt("0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", clank), undefined);
  assert.equal(factoryAt("0x0ada4e70e8f872ba18f3e722b69d6cf9817a6a1a", clank), undefined);
  assert.equal(factoryAt(null, clank), undefined);
  assert.equal(factoryAt("", clank), undefined);
  // And the other way round: clank.trade's factories are not Pons'.
  assert.equal(factoryAt("0x798daaa0707c1e538bb5acf0867ac0e1a84cccf2", VENUES.pons), undefined);
});

check("the module-level list is the watched venue's", () => {
  assert.equal(FACTORIES, VENUE.factories);
});

check("a name is read the way an operator would type it", () => {
  assert.equal(selectVenue("PONS").key, "pons");
  assert.equal(selectVenue("  pons  ").key, "pons");
});

check("an unknown venue refuses, and names the ones that work", () => {
  assert.throws(() => selectVenue("uniswap"), (e: Error) => {
    assert.match(e.message, /is not a venue this bot knows/);
    // The message has to be actionable: it lists what would have worked.
    for (const k of VENUE_KEYS) assert.ok(e.message.includes(k), `names ${k}`);
    return true;
  });
  // An empty string is a set-but-wrong variable, not an unset one.
  assert.throws(() => selectVenue(""), /not a venue this bot knows/);
});

check("both venues emit the same launch event, which is why the feed ports", () => {
  assert.equal(VENUES.clank.launchTopic, VENUES.pons.launchTopic);
});

check("every venue is complete: nothing half-filled can be selected", () => {
  for (const key of VENUE_KEYS) {
    const v = VENUES[key];
    assert.equal(v.key, key, `${key} knows its own key`);
    assert.ok(v.label.length > 0, `${key} has a label`);
    assert.ok(v.factories.length > 0, `${key} has a factory`);
    for (const f of v.factories) {
      assert.match(f.address, /^0x[0-9a-fA-F]{40}$/, `${key} factory is an address`);
      assert.ok(f.genesisBlock > 0n, `${key} ${f.address} has a genesis block`);
      assert.ok(f.label.length > 0, `${key} ${f.address} has a label`);
    }
    assert.match(v.launchTopic, /^0x[0-9a-fA-F]{64}$/, `${key} topic is a hash`);
  }
});

check("the module-level VENUE is one of the venues, not a copy", () => {
  assert.ok(Object.values(VENUES).includes(VENUE));
});

console.log(failures ? `\n\x1b[31m${failures} venue check(s) failed\x1b[0m\n` : "\n\x1b[32mall venue checks passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
