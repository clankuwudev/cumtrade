import { Malformed } from "./abi.js";

// Keccak-256, for the page's own V4 quote (F3.3).
//
// The V4 PoolManager keeps each pool's state in a mapping keyed by the pool
// id, which is the hash of the pool key, and every storage slot the page reads
// is a hash too. The page has no crypto library, so this is Ethereum's
// Keccak-256: the original 0x01 padding, not SHA-3's 0x06.
//
// The rotation offsets and round constants are derived below from their
// definitions (FIPS 202, 3.2.2 and 3.2.5) instead of being typed in, so a
// transcription slip has no table to hide in. keccak.test.js checks the result
// against viem for every input length from 0 to 300 bytes.
//
// Hex in and out is lowercase without the 0x prefix, like abi.js.

const MASK = (1n << 64n) - 1n;
/** Bytes absorbed per permutation for a 256-bit output: (1600 − 2·256) / 8. */
const RATE = 136;

/** Rotation offsets, by lane index x + 5y. */
const ROT = (() => {
  const r = new Array(25).fill(0n);
  let x = 1, y = 0;
  for (let t = 0; t < 24; t++) {
    r[x + 5 * y] = BigInt((((t + 1) * (t + 2)) / 2) % 64);
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  return r;
})();

/** The 24 round constants, from the degree-8 LFSR rc(t). */
const RC = (() => {
  const bits = [1];
  let R = 1;
  for (let t = 1; t < 7 * 24; t++) {
    R <<= 1;
    if (R & 0x100) R ^= 0x171;
    bits.push(R & 1);
  }
  return Array.from({ length: 24 }, (_, i) => {
    let rc = 0n;
    for (let j = 0; j < 7; j++) rc |= BigInt(bits[7 * i + j]) << BigInt(2 ** j - 1);
    return rc;
  });
})();

/** @type {(v: bigint, n: bigint) => bigint} */
const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK);

/** Keccak-f[1600] on 25 lanes, in place. @param {bigint[]} A */
function permute(A) {
  const C = /** @type {bigint[]} */ (new Array(5)), B = /** @type {bigint[]} */ (new Array(25));
  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    // ρ and π
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    }
    // ι
    A[0] ^= RC[round];
  }
}

/** Keccak-256 of `hex` (whole bytes, no prefix), as 64 lowercase hex characters. */
export function keccak256(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Malformed("keccak input is not hex bytes");
  const n = hex.length / 2;
  // The message, then the padding: 0x01, zeros, and 0x80 on the last byte of
  // the block (the two share a byte when only one is left).
  const blocks = Math.floor(n / RATE) + 1;
  const bytes = new Uint8Array(blocks * RATE);
  for (let i = 0; i < n; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  bytes[n] ^= 0x01;
  bytes[bytes.length - 1] ^= 0x80;

  const A = new Array(25).fill(0n);
  for (let b = 0; b < blocks; b++) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let v = 0n;
      for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(bytes[b * RATE + lane * 8 + k]);
      A[lane] ^= v;
    }
    permute(A);
  }

  let out = "";
  for (let lane = 0; lane < 4; lane++) {
    for (let k = 0; k < 8; k++) out += ((A[lane] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  }
  return out;
}
