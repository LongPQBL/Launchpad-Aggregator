import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowLogoRequest, getLogo, parseLogoCid, resetLogoCachesForTests } from './logo-proxy';

const CID = 'bafkreidl5gwco4s4yxhuhzo752gir4rxhfhsq45dncmif54uix7fznbasy';
let dir: string;
let bigPng: Buffer;

const imageResponse = (body: Buffer, type = 'image/png') => new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'logo-test-'));
  process.env.LOGO_CACHE_DIR = dir;
  bigPng = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#33aa55' } }).png().toBuffer();
});
afterAll(async () => { delete process.env.LOGO_CACHE_DIR; await rm(dir, { recursive: true, force: true }); });
beforeEach(() => resetLogoCachesForTests());

describe('parseLogoCid', () => {
  it('accepts a CID with an optional short path', () => {
    expect(parseLogoCid(CID)).toBe(CID);
    expect(parseLogoCid(`${CID}/logo.png`)).toBe(`${CID}/logo.png`);
  });
  it('rejects anything that is not a CID: a URL, a traversal, a query, nothing', () => {
    for (const bad of [null, '', 'http://169.254.169.254/latest', `${CID}?x=1`, `${CID}/../secret`, '../etc/passwd', 'short', `${CID}/a/b/c/d`]) expect(parseLogoCid(bad as string | null)).toBeNull();
  });
});

describe('getLogo', () => {
  it('shrinks the image to a 128 px WebP, asks only the fixed gateways, and keeps it on disk', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(bigPng));
    const logo = await getLogo(CID, fetchImpl as never);
    const meta = await sharp(logo!).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 128, height: 128 });
    expect(logo!.length).toBeLessThan(bigPng.length);
    const urls = fetchImpl.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.every((url) => url.startsWith('https://ipfs.filebase.io/ipfs/') || url.startsWith('https://gateway.pinata.cloud/ipfs/'))).toBe(true);
    expect((await readdir(dir)).length).toBe(1);
  });
  it('serves a repeated request from memory, and a fresh process from disk, without asking a gateway again', async () => {
    const fetchImpl = vi.fn(async () => imageResponse(bigPng));
    await getLogo(CID, fetchImpl as never);
    const calls = fetchImpl.mock.calls.length;
    await getLogo(CID, fetchImpl as never);
    resetLogoCachesForTests(); // as after a restart: only the disk copy is left
    expect(await getLogo(CID, fetchImpl as never)).not.toBeNull();
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });
  it('shares one fetch between simultaneous requests for the same logo', async () => {
    const other = 'bafkreiother0000000000000000000000000000000000000000000000';
    const fetchImpl = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return imageResponse(bigPng); });
    await Promise.all([getLogo(other, fetchImpl as never), getLogo(other, fetchImpl as never), getLogo(other, fetchImpl as never)]);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2); // one per gateway, not one per request
  });
  it('takes the answer of whichever gateway is up, and rejects a response that is not an image', async () => {
    const third = 'bafkreithird0000000000000000000000000000000000000000000000';
    const fetchImpl = vi.fn(async (url: string) => url.includes('filebase') ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : imageResponse(bigPng));
    expect(await getLogo(third, fetchImpl as never)).not.toBeNull();
  });
  it('answers null when every gateway fails, and does not hammer them again for a minute', async () => {
    const fourth = 'bafkreifourth000000000000000000000000000000000000000000000';
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    expect(await getLogo(fourth, fetchImpl as never, 1_000)).toBeNull();
    const calls = fetchImpl.mock.calls.length;
    expect(await getLogo(fourth, fetchImpl as never, 30_000)).toBeNull();
    expect(fetchImpl.mock.calls.length).toBe(calls);
    expect(await getLogo(fourth, fetchImpl as never, 70_000)).toBeNull();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
  });
  it('refuses bytes that are not a decodable image', async () => {
    const fifth = 'bafkreififth0000000000000000000000000000000000000000000000';
    const fetchImpl = vi.fn(async () => imageResponse(Buffer.from('not an image at all')));
    expect(await getLogo(fifth, fetchImpl as never)).toBeNull();
  });
});

describe('allowLogoRequest', () => {
  it('limits one client to 600 requests a minute', () => {
    const results = Array.from({ length: 601 }, () => allowLogoRequest('9.9.9.9', 5_000));
    expect(results.slice(0, 600).every(Boolean)).toBe(true);
    expect(results[600]).toBe(false);
    expect(allowLogoRequest('9.9.9.9', 70_000)).toBe(true);
  });
});
