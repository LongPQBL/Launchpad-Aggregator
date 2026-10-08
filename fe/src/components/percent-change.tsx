'use client';

import { useState } from 'react';
import { formatPercent } from '@/api/format';
import { cn } from '@/lib/utils';

type RollDirection = 'up' | 'down';
const GLYPH_HEIGHT = '1.25em';

// One digit that slides to its new value: the outgoing glyph leaves upward and the new one enters
// from below when the value rose (the reverse when it fell). Everything else is a plain glyph.
function Digit({ char, direction }: { char: string; direction: RollDirection }) {
  const [state, setState] = useState({ char, previous: char, tick: 0 });
  // Derive from props during render (React's "adjust state when a prop changes" pattern).
  if (state.char !== char) setState({ char, previous: state.char, tick: state.tick + 1 });
  if (state.previous === state.char) return <span>{char}</span>;
  const outgoing = <span aria-hidden style={{ height: GLYPH_HEIGHT, lineHeight: GLYPH_HEIGHT }}>{state.previous}</span>;
  const incoming = <span style={{ height: GLYPH_HEIGHT, lineHeight: GLYPH_HEIGHT }}>{state.char}</span>;
  return (
    <span className="inline-block overflow-hidden align-bottom" style={{ height: GLYPH_HEIGHT }}>
      <span key={state.tick} data-testid="digit-roll" data-direction={direction}
        className={cn('flex flex-col', direction === 'up' ? 'digit-roll-up' : 'digit-roll-down')}
        onAnimationEnd={() => setState((current) => ({ ...current, previous: current.char }))}>
        {direction === 'up' ? <>{outgoing}{incoming}</> : <>{incoming}{outgoing}</>}
      </span>
    </span>
  );
}

// Only the arrow carries the up/down color; the number stays a soft white, like Uniswap's header.
// Digits slide whenever the value changes — including while scrubbing a chart, where each new
// hovered point restarts the slide from its current state.
export function PercentChange({ value }: { value: string | null }) {
  const { text, className, direction } = formatPercent(value);
  const [track, setTrack] = useState<{ value: string | null; direction: RollDirection }>({ value, direction: 'up' });
  if (track.value !== value) {
    const rose = value === null || track.value === null || Number(value) >= Number(track.value);
    setTrack({ value, direction: rose ? 'up' : 'down' });
  }
  return (
    <span className="inline-flex items-center gap-1 tabular-nums text-foreground/70">
      {direction !== 'flat' && <span aria-hidden className={cn('text-xs', className)}>{direction === 'up' ? '▲' : '▼'}</span>}
      <span className="inline-flex">
        {[...text].map((char, index) => /\d/.test(char)
          // Keyed from the right so a digit keeps its column when the number gains or loses a leading digit.
          ? <Digit key={text.length - index} char={char} direction={track.direction} />
          : <span key={text.length - index}>{char}</span>)}
      </span>
    </span>
  );
}
