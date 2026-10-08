import {
  BaseError, HttpRequestError, InvalidAddressError, LimitExceededRpcError, SocketClosedError, TimeoutError,
  WebSocketRequestError,
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

// Bugs in our own call construction (a bad address, a JS type error) — never a contract answer.
function isProgrammingError(error: unknown): boolean {
  return walkFinds(error, (e) => e instanceof InvalidAddressError)
    || error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError;
}

// True when a failed eth_call simulation means "this call has no answer" (a revert, an empty or
// undecodable result) — as opposed to an error that must propagate (transport or programming).
export function isNoAnswerError(error: unknown): boolean {
  return !isTransportError(error) && !isProgrammingError(error);
}
