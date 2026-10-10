'use client';

import { useEffect, useState } from 'react';
import { formatPercent } from '@/api/format';
import { cn } from '@/lib/utils';

type RollDirection = 'up' | 'down';
const GLYPH_HEIGHT = '1.25em';

// One digit that slides to its new value: the outgoing glyph leaves upward and the new one enters
// from below when the value rose (the reverse when it fell). Everything else is a plain glyph.
function Digit({ char, from, direction }: { char: string; from?: string; direction: RollDirection }) {
  // `from` is the glyph this column showed before it was mounted for a roll, so the first change still animates.
  const [state, setState] = useState({ char: from ?? char, previous: from ?? char, tick: 0 });
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

// Keep the previous numeric value so the digits roll in the direction of the update.
// `flash` is reserved for live market metrics; ages and transaction times only roll.
export function RollingText({ text, value, flash = false }: { text: string; value?: string | number | null; flash?: boolean }) {
  const [track, setTrack] = useState<{ previousText: string; text: string; value: string | number | null | undefined; direction: RollDirection; tone: RollDirection | null; tick: number }>({
    previousText: text, text, value, direction: 'up', tone: null, tick: 0,
  });
  if (track.text !== text || track.value !== value) {
    const previous = track.value === null || track.value === undefined ? NaN : Number(track.value);
    const current = value === null || value === undefined ? NaN : Number(value);
    const changed = track.text !== text && Number.isFinite(previous) && Number.isFinite(current) && previous !== current;
    const direction = changed && current < previous ? 'down' : 'up';
    setTrack({ previousText: track.text, text, value, direction, tone: flash && changed ? direction : null, tick: track.tick + 1 });
  }
  useEffect(() => {
    if (track.tone === null) return;
    const timeout = window.setTimeout(() => setTrack((current) => current.tick === track.tick ? { ...current, tone: null } : current), 2_000);
    return () => window.clearTimeout(timeout);
  }, [track.tick, track.tone]);
  return (
    <span className={cn('inline-flex tabular-nums transition-colors duration-300 motion-reduce:transition-none', track.tone === 'up' && 'text-emerald-500', track.tone === 'down' && 'text-red-500')} aria-label={text}>
      {track.tick === 0
        // Untouched text stays one plain node (copyable, searchable); it only splits into per-digit columns once it changes.
        ? <span>{text}</span>
        : <span aria-hidden className="inline-flex">
          {[...text].map((char, index) => {
            const previousChar = [...track.previousText][track.previousText.length - (text.length - index)];
            return /\d/.test(char)
              // Keyed from the right so a digit keeps its column when the number gains or loses a leading digit.
              ? <Digit key={text.length - index} char={char} from={previousChar && /\d/.test(previousChar) ? previousChar : undefined} direction={track.direction} />
              : <span key={text.length - index}>{char}</span>;
          })}
        </span>}
    </span>
  );
}

// Only the arrow carries the up/down color; the number stays a soft white, like Uniswap's header.
// Digits slide whenever the value changes — including while scrubbing a chart, where each new
// hovered point restarts the slide from its current state.
export function PercentChange({ value }: { value: string | null }) {
  const { text, className, direction } = formatPercent(value);
  return (
    <span className="inline-flex items-center gap-1 tabular-nums text-foreground/70">
      {direction !== 'flat' && <span aria-hidden className={cn('text-xs', className)}>{direction === 'up' ? '▲' : '▼'}</span>}
      <RollingText text={text} value={value} />
    </span>
  );
}
