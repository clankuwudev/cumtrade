// The verifier's calldata codec (public-release F3.1). Each guard is pinned
// here on its own: in verify.test.js most of them are backed up by the
// canonical re-encoding, so switching one off there would go unnoticed. The
// encoder is checked against viem, an independent implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import {
  Malformed, addressAt, boolAt, bytesArrayAt, bytesAt, encBytes, encBytesArray, encTuple, hexBody, int24At,
  sizeAt, splitCall, uintAt, word,
} from "../public/js/trade/abi.js";

const w = (v) => BigInt(v).toString(16).padStart(64, "0");
const malformed = (fn, what) => assert.throws(fn, Malformed, what);

test("hex must be whole bytes with a 0x prefix", () => {
  assert.equal(hexBody("0xABcd"), "abcd");
  for (const bad of ["abcd", "0xabc", "0xzz", "", undefined, 12]) malformed(() => hexBody(bad), String(bad));
});

test("a call needs a whole selector", () => {
  assert.deepEqual(splitCall("0x095ea7b3ff"), { selector: "0x095ea7b3", args: "ff" });
  malformed(() => splitCall("0x095ea7"), "three bytes");
  malformed(() => splitCall("0x"), "empty");
});

test("a word must be whole and inside the data", () => {
  assert.equal(uintAt(w(7), 0), 7n);
  malformed(() => uintAt(w(7).slice(2), 0), "31 bytes");
  malformed(() => uintAt(w(7), 1), "past the end");
  malformed(() => uintAt(w(7), -1), "negative");
  malformed(() => uintAt(w(7), 0.5), "fractional");
});

test("a value may not be wider than its type", () => {
  assert.equal(addressAt(w("0x000000000022D473030F116dDEE9F6B43aC78BA3"), 0), "0x000000000022d473030f116ddee9f6b43ac78ba3");
  malformed(() => addressAt(w(1n << 160n), 0), "a 161-bit address");
  assert.equal(boolAt(w(1), 0), true);
  malformed(() => boolAt(w(2), 0), "a bool of 2");
  assert.equal(uintAt(w((1n << 128n) - 1n), 0, 128), (1n << 128n) - 1n);
  malformed(() => uintAt(w(1n << 128n), 0, 128), "a 129-bit uint128");
});

test("an int24 must be sign-extended", () => {
  assert.equal(int24At(w(200), 0), 200n);
  assert.equal(int24At(w((1n << 256n) - 60n), 0), -60n);
  malformed(() => int24At(w(1n << 23n), 0), "2^23 is not an int24");
  malformed(() => int24At(w((1n << 24n) - 60n), 0), "-60 without sign extension");
});

test("sizes and offsets are bounded", () => {
  assert.equal(sizeAt(w(1 << 20), 0), 1 << 20);
  malformed(() => sizeAt(w((1 << 20) + 1), 0), "just over the bound");
  malformed(() => sizeAt(w(2n ** 255n), 0), "an offset no data could reach");
});

test("bytes must lie inside the data", () => {
  const good = w(32) + w(3) + "abcdef" + "0".repeat(58);
  assert.equal(bytesAt(good, 0), "abcdef");
  malformed(() => bytesAt(w(32) + w(33) + "ab".repeat(32), 0), "a length one past the end");
  malformed(() => bytesAt(w(96) + w(1), 0), "an offset past the end");
});

test("arrays are bounded in length", () => {
  const items = Array.from({ length: 16 }, () => "ab");
  assert.equal(bytesArrayAt(w(32) + encBytesArray(items), 0).length, 16);
  malformed(() => bytesArrayAt(w(32) + encBytesArray([...items, "ab"]), 0), "17 items");
});

test("a word must fit", () => {
  assert.equal(word(-60), w((1n << 256n) - 60n));
  assert.equal(word("0x000000000022D473030F116dDEE9F6B43aC78BA3"), w("0x000000000022D473030F116dDEE9F6B43aC78BA3"));
  malformed(() => word(1n << 256n), "2^256");
  malformed(() => word(-(1n << 256n) - 1n), "below -2^256");
});

test("the encoder matches viem for every shape the verifier re-encodes", () => {
  const body = (hex) => hex.slice(2);
  assert.equal(encBytes(""), body(encodeAbiParameters([{ type: "bytes" }], ["0x"])).slice(64));
  assert.equal(encBytes("ab".repeat(33)), body(encodeAbiParameters([{ type: "bytes" }], [`0x${"ab".repeat(33)}`])).slice(64));
  assert.equal(
    encTuple([{ tail: encBytes("10") }, { tail: encBytesArray(["060c0f", "", "ff".repeat(40)]) }, { head: word(99) }]),
    body(encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }], ["0x10", ["0x060c0f", "0x", `0x${"ff".repeat(40)}`], 99n])),
  );
  const key = ["0x0000000000000000000000000000000000000000", "0x00000000000000000000000000000000000070b2", 3000, -60, "0x000000000000000000000000000000000000400b"];
  assert.equal(
    encTuple([{ tail: encTuple([{ head: [...key, 1n, 5n, 4n].map(word).join("") }, { tail: encBytes("beef") }]) }]),
    body(encodeAbiParameters([{
      type: "tuple",
      components: [
        { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] },
        { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" },
      ],
    }], [[key, true, 5n, 4n, "0xbeef"]])),
  );
});
