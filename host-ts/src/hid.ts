export const KEY_F14 = 184;
export const KEY_F15 = 185;
const usageToKeycode = new Map<number, number>(Array.from({ length: 12 }, (_, index) => [0x68 + index, 183 + index]));

/** Decode an eight-byte boot-keyboard body, optionally prefixed with report ID 1. */
export function keycodesFromReport(input: Uint8Array): number[] | null {
  const data = input.length === 9 && input[0] === 1 ? input.slice(1) : input;
  if (data.length !== 8) return null;
  return [...new Set([...data.slice(2)].flatMap((usage) => usageToKeycode.get(usage) ?? []))].sort((a, b) => a - b);
}
