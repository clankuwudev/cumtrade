// Calldata, decoded and encoded again, for the step verifier.
//
// Two halves that exist for one check. The decoder reads what a plan's calldata
// says, and refuses any offset or length that points outside it and any value
// wider than its type. The encoder writes the decoded values back in the
// canonical ABI layout, and the verifier requires the two to match byte for
// byte. So no calldata passes that a contract could read differently from this
// page: no trailing bytes, no dirty high bits, no overlapping or reordered
// dynamic data.
//
// Everything works on lowercase hex without the 0x prefix, and positions are
// byte offsets into that.

/** Anything malformed. The verifier turns it into a refusal, never a pass. */
export class Malformed extends Error {}

/** Hex characters in one 32-byte word. */
const WORD = 64;
/** No offset, length or array in a plan comes anywhere near these. */
const MAX_SIZE = 1 << 20, MAX_ITEMS = 16;

/** `0x`-prefixed hex of whole bytes, as lowercase hex without the prefix. */
export function hexBody(hex) {
  if (typeof hex !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Malformed("not hex bytes");
  return hex.slice(2).toLowerCase();
}

/** A call's 4-byte selector (with 0x) and its argument bytes. */
export function splitCall(data) {
  const b = hexBody(data);
  if (b.length < 8) throw new Malformed("shorter than a selector");
  return { selector: `0x${b.slice(0, 8)}`, args: b.slice(8) };
}

// --- decoding ---------------------------------------------------------------

/** The word at byte `pos`, which must be an unsigned integer of at most `bits`. */
export function uintAt(b, pos, bits = 256) {
  if (!Number.isSafeInteger(pos) || pos < 0 || (pos + 32) * 2 > b.length) {
    throw new Malformed(`no whole word at byte ${pos}`);
  }
  const v = BigInt(`0x${b.slice(pos * 2, pos * 2 + WORD)}`);
  if (v >> BigInt(bits) !== 0n) throw new Malformed(`the value at byte ${pos} is wider than ${bits} bits`);
  return v;
}

/** An address, lowercase. */
export const addressAt = (b, pos) => `0x${uintAt(b, pos, 160).toString(16).padStart(40, "0")}`;

export const boolAt = (b, pos) => uintAt(b, pos, 1) === 1n;

/** An int24, which the ABI sign-extends across the whole word. */
export function int24At(b, pos) {
  const v = uintAt(b, pos);
  if (v < 1n << 23n) return v;
  if (v >= (1n << 256n) - (1n << 23n)) return v - (1n << 256n);
  throw new Malformed(`the int24 at byte ${pos} is not sign-extended`);
}

/** An offset or length word, small enough to index with. */
export function sizeAt(b, pos) {
  const v = uintAt(b, pos);
  if (v > BigInt(MAX_SIZE)) throw new Malformed(`the size at byte ${pos} is out of range`);
  return Number(v);
}

/** Dynamic `bytes` whose offset word is at `head`, counted from `base`. */
export function bytesAt(b, head, base = 0) {
  const start = base + sizeAt(b, head);
  const len = sizeAt(b, start);
  const from = (start + 32) * 2, to = from + len * 2;
  if (to > b.length) throw new Malformed(`the bytes at byte ${start} run past the end`);
  return b.slice(from, to);
}

/** Dynamic `bytes[]` whose offset word is at `head`, counted from `base`. */
export function bytesArrayAt(b, head, base = 0) {
  const start = base + sizeAt(b, head);
  const n = sizeAt(b, start);
  if (n > MAX_ITEMS) throw new Malformed(`the array at byte ${start} has ${n} items`);
  const items = start + 32;
  return Array.from({ length: n }, (_, i) => bytesAt(b, items + 32 * i, items));
}

// --- encoding ---------------------------------------------------------------

/** One word: an unsigned integer, a negative int24 in two's complement, or an address. */
export function word(v) {
  let x = typeof v === "string" ? BigInt(`0x${hexBody(v)}`) : BigInt(v);
  if (x < 0n) x += 1n << 256n;
  if (x < 0n || x >> 256n !== 0n) throw new Malformed("does not fit in a word");
  return x.toString(16).padStart(WORD, "0");
}

/** The encoding of a `bytes` value: its length, then the data padded to a whole word. */
export function encBytes(b) {
  return word(b.length / 2) + b + "0".repeat((WORD - (b.length % WORD)) % WORD);
}

/**
 * A tuple in canonical layout. Each part is `{ head }`, static words written in
 * place, or `{ tail }`, a dynamic value's encoding written after all the heads
 * behind an offset.
 */
export function encTuple(parts) {
  const headBytes = parts.reduce((n, p) => n + ("head" in p ? p.head.length : WORD), 0) / 2;
  let heads = "", tails = "";
  for (const p of parts) {
    if ("head" in p) heads += p.head;
    else { heads += word(headBytes + tails.length / 2); tails += p.tail; }
  }
  return heads + tails;
}

/** The encoding of a `bytes[]` value. */
export const encBytesArray = (items) => word(items.length) + encTuple(items.map((x) => ({ tail: encBytes(x) })));
