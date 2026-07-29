/**
 * POSITIVE fixture (T-P0-6): regex literals and division must not desync
 * the lexer into misreading later code as strings. ZERO findings expected.
 */

export function clean(value: string, total: number, count: number): number {
  const stripped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const re = /warning|alert|forecast/i;
  const half = total / 2;
  const perItem = count > 0 ? total / count : 0;
  return re.test(stripped) ? half : perItem;
}

// After the regexes above, an ordinary safe string must still lex cleanly:
export const stillClean = 'conditions in context, stated honestly';
