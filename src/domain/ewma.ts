import type { EWMASnapshot } from "../types";

export function alphaFromWindow(windowDays: number): number {
  return 2 / (windowDays + 1);
}

export function applyEWMA(previous: number, value: number, windowDays: number): number {
  const alpha = alphaFromWindow(windowDays);
  return alpha * value + (1 - alpha) * previous;
}

export function updateSnapshot(
  previous: EWMASnapshot | undefined,
  key: string,
  load: number,
  windows: number[],
): EWMASnapshot {
  const base: EWMASnapshot = previous ?? {
    key,
    ewma10: 0,
    ewma15: 0,
    ewma20: 0,
    ewma25: 0,
    updatedAt: new Date().toISOString(),
  };

  const next = { ...base };

  for (const window of windows) {
    if (window === 10) {
      next.ewma10 = applyEWMA(base.ewma10, load, 10);
    } else if (window === 15) {
      next.ewma15 = applyEWMA(base.ewma15, load, 15);
    } else if (window === 20) {
      next.ewma20 = applyEWMA(base.ewma20, load, 20);
    } else if (window === 25) {
      next.ewma25 = applyEWMA(base.ewma25, load, 25);
    }
  }

  next.updatedAt = new Date().toISOString();
  return next;
}
