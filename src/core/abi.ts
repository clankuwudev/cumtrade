/**
 * ABIs reconstructed from on-chain bytecode (selectors resolved against the
 * openchain signature DB, then verified by eth_call against a live launch).
 * Names marked INFERRED matched by selector but are not source-verified.
 */
import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "function getLaunch(address token) view returns (bytes)",
  // Not a bool. The factory's registry entry: a 15-word struct of token, curve,
  // creator (twice), graduation threshold, V4 fee and tick spacing, a status
  // word and a final 1. It is all zeros, not a revert, for an address the
  // factory never launched. Only the first two words are decoded.
  "function getLaunchedToken(address token) view returns (address token, address curve)",
  "function tokenForCurve(address curve) view returns (address)",
  "function launchFee() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function MAX_CURVE_FEE_BPS() view returns (uint256)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function feeDestination() view returns (address)",
  "function poolManager() view returns (address)",
  "function memeHook() view returns (address)",
  "function locker() view returns (address)",
  "function graduationExecutor() view returns (address)",
  "function launchConfigCount() view returns (uint256)",
  "function GRADUATION_RESCUE_DELAY() view returns (uint256)",
  "event Launch(address indexed token, address indexed curve, address indexed creator, uint256 a, uint256 b, uint256 graduationThreshold)",
]);

export const curveAbi = parseAbi([
  // --- trading ---
  "function buy(uint256 amountIn, uint256 minOut, address to) payable returns (uint256)",
  "function sell(uint256 amountIn, uint256 minOut, address to) returns (uint256)",
  // Verified against live curves. Note the shapes DIFFER: buy returns 5 words,
  // sell returns 3. quoteSell reverts with InsufficientRealReserve (0x3d5b7999)
  // once the requested size would drain more ETH than the curve really holds,
  // so a large position cannot always be exited in one go.
  "function quoteBuy(uint256 amountIn) view returns (uint256 amountIn_, uint256 amountInAfterFee, uint256 fee, uint256 tokensOut, uint256 snipeTax)",
  "function quoteSell(uint256 tokensIn) view returns (uint256 quoteOutGross, uint256 quoteOutNet, uint256 fee)",
  "function quoteBuyFor(address buyer, uint256 amountIn) view returns (uint256, uint256, uint256, uint256, uint256)",
  // --- reserves / pricing (constant product over virtual + real reserves) ---
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function quoteReserve() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function realTokenReserve() view returns (uint256)",
  "function virtualTokenReserve() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  // --- lifecycle ---
  "function state() view returns (uint8)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
  "function readyAt() view returns (uint256)",
  // --- fees / anti-snipe ---
  "function feeBps() view returns (uint256)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function currentSnipeTaxBps(address buyer) view returns (uint256)",
  "function snipeTaxExempt(address who) view returns (bool)",
  // --- wiring ---
  "function token() view returns (address)",
  "function creator() view returns (address)",
  "function pairToken() view returns (address)",
  "function isNativeQuote() view returns (bool)",
  "function factory() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function protocolFeeRecipient() view returns (address)",
]);

/**
 * Launch token. Immutable ERC20 + metadata. Note the absence of mint/owner/
 * pause/blacklist/fee-on-transfer selectors in the deployed bytecode.
 */
export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function burn(uint256)",
  "function burnFrom(address,uint256)",
  // INFERRED from selector + live return value. There is no factory() or
  // creator() here: their selectors (0xc45a0155, 0x02d05d3f) are not in the
  // bytecode, so calling them reverts. 0x536dac9b and 0xd5f39488, once guessed
  // to be those two, are unidentified. Ask the curve and the registry.
  "function curve() view returns (address)",       // 0x7165485d
  "function description() view returns (string)",  // 0x7284e416
  "function logo() view returns (string)",         // 0xfb7f21eb
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Selectors present in the token bytecode. Anything NOT here cannot be called. */
export const TOKEN_SELECTORS = [
  "0x06fdde03","0x095ea7b3","0x18160ddd","0x23b872dd","0x313ce567","0x42966c68",
  "0x536dac9b","0x53cd512a","0x70a08231","0x7165485d","0x7284e416","0x79cc6790",
  "0x95d89b41","0xa9059cbb","0xabb1dc44","0xd5f39488","0xdd62ed3e","0xfb7f21eb",
] as const;
