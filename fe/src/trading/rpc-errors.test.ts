import { describe, expect, it } from 'vitest';
import {
  CallExecutionError, HttpRequestError, InvalidAddressError, LimitExceededRpcError, RpcRequestError, TimeoutError,
} from 'viem';
import { isNoAnswerError, isTransportError } from './rpc-errors';

const url = 'https://rpc.example';
const http = () => new HttpRequestError({ url, status: 503 });
const timeout = () => new TimeoutError({ body: {}, url });

describe('isTransportError', () => {
  it('recognises HTTP and timeout failures, also when viem wraps them (as client.call does)', () => {
    expect(isTransportError(http())).toBe(true);
    expect(isTransportError(timeout())).toBe(true);
    expect(isTransportError(new CallExecutionError(http(), {}))).toBe(true);
    expect(isTransportError(new LimitExceededRpcError(new Error('rate limited')))).toBe(true);
  });

  it('does not treat a revert or a plain Error as a transport failure', () => {
    expect(isTransportError(new Error('revert'))).toBe(false);
    const revert = new RpcRequestError({ body: {}, url, error: { code: 3, message: 'execution reverted' } });
    expect(isTransportError(new CallExecutionError(revert, {}))).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
  });
});

describe('isNoAnswerError', () => {
  it('only accepts an on-chain revert as no answer', () => {
    expect(isNoAnswerError(new Error('revert'))).toBe(false);
    const revert = new RpcRequestError({ body: {}, url, error: { code: 3, message: 'execution reverted' } });
    expect(isNoAnswerError(new CallExecutionError(revert, {}))).toBe(true);
  });

  it('propagates RPC rate limits even when wrapped by viem', () => {
    const limited = new RpcRequestError({ body: {}, url, error: { code: -32002, message: 'rate limited' } });
    expect(isNoAnswerError(limited)).toBe(false);
    expect(isNoAnswerError(new CallExecutionError(limited, {}))).toBe(false);
    expect(isNoAnswerError(new HttpRequestError({ url, status: 429 }))).toBe(false);
  });

  it('transport and programming errors are NOT "no answer" (they must propagate)', () => {
    expect(isNoAnswerError(http())).toBe(false);
    expect(isNoAnswerError(new CallExecutionError(timeout(), {}))).toBe(false);
    expect(isNoAnswerError(new InvalidAddressError({ address: '0xnope' }))).toBe(false);
    expect(isNoAnswerError(new TypeError('x is undefined'))).toBe(false);
  });
});
