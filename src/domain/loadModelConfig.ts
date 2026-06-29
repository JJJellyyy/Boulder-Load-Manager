import type { AppSettings } from "../types";

export const DEFAULT_SETTINGS: AppSettings = {
  climberMaxGrade: "V7",
  gradeDisplayUnit: "v",
  stressScaleMax: 10,
  motivationScaleMax: 10,
  model: {
    gradeIntensity: {
      basePoints: 10,
      multiplierPerGrade: 5,
    },
    speed: {
      impactPercent: 40,
    },
    recovery: {
      personalMaxSleepHours: 8.5,
      sleepImpactPercent: 60,
      stressImpactPercent: 15,
    },
    ewmaWindows: [10, 15, 20, 25],
    acwr: {
      acuteWindow: 10,
      chronicWindow: 25,
      lowThreshold: 0.8,
      highThreshold: 1.2,
      targetAcwr: 1.0,
    },
    showAllCombinations: true,
  },
};

export function clampSettings(input: AppSettings): AppSettings {
  const incoming = (input ?? DEFAULT_SETTINGS) as Partial<AppSettings>;

  const legacyGrade = (incoming?.model?.gradeIntensity as
    | {
        base?: number;
        scale?: number;
        exponent?: number;
      }
    | undefined);

  const next: AppSettings = {
    climberMaxGrade: incoming.climberMaxGrade ?? DEFAULT_SETTINGS.climberMaxGrade,
    gradeDisplayUnit: incoming.gradeDisplayUnit ?? DEFAULT_SETTINGS.gradeDisplayUnit,
    stressScaleMax: incoming.stressScaleMax ?? DEFAULT_SETTINGS.stressScaleMax,
    motivationScaleMax: incoming.motivationScaleMax ?? DEFAULT_SETTINGS.motivationScaleMax,
    model: {
      gradeIntensity: {
        ...DEFAULT_SETTINGS.model.gradeIntensity,
        basePoints:
          incoming.model?.gradeIntensity?.basePoints ??
          (legacyGrade?.base ? legacyGrade.base * 20 : DEFAULT_SETTINGS.model.gradeIntensity.basePoints),
        multiplierPerGrade:
          incoming.model?.gradeIntensity?.multiplierPerGrade ??
          (legacyGrade?.scale
            ? 2 + legacyGrade.scale
            : DEFAULT_SETTINGS.model.gradeIntensity.multiplierPerGrade),
      },
      speed: {
        ...DEFAULT_SETTINGS.model.speed,
        impactPercent: clamp(incoming.model?.speed?.impactPercent ?? DEFAULT_SETTINGS.model.speed.impactPercent, 0, 100),
      },
      recovery: {
        personalMaxSleepHours:
          incoming.model?.recovery?.personalMaxSleepHours ??
          DEFAULT_SETTINGS.model.recovery.personalMaxSleepHours,
        sleepImpactPercent: clamp(
          incoming.model?.recovery?.sleepImpactPercent ?? DEFAULT_SETTINGS.model.recovery.sleepImpactPercent,
          0,
          100
        ),
        stressImpactPercent: clamp(
          incoming.model?.recovery?.stressImpactPercent ?? DEFAULT_SETTINGS.model.recovery.stressImpactPercent,
          0,
          100
        ),
      },
      ewmaWindows: incoming.model?.ewmaWindows ?? DEFAULT_SETTINGS.model.ewmaWindows,
      acwr: {
        ...DEFAULT_SETTINGS.model.acwr,
        ...(incoming.model?.acwr ?? {}),
        targetAcwr: incoming.model?.acwr?.targetAcwr ?? DEFAULT_SETTINGS.model.acwr.targetAcwr,
      },
      showAllCombinations:
        incoming.model?.showAllCombinations ?? DEFAULT_SETTINGS.model.showAllCombinations,
    },
  };

  next.stressScaleMax = clamp(next.stressScaleMax, 3, 20);
  next.motivationScaleMax = clamp(next.motivationScaleMax, 3, 20);
  next.gradeDisplayUnit = next.gradeDisplayUnit === "font" ? "font" : "v";

  next.model.gradeIntensity.basePoints = clamp(next.model.gradeIntensity.basePoints, 1, 1000);
  next.model.gradeIntensity.multiplierPerGrade = clamp(next.model.gradeIntensity.multiplierPerGrade, 1.2, 8);

  next.model.speed.impactPercent = clamp(next.model.speed.impactPercent, 0, 100);

  next.model.recovery.personalMaxSleepHours = clamp(next.model.recovery.personalMaxSleepHours, 4, 12);
  next.model.recovery.sleepImpactPercent = clamp(next.model.recovery.sleepImpactPercent, 0, 100);
  next.model.recovery.stressImpactPercent = clamp(next.model.recovery.stressImpactPercent, 0, 100);

  // Ensure ewmaWindows are valid integers and within range
  next.model.ewmaWindows = next.model.ewmaWindows
    .map((w) => Math.round(w))
    .filter((w) => w >= 3 && w <= 60);
  if (next.model.ewmaWindows.length === 0) {
    next.model.ewmaWindows = [...DEFAULT_SETTINGS.model.ewmaWindows];
  }

  next.model.acwr.lowThreshold = clamp(next.model.acwr.lowThreshold, 0.3, 1.5);
  next.model.acwr.highThreshold = clamp(next.model.acwr.highThreshold, next.model.acwr.lowThreshold + 0.05, 2.5);
  next.model.acwr.acuteWindow = clamp(next.model.acwr.acuteWindow, 3, 60);
  next.model.acwr.chronicWindow = clamp(next.model.acwr.chronicWindow, 3, 60);
  next.model.acwr.targetAcwr = clamp(next.model.acwr.targetAcwr, 0.5, 1.5);

  // Add acute and chronic windows to the EWMA windows list
  if (!next.model.ewmaWindows.includes(next.model.acwr.acuteWindow)) {
    next.model.ewmaWindows = [...next.model.ewmaWindows, next.model.acwr.acuteWindow];
  }

  if (!next.model.ewmaWindows.includes(next.model.acwr.chronicWindow)) {
    next.model.ewmaWindows = [...next.model.ewmaWindows, next.model.acwr.chronicWindow];
  }

  next.model.ewmaWindows = [...new Set(next.model.ewmaWindows)].sort((a, b) => a - b);

  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
