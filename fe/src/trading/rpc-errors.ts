import {
  AbiDecodingDataSizeInvalidError, AbiDecodingDataSizeTooSmallError, AbiDecodingZeroDataError,
  BaseError, ContractFunctionRevertedError, ExecutionRevertedError, HttpRequestError,
  LimitExceededRpcError, RawContractError, RpcRequestError, SocketClosedError, TimeoutError, WebSocketRequestError,
} from 'viem';

// Errors that say nothing about the contract — the node could not be reached, timed out or
// rate-limited us. Such a failure must never be read as "this simulation reverted": callers treat
// a revert as a real answer ("no", "too large") and may cache or build on it.
const TRANSPORT_ERRORS = [HttpRequestError, TimeoutError, WebSocketRequestError, SocketClosedError, LimitExceededRpcError];

const walkFinds = (error: unknown, match: (e: unknown) => boolean): boolean =>
  error instanceof BaseError ? error.walk(match) !== null : match(error);

export function isTransportError(error: unknown): boolean {
  return walkFinds(error, (e) => TRANSPORT_ERRORS.some((cls) => e instanceof cls));
}

// True when a failed eth_call simulation means "this call has no answer" (a revert, an empty or
// undecodable result). Unknown RPC failures must propagate; in particular, a provider's rate-limit
// code must never become a false "too large" result in the reverse quote solver.
export function isNoAnswerError(error: unknown): boolean {
  if (isTransportError(error)) return false;
  // viem can wrap a JSON-RPC failure in ExecutionRevertedError based on its message. The RPC code
  // is authoritative: only code 3 is an execution revert.
  if (walkFinds(error, (e) => e instanceof RpcRequestError && e.code !== 3)) return false;
  return walkFinds(error, (e) =>
    e instanceof ContractFunctionRevertedError
    || e instanceof ExecutionRevertedError
    || e instanceof RawContractError
    || (e instanceof RpcRequestError && e.code === 3)
    || e instanceof AbiDecodingZeroDataError
    || e instanceof AbiDecodingDataSizeTooSmallError
    || e instanceof AbiDecodingDataSizeInvalidError);
}
