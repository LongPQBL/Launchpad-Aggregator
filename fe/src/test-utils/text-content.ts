// Text split across child elements (e.g. a label followed by a rolling number) is invisible to
// getByText, which only reads an element's own text nodes. This matches the outermost element whose
// whole textContent equals/matches `expected` (the one that carries the styling classes), so such text
// is found as one piece.
// A rolling number carries its settled text in aria-label; its textContent also holds the outgoing glyphs mid-roll.
function readable(element: Element): string {
  return element.getAttribute('aria-label') ?? element.textContent ?? '';
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function textContent(expected: string | RegExp) {
  const matches = (value: string) => typeof expected === 'string' ? normalize(value) === expected : expected.test(normalize(value));
  return (_content: string, element: Element | null): boolean => {
    if (!element || !matches(readable(element))) return false;
    // An exact string names one element: the outermost one (it carries the styling classes). A pattern can match
    // any enclosing element too, so there the deepest one is taken.
    if (typeof expected === 'string') return !element.parentElement || !matches(readable(element.parentElement));
    return ![...element.children].some((child) => matches(readable(child)));
  };
}
