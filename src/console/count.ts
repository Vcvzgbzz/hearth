/** A count as a person reads it: 950, 12.4k, 3.1M, 1.51B, 2.04T. */
export const short = (n: number): string =>
  n < 1000 ? String(n)
  : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  : n < 1e9 ? `${(n / 1e6).toFixed(1)}M`
  : n < 1e12 ? `${(n / 1e9).toFixed(n < 1e10 ? 2 : 1)}B`
  : `${(n / 1e12).toFixed(n < 1e13 ? 2 : 1)}T`;
