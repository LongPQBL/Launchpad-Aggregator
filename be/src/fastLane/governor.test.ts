import { describe, expect, it } from 'vitest';
import { createGovernor } from './governor.js';

describe('createGovernor', () => {
  it('stays off while Envio keeps up', () => {
    const governor = createGovernor();
    for (let i = 0; i < 100; i += 1) expect(governor.observe(10)).toBeNull();
    expect(governor.state()).toBe('off');
  });

  it('switches on after 3 consecutive samples at or above 40 blocks, not after a blip', () => {
    const governor = createGovernor();
    expect(governor.observe(120)).toBeNull();
    expect(governor.observe(120)).toBeNull();
    expect(governor.observe(10)).toBeNull(); // the streak is broken
    expect(governor.observe(120)).toBeNull();
    expect(governor.observe(120)).toBeNull();
    expect(governor.observe(40)).toBe('on');
    expect(governor.state()).toBe('on');
  });

  it('switches off only after 30 consecutive samples at or below 16 blocks, and a slow sample resets the count', () => {
    const governor = createGovernor();
    for (let i = 0; i < 3; i += 1) governor.observe(500);
    expect(governor.state()).toBe('on');
    for (let i = 0; i < 29; i += 1) expect(governor.observe(12)).toBeNull();
    expect(governor.observe(25)).toBeNull(); // between the thresholds: neither behind nor keeping up
    for (let i = 0; i < 29; i += 1) expect(governor.observe(12)).toBeNull();
    expect(governor.observe(12)).toBe('off');
    expect(governor.state()).toBe('off');
  });

  it('treats an unknown lag as behind, never as keeping up', () => {
    const governor = createGovernor();
    governor.observe(null); governor.observe(null);
    expect(governor.observe(null)).toBe('on');
    for (let i = 0; i < 100; i += 1) governor.observe(null);
    expect(governor.state()).toBe('on');
  });

  it('takes its thresholds from the options', () => {
    const governor = createGovernor({ onLagBlocks: 8, offLagBlocks: 2, onAfterSamples: 1, offAfterSamples: 2 });
    expect(governor.observe(8)).toBe('on');
    governor.observe(2);
    expect(governor.observe(2)).toBe('off');
  });
});
