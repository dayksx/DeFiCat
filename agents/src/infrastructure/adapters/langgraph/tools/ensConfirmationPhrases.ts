/**
 * Both spending paths ask for a typed phrase, and the model only ever sees the
 * one a tool result hands it. Generating them in a single place keeps the quote
 * that *offers* a watch and the tool that *arms* it from drifting apart: a
 * mismatch shows up as the bot rejecting the phrase it just asked for.
 */
export function buyConfirmationPhrase(name: string, years: number): string {
  return `CONFIRM BUY ${name.toUpperCase()} FOR ${years} ${yearWord(years)}`;
}

export function watchConfirmationPhrase(name: string, years: number): string {
  const label = name.trim().toLowerCase().replace(/\.eth$/, '');
  return `CONFIRM WATCH AND BUY ${label.toUpperCase()}.ETH FOR ${years} ${yearWord(years)}`;
}

export function normalizeConfirmation(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function yearWord(years: number): string {
  return years === 1 ? 'YEAR' : 'YEARS';
}
