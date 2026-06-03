import type { AppSettings } from "../types";

export const DEFAULT_SETTINGS: AppSettings = {
  climberMaxGrade: "V7",
  stressScaleMax: 10,
  motivationScaleMax: 10,
  model: {
    gradeIntensity: {
      exponent: 1.45,
      base: 0.4,
      scale: 1.2,
      minimum: 0.2,
      maximum: 2.0,
    },
    speed: {
      baselineProblemsPerMinute: 0.2,
      curveSteepness: 1.5,
      minMultiplier: 0.7,
      maxMultiplier: 1.6,
    },
    recovery: {
      personalMaxSleepHours: 8.5,
      sleepPenalty: {
        points: [
          { deficit: 0, penalty: 0 },
          { deficit: 0.1, penalty: 0.05 },
          { deficit: 0.2, penalty: 0.15 },
          { deficit: 0.3, penalty: 0.3 },
          { deficit: 0.4, penalty: 0.45 },
        ],
        maxPenalty: 0.6,
      },
    },
    ewmaWindows: [10, 15, 20, 25],
    showAllCombinations: true,
  },
};

export function clampSettings(input: AppSettings): AppSettings {
  const next = structuredClone(input);

  next.stressScaleMax = clamp(next.stressScaleMax, 3, 20);
  next.motivationScaleMax = clamp(next.motivationScaleMax, 3, 20);

  next.model.gradeIntensity.exponent = clamp(next.model.gradeIntensity.exponent, 0.2, 4);
  next.model.gradeIntensity.base = clamp(next.model.gradeIntensity.base, 0, 2);
  next.model.gradeIntensity.scale = clamp(next.model.gradeIntensity.scale, 0.1, 4);
  next.model.gradeIntensity.minimum = clamp(next.model.gradeIntensity.minimum, 0.05, 3);
  next.model.gradeIntensity.maximum = clamp(next.model.gradeIntensity.maximum, next.model.gradeIntensity.minimum, 5);

  next.model.speed.baselineProblemsPerMinute = clamp(next.model.speed.baselineProblemsPerMinute, 0.05, 2);
  next.model.speed.curveSteepness = clamp(next.model.speed.curveSteepness, 0.1, 6);
  next.model.speed.minMultiplier = clamp(next.model.speed.minMultiplier, 0.1, 1.5);
  next.model.speed.maxMultiplier = clamp(next.model.speed.maxMultiplier, next.model.speed.minMultiplier, 3);

  next.model.recovery.personalMaxSleepHours = clamp(next.model.recovery.personalMaxSleepHours, 4, 12);
  next.model.recovery.sleepPenalty.maxPenalty = clamp(next.model.recovery.sleepPenalty.maxPenalty, 0, 0.95);

  next.model.recovery.sleepPenalty.points = [...next.model.recovery.sleepPenalty.points]
    .sort((a, b) => a.deficit - b.deficit)
    .map((point) => ({
      deficit: clamp(point.deficit, 0, 1),
      penalty: clamp(point.penalty, 0, 1),
    }));

  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
