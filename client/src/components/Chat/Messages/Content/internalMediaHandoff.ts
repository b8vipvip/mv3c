/** Recognize exact ChatGPT internal image-tool control output, not real prose.
 * Historical mv3c conversations may contain one or more adjacent markers.
 * This function is display-only: never rewrite a user's intentionally typed
 * content or mutate the persisted conversation while rendering.
 */
export function isInternalMediaHandoff(text: string): boolean {
  const value = String(text || '').trim();
  return value.length > 0 &&
    /^(?:\{\s*"skipped_mainline"\s*:\s*true\s*\}\s*)+$/.test(value);
}
