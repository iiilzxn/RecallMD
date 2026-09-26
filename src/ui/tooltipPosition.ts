/** 为长提示保留可滚动空间，并保证提示框处于可视窗口内。 */
export function tooltipPosition(
  anchor: { left: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const margin = 12;
  const gap = 8;
  const maxWidth = Math.max(1, Math.min(400, viewport.width - margin * 2));
  const width = Math.min(size.width, maxWidth);
  const above = Math.max(0, anchor.top - margin - gap);
  const below = Math.max(0, viewport.height - anchor.bottom - margin - gap);
  const useBelow = size.height <= below || (size.height > above && below >= above);
  const maxHeight = Math.max(1, Math.min(viewport.height - margin * 2, useBelow ? below : above));
  const height = Math.min(size.height, maxHeight);
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - margin - width)),
    top: Math.max(margin, Math.min(useBelow ? anchor.bottom + gap : anchor.top - gap - height, viewport.height - margin - height)),
    maxHeight,
    maxWidth,
  };
}
