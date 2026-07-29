/** NEGATIVE fixture (T-P0-6): a banned word in a literal NESTED inside a
 * template interpolation, and in a double-quoted literal; both must be
 * found. */
const region = 'here';
export const nested = `Conditions ${region}: ${'drought warning issued by DDM'}.`;
export const doubleQuoted = "An alert from the DDM impact read.";
