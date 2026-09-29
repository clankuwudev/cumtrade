// Calldata tools for the web tests: decode a plan step with viem, change a
// field, and encode it again. viem is independent of the page's own codec,
// which is what these tests are checking.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";

export const calls = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function buy(uint256 amountIn, uint256 minOut, address to)",
  "function sell(uint256 amountIn, uint256 minOut, address to)",
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

/** Decode a flat call, let `edit` change its arguments, and encode it again. */
export function recall(data, edit) {
  const { functionName, args } = decodeFunctionData({ abi: calls, data });
  return encodeFunctionData({ abi: calls, functionName, args: edit([...args]) });
}

const V4_INPUT = [{ type: "bytes" }, { type: "bytes[]" }];
const KEY = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }];
// Robinhood's Universal Router reads a uint256 minHopPriceX36 before the hook
// data (developer.clank.trade; V4R). LEGACY is the generic V4 tuple without it.
const SWAP = [{
  type: "tuple",
  components: [{ type: "tuple", components: KEY }, { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }, { type: "bytes" }],
}];
const LEGACY = [{
  type: "tuple",
  components: [{ type: "tuple", components: KEY }, { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
}];
const PAIR = [{ type: "address" }, { type: "uint256" }];

/** A router swap's calldata, opened into every field. */
export function openSwap(data) {
  const [commands, inputs, deadline] = decodeFunctionData({ abi: calls, data }).args;
  const [actions, params] = decodeAbiParameters(V4_INPUT, inputs[0]);
  const [[key, zeroForOne, amountIn, minOut, minHop, hookData]] = decodeAbiParameters(SWAP, params[0]);
  return {
    commands, deadline, actions, key: [...key], zeroForOne, amountIn, minOut, minHop, hookData,
    settle: [...decodeAbiParameters(PAIR, params[1])], take: [...decodeAbiParameters(PAIR, params[2])],
    moreInputs: inputs.slice(1), moreParams: params.slice(3),
  };
}

/** `pad` appends bytes inside one nested value, leaving everything around it canonical. */
export function closeSwap(s) {
  const pad = (part) => (s.pad?.[part] ?? "");
  const swap = (s.legacy
    ? encodeAbiParameters(LEGACY, [[s.key, s.zeroForOne, s.amountIn, s.minOut, s.hookData]])
    : encodeAbiParameters(SWAP, [[s.key, s.zeroForOne, s.amountIn, s.minOut, s.minHop ?? 0n, s.hookData]])) + pad("swap");
  const settle = encodeAbiParameters(PAIR, s.settle) + pad("settle");
  const take = encodeAbiParameters(PAIR, s.take) + pad("take");
  const input = encodeAbiParameters(V4_INPUT, [s.actions, [swap, settle, take, ...s.moreParams]]) + pad("input");
  return encodeFunctionData({ abi: calls, functionName: "execute", args: [s.commands, [input, ...s.moreInputs], s.deadline] });
}

export const reswap = (data, edit) => {
  const s = openSwap(data);
  edit(s);
  return closeSwap(s);
};

/** One ABI word, as hex without 0x. */
export const word = (v) => BigInt(v).toString(16).padStart(64, "0");
