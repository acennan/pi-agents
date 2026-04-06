/** Return "s" for plural counts and an empty string for singular. */
export function pluralize(count: number): string {
  return count === 1 ? "" : "s";
}
