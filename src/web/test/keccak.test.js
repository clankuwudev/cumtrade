// Keccak-256 in the page (F3.3), against viem's, which is independent of it.
// Every storage slot the page's V4 quote reads is one of these hashes, so a
// wrong one would read the wrong pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256 as viemKeccak } from "viem";
import { keccak256 } from "../public/js/trade/keccak.js";
import { Malformed } from "../public/js/trade/abi.js";

/** `len` bytes of varied content, as hex without 0x. */
const bytes = (len, seed) => Array.from({ length: len }, (_, i) => ((i * 131 + seed * 17 + (i >> 3)) & 0xff).toString(16).padStart(2, "0")).join("");

test("matches viem for every length from 0 to 300 bytes, across the 136-byte block boundaries", () => {
  for (let len = 0; len <= 300; len++) {
    for (const seed of [1, 2]) {
      const h = bytes(len, seed);
      assert.equal(keccak256(h), viemKeccak(`0x${h}`).slice(2), `${len} bytes`);
    }
  }
});

test("the known vectors: the empty string, and a V4 pool id", () => {
  assert.equal(keccak256(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  // CABO's canonical pool key, (ETH, CABO, 3000, 200, the factory's hook), hashes to the id
  // its pool is stored under on the live chain.
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const key = ["0x0", "0xcf5b720f33febdc1c9d4880b8317203b63fdf368", 3000, 200, "0xd405e0dff2d0cc7eaa48b3aec2e3f2456c072000"];
  assert.equal(keccak256(key.map(word).join("")), "7c30869224b2484644ca47706600e3119c76ac8d9ea8d7fddb4f0b1fa963a699");
});

test("upper-case hex is the same bytes", () => {
  const h = bytes(40, 3);
  assert.equal(keccak256(h.toUpperCase()), keccak256(h));
});

test("anything that is not whole bytes of hex is refused", () => {
  for (const bad of ["0", "abc", "0x00", "zz", " 00", undefined, null, 12, ["00"]]) {
    assert.throws(() => keccak256(bad), Malformed, JSON.stringify(bad));
  }
});
