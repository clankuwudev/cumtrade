// Uniswap V4's exact-input swap, for the page's own quote (F3.3).
//
// No V4 Quoter is deployed on Robinhood Chain, and the server quotes a V4
// trade by simulating it with eth_simulateV1, which a wallet may not pass
// through to its RPC. So the page prices the swap itself, from the pool's
// state read with plain eth_call. This is v4-core's Pool.swap loop and the
// libraries it calls (TickMath, SqrtPriceMath, SwapMath, TickBitmap and the
// protocol fee), for exact input only, in BigInt arithmetic that rounds
// exactly where the contracts round. v4math.test.js holds it to the wei
// against real fills from the chain.
//
// Where the contract would revert, or where this port cannot be sure it does
// what the contract does (a product that would wrap 256 bits in the EVM),
// this throws Unpriceable. The caller refuses the plan: a figure the page
// cannot work out is never a pass.

export const MIN_TICK = -887272, MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const Q96 = 1n << 96n;
const MAX_U256 = (1n << 256n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
/** Fees are in pips, millionths. */
const MAX_SWAP_FEE = 1_000_000n;
const MAX_PROTOCOL_FEE = 1000n;

/** The swap would revert, or cannot be modelled here. */
export class Unpriceable extends Error {}

// --- arithmetic ---------------------------------------------------------------

// FullMath takes the product to 512 bits, so these are exact. Every result
// here is bounded by its inputs, far below 2^256. A division by zero throws
// (a RangeError), which refuses like any other failure.
/** @type {(a: bigint, b: bigint, d: bigint) => bigint} */
const mulDiv = (a, b, d) => (a * b) / d;
/** @type {(a: bigint, b: bigint, d: bigint) => bigint} */
const mulDivUp = (a, b, d) => { const p = a * b; return p / d + (p % d > 0n ? 1n : 0n); };
/** @type {(a: bigint, b: bigint) => bigint} */
const divUp = (a, b) => a / b + (a % b > 0n ? 1n : 0n);

// --- TickMath -----------------------------------------------------------------

/** 2^128 / sqrt(1.0001)^(2^i), for i = 1…19 (bit 0 is the starting value). */
const RATIOS = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** sqrt(1.0001^tick) as a Q64.96, rounded up like TickMath.getSqrtPriceAtTick. */
export function sqrtPriceAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Unpriceable(`tick ${tick} is out of range`);
  const abs = BigInt(Math.abs(tick));
  let price = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  RATIOS.forEach((r, i) => { if (abs & (1n << BigInt(i + 1))) price = (price * r) >> 128n; });
  if (tick > 0) price = MAX_U256 / price;
  return (price + (1n << 32n) - 1n) >> 32n;
}

// --- SqrtPriceMath ------------------------------------------------------------

/**
 * Token0 between two prices, for `liquidity`.
 * @param {bigint} a @param {bigint} b @param {bigint} liquidity @param {boolean} roundUp
 */
export function amount0Delta(a, b, liquidity, roundUp) {
  if (a > b) [a, b] = [b, a];
  const n1 = liquidity << 96n, n2 = b - a;
  return roundUp ? divUp(mulDivUp(n1, n2, b), a) : mulDiv(n1, n2, b) / a;
}

/**
 * Token1 between two prices, for `liquidity`. v4-core multiplies these in
 * plain EVM arithmetic, which would wrap past 256 bits, so a product that
 * large is refused rather than guessed at.
 * @param {bigint} a @param {bigint} b @param {bigint} liquidity @param {boolean} roundUp
 */
export function amount1Delta(a, b, liquidity, roundUp) {
  const n = (a > b ? a - b : b - a) * liquidity;
  if (n > MAX_U256) throw new Unpriceable("a value in the swap does not fit in 256 bits");
  return n / Q96 + (roundUp && n % Q96 > 0n ? 1n : 0n);
}

/**
 * The price after adding `amount` of token0 (zeroForOne), rounded up.
 * @param {bigint} sqrtP @param {bigint} liquidity @param {bigint} amount
 */
function priceAfterAmount0(sqrtP, liquidity, amount) {
  if (amount === 0n) return sqrtP;
  const n1 = liquidity << 96n;
  // The contract takes this path only when neither the product nor the sum
  // wraps 256 bits, and the other formula (which rounds differently) when one does.
  const product = amount * sqrtP;
  if (product <= MAX_U256 && n1 + product <= MAX_U256) return mulDivUp(n1, sqrtP, n1 + product);
  return divUp(n1, n1 / sqrtP + amount);
}

// The price after an input that does not reach the step's target. It stays
// short of the target, so it cannot leave the price range.
/** @type {(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean) => bigint} */
const priceAfterInput = (sqrtP, liquidity, amountIn, zeroForOne) => zeroForOne
  ? priceAfterAmount0(sqrtP, liquidity, amountIn)
  : sqrtP + (amountIn << 96n) / liquidity; // token1 in, rounded down

// --- SwapMath -----------------------------------------------------------------

/**
 * One step of an exact-input swap, toward `target` or until `remaining` is spent.
 * @param {bigint} sqrtP @param {bigint} target @param {bigint} liquidity @param {bigint} remaining @param {bigint} feePips
 */
export function computeSwapStep(sqrtP, target, liquidity, remaining, feePips) {
  const zeroForOne = sqrtP >= target;
  const lessFee = mulDiv(remaining, MAX_SWAP_FEE - feePips, MAX_SWAP_FEE);
  let amountIn = zeroForOne ? amount0Delta(target, sqrtP, liquidity, true) : amount1Delta(sqrtP, target, liquidity, true);
  let next, fee;
  if (lessFee >= amountIn) {
    next = target;
    fee = feePips === MAX_SWAP_FEE ? amountIn : mulDivUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
  } else {
    amountIn = lessFee;
    next = priceAfterInput(sqrtP, liquidity, lessFee, zeroForOne);
    fee = remaining - amountIn;
  }
  const amountOut = zeroForOne ? amount1Delta(next, sqrtP, liquidity, false) : amount0Delta(sqrtP, next, liquidity, false);
  return { next, amountIn, amountOut, fee };
}

// --- TickBitmap ---------------------------------------------------------------

const msb = (x) => x.toString(2).length - 1;
const lsb = (x) => { let n = 0; while (((x >> BigInt(n)) & 1n) === 0n) n++; return n; };

/** Solidity's rounding toward negative infinity, as TickBitmap.compress. */
const compress = (tick, spacing) => Math.trunc(tick / spacing) - (tick % spacing < 0 ? 1 : 0);

/**
 * The next initialised tick in the direction of the swap, within one bitmap
 * word, or the word's edge if none is. `wordAt(wordPos)` reads a word.
 */
export async function nextTickInWord(wordAt, tick, spacing, lte) {
  let compressed = compress(tick, spacing);
  if (!lte) compressed += 1;
  const wordPos = compressed >> 8, bitPos = compressed & 0xff;
  const mask = lte ? MAX_U256 >> BigInt(255 - bitPos) : MAX_U256 ^ ((1n << BigInt(bitPos)) - 1n);
  const masked = (await wordAt(wordPos)) & mask;
  const initialized = masked !== 0n;
  const offset = lte
    ? -(initialized ? bitPos - msb(masked) : bitPos)
    : initialized ? lsb(masked) - bitPos : 255 - bitPos;
  return { next: (compressed + offset) * spacing, initialized };
}

// --- Pool.swap ----------------------------------------------------------------

/**
 * What an exact-input swap of `amountIn` returns, as Pool.swap computes it,
 * with the router's price limit (the far end of the range).
 *
 * @param {{ sqrtPriceX96: bigint, tick: number, liquidity: bigint, lpFee: number, protocolFee: number }} pool slot0 and liquidity
 * @param {{ tickSpacing: number, zeroForOne: boolean, amountIn: bigint,
 *   word: (wordPos: number) => Promise<bigint>, tickNet: (tick: number) => Promise<bigint>, maxSteps?: number }} p
 *   `word` reads a tick bitmap word and `tickNet` a tick's net liquidity (signed).
 * @returns {Promise<{ amountOut: bigint, amountIn: bigint, sqrtPriceX96: bigint, liquidity: bigint }>}
 */
export async function swapExactIn(pool, p) {
  const { zeroForOne, tickSpacing } = p;
  const maxSteps = p.maxSteps ?? 64;
  if (pool.sqrtPriceX96 === 0n) throw new Unpriceable("the pool is not initialised");
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 32767) throw new Unpriceable(`tick spacing ${tickSpacing} is not a pool's`);
  if (!(p.amountIn > 0n)) throw new Unpriceable("nothing to swap");

  // The fee: the LP fee, plus the protocol's share for this direction if one is set.
  const lpFee = BigInt(pool.lpFee), fees = BigInt(pool.protocolFee);
  const protocolFee = zeroForOne ? fees & 0xfffn : fees >> 12n;
  if (lpFee > MAX_SWAP_FEE || (fees & 0xfffn) > MAX_PROTOCOL_FEE || fees >> 12n > MAX_PROTOCOL_FEE) {
    throw new Unpriceable("the pool's fees are out of range");
  }
  const swapFee = protocolFee === 0n ? lpFee : protocolFee + lpFee - (protocolFee * lpFee) / MAX_SWAP_FEE;

  const limit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  if (zeroForOne ? limit >= pool.sqrtPriceX96 : limit <= pool.sqrtPriceX96) throw new Unpriceable("the price is already at its limit");

  const words = new Map();
  const wordAt = async (pos) => {
    if (!words.has(pos)) words.set(pos, await p.word(pos));
    return words.get(pos);
  };

  let remaining = p.amountIn, out = 0n, steps = 0;
  let sqrtP = pool.sqrtPriceX96, tick = pool.tick, liquidity = pool.liquidity;
  while (remaining !== 0n && sqrtP !== limit) {
    if (++steps > maxSteps) throw new Unpriceable(`the swap takes more than ${maxSteps} steps to price`);
    // Only a step that ends on a tick continues the loop; any other spends the rest of the input.
    if (tick === null) throw new Unpriceable("the swap did not end where the contract's would");
    const start = sqrtP;
    let { next: tickNext, initialized } = await nextTickInWord(wordAt, tick, tickSpacing, zeroForOne);
    if (tickNext < MIN_TICK) tickNext = MIN_TICK;
    if (tickNext > MAX_TICK) tickNext = MAX_TICK;
    const sqrtNext = sqrtPriceAtTick(tickNext);
    const target = zeroForOne ? (sqrtNext < limit ? limit : sqrtNext) : (sqrtNext > limit ? limit : sqrtNext);

    const s = computeSwapStep(sqrtP, target, liquidity, remaining, swapFee);
    sqrtP = s.next;
    remaining -= s.amountIn + s.fee;
    out += s.amountOut;

    if (sqrtP === sqrtNext) {
      if (initialized) {
        const net = await p.tickNet(tickNext);
        liquidity += zeroForOne ? -net : net;
        if (liquidity < 0n || liquidity > MAX_U128) throw new Unpriceable("the pool's liquidity goes out of range");
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtP !== start) {
      // v4-core recomputes the tick from the price here. The loop has ended,
      // so this port does not need it.
      tick = null;
    }
  }
  return { amountOut: out, amountIn: p.amountIn - remaining, sqrtPriceX96: sqrtP, liquidity };
}
