/** Count only browser-committed layout structure, never content or URLs.
 * Shared contract for MV3C runtime logs and source-vs-client comparisons. */
export function countNativeRenderLayout(root: HTMLElement): {
  renderedGridContainers: number;
  renderedFlexContainers: number;
  renderedImageRows: number;
} {
  let renderedGridContainers = 0;
  let renderedFlexContainers = 0;
  const elements = Array.from(root.querySelectorAll('*')).slice(0, 1400);
  for (const element of elements) {
    const display = getComputedStyle(element).display;
    if (display === 'grid' || display === 'inline-grid') renderedGridContainers++;
    else if (display === 'flex' || display === 'inline-flex') renderedFlexContainers++;
  }
  const imageTops = Array.from(root.querySelectorAll('img')).slice(0, 80)
    .map(img => img.getBoundingClientRect().top)
    .filter(top => Number.isFinite(top)).sort((a, b) => a - b);
  let renderedImageRows = 0;
  let lastTop: number | null = null;
  for (const top of imageTops) {
    if (lastTop === null || Math.abs(top - lastTop) > 20) renderedImageRows++;
    lastTop = top;
  }
  return { renderedGridContainers, renderedFlexContainers, renderedImageRows };
}
