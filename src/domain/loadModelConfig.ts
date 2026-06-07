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
      targetMinutesPerBoulder: 5,
      exponent: 1.35,
      minMultiplier: 0.7,
      maxMultiplier: 4,
    },
    recovery: {
      personalMaxSleepHours: 8.5,
      sleepPenalty: {
        exponent: 2,
        maxPenalty: 0.6,
      },
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

  const legacyGrade = incoming.model?.gradeIntensity as
    | {
        base?: number;
        scale?: number;
        exponent?: number;
      }
    | undefined;
  const legacySpeed = incoming.model?.speed as
    | {
        baselineProblemsPerMinute?: number;
        curveSteepness?: number;
      }
    | undefined;
  const legacySleep = incoming.model?.recovery?.sleepPenalty as
    | {
        points?: Array<{ penalty: number }>;
      }
    | undefined;

  const legacySpeedTargetMinutes = legacySpeed?.baselineProblemsPerMinute
    ? 1 / Math.max(0.01, legacySpeed.baselineProblemsPerMinute)
    : undefined;
  const legacySleepMaxPenalty = legacySleep?.points?.length
    ? Math.max(...legacySleep.points.map((point) => point.penalty))
    : undefined;

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
        targetMinutesPerBoulder:
          incoming.model?.speed?.targetMinutesPerBoulder ??
          legacySpeedTargetMinutes ??
          DEFAULT_SETTINGS.model.speed.targetMinutesPerBoulder,
        exponent:
          incoming.model?.speed?.exponent ??
          legacySpeed?.curveSteepness ??
          DEFAULT_SETTINGS.model.speed.exponent,
        minMultiplier:
          incoming.model?.speed?.minMultiplier ?? DEFAULT_SETTINGS.model.speed.minMultiplier,
        maxMultiplier:
          incoming.model?.speed?.maxMultiplier ?? DEFAULT_SETTINGS.model.speed.maxMultiplier,
      },
      recovery: {
        personalMaxSleepHours:
          incoming.model?.recovery?.personalMaxSleepHours ??
          DEFAULT_SETTINGS.model.recovery.personalMaxSleepHours,
        sleepPenalty: {
          exponent:
            incoming.model?.recovery?.sleepPenalty?.exponent ??
            DEFAULT_SETTINGS.model.recovery.sleepPenalty.exponent,
          maxPenalty:
            incoming.model?.recovery?.sleepPenalty?.maxPenalty ??
            legacySleepMaxPenalty ??
            DEFAULT_SETTINGS.model.recovery.sleepPenalty.maxPenalty,
        },
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

  next.model.speed.targetMinutesPerBoulder = clamp(next.model.speed.targetMinutesPerBoulder, 0.5, 15);
  next.model.speed.exponent = clamp(next.model.speed.exponent, 0.1, 4);
  next.model.speed.minMultiplier = clamp(next.model.speed.minMultiplier, 0.1, 1.5);
  next.model.speed.maxMultiplier = clamp(next.model.speed.maxMultiplier, next.model.speed.minMultiplier, 8);

  next.model.recovery.personalMaxSleepHours = clamp(next.model.recovery.personalMaxSleepHours, 4, 12);
  next.model.recovery.sleepPenalty.exponent = clamp(next.model.recovery.sleepPenalty.exponent, 0.5, 6);
  next.model.recovery.sleepPenalty.maxPenalty = clamp(next.model.recovery.sleepPenalty.maxPenalty, 0, 0.95);

  const allowedWindows = [10, 15, 20, 25] as const;
  const filteredWindows = next.model.ewmaWindows.filter((windowValue) =>
    allowedWindows.includes(windowValue),
  );
  next.model.ewmaWindows = filteredWindows.length ? filteredWindows : [...DEFAULT_SETTINGS.model.ewmaWindows];

  next.model.acwr.lowThreshold = clamp(next.model.acwr.lowThreshold, 0.3, 1.5);
  next.model.acwr.highThreshold = clamp(next.model.acwr.highThreshold, next.model.acwr.lowThreshold + 0.05, 2.5);

  if (!allowedWindows.includes(next.model.acwr.acuteWindow)) {
    next.model.acwr.acuteWindow = DEFAULT_SETTINGS.model.acwr.acuteWindow;
  }

  if (!allowedWindows.includes(next.model.acwr.chronicWindow)) {
    next.model.acwr.chronicWindow = DEFAULT_SETTINGS.model.acwr.chronicWindow;
  }

  if (next.model.acwr.acuteWindow === next.model.acwr.chronicWindow) {
    next.model.acwr.chronicWindow = next.model.acwr.acuteWindow === 25 ? 20 : 25;
  }

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
