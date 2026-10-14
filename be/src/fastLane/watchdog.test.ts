import { describe, expect, it } from 'vitest';
import { socketWatchdogVerdict } from './watchdog.js';

describe('socketWatchdogVerdict', () => {
  it('is ok under 120 s of silence, warns from 120 s and asks to exit from 600 s', () => {
    expect(socketWatchdogVerdict(0)).toBe('ok');
    expect(socketWatchdogVerdict(119.9)).toBe('ok');
    expect(socketWatchdogVerdict(120)).toBe('warn');
    expect(socketWatchdogVerdict(599)).toBe('warn');
    expect(socketWatchdogVerdict(600)).toBe('exit');
  });
  it('takes other limits', () => {
    expect(socketWatchdogVerdict(10, { warnAfter: 5, exitAfter: 20 })).toBe('warn');
    expect(socketWatchdogVerdict(20, { warnAfter: 5, exitAfter: 20 })).toBe('exit');
  });
});
