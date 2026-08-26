/**
 * Truncates a value to its column width, with a visible ellipsis.
 *
 * Registers do not respect our widths (Croatian full names often exceed 255 characters), and MySQL
 * would refuse the row.
 */
export function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
