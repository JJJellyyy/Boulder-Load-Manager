import type {
  AppSettings,
  BoulderTypeLoad,
  CalculationResult,
  Grade,
  GradeDisplayUnit,
  HoldType,
  SessionInput,
  WallAngle,
} from "../types";
import { FONT_BY_GRADE } from "../types";
const GRADES_ORDER = [
  "V0",
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
  "V9",
  "V10",
  "V11",
  "V12",
  "V13",
  "V14",
  "V15",
  "V16",
  "V17",
] as const;

const FONT_TO_V: Record<string, Grade | string> = {
  "4": "V0",
  "5": "V1",
  "5+": "V2",
  "6A": "V3",
  "6A+": "V4",
  "6B": "V4",
  "6B+": "V4",
  "6C": "V5",
  "6C+": "V5",
  "7A": "V6",
  "7A+": "V7",
  "7B": "V8",
  "7B+": "V8",
  "7C": "V9",
  "7C+": "V10",
  "8A": "V11",
  "8A+": "V12",
  "8B": "V13",
  "8B+": "V14",
  "8C": "V15",
  "8C+": "V16",
  "9A": "V17",
};

export function gradeToNumber(grade: Grade | string): number {
  const gradeStr = String(grade).replace("V", "");
  return parseFloat(gradeStr);
}

export function gradeToPoints(grade: Grade, settings: AppSettings): number {
  const gradeNumber = gradeToNumber(grade);
  return settings.model.gradeIntensity.basePoints * Math.pow(settings.model.gradeIntensity.multiplierPerGrade, gradeNumber);
}

export function gradeToDisplay(grade: Grade, unit: GradeDisplayUnit): string {
  if (unit === "font") {
    return FONT_BY_GRADE[grade];
  }

  return grade;
}

export function displayToGrade(display: string, unit: GradeDisplayUnit): string | undefined {
  if (unit === "v") {
    return (GRADES_ORDER.find((grade) => grade === display) as Grade | undefined);
  }

  return FONT_TO_V[display.toUpperCase()];
}

export function calculateGradeIntensity(problemGrade: Grade, settings: AppSettings): number {
  return gradeToPoints(problemGrade, settings);
}

export function calculateSpeedMultiplier(totalProblems: number, durationMinutes: number, _settings: AppSettings): number {
  const safeProblems = Math.max(1, totalProblems);
  const safeDuration = Math.max(1, durationMinutes);
  const minutesPerBoulder = safeDuration / safeProblems;

  // Smooth cubic ramp: near-zero above 4 min/boulder, steep below 2 min/boulder.
  // progress = 0 at 4+ min, 1 at 1 min. Cubic gives dramatic sub-2-min penalty.
  const clampedMinutes = clamp(minutesPerBoulder, 1, 10);
  const progress = clamp((4 - clampedMinutes) / 3, 0, 1);
  return clamp(5 * Math.pow(progress, 3), 0, 5);
}

export function calculateSleepRecoveryMultiplier(actualSleepHours: number, settings: AppSettings): number {
  const personalMax = Math.max(0.1, settings.model.recovery.personalMaxSleepHours);
  const deficit = clamp((personalMax - actualSleepHours) / personalMax, 0, 1);
  const penalty = settings.model.recovery.sleepPenalty.maxPenalty * Math.pow(deficit, settings.model.recovery.sleepPenalty.exponent);
  return 1 + clamp(penalty, 0, settings.model.recovery.sleepPenalty.maxPenalty);
}

export function calculateStressMultiplier(stressLevel: number, settings: AppSettings): number {
  const threshold = settings.model.recovery.stressPenalty.threshold;
  if (stressLevel < threshold) return 1;
  const maxStress = 10;
  const deficit = clamp((stressLevel - threshold) / (maxStress - threshold), 0, 1);
  const penalty = settings.model.recovery.stressPenalty.maxPenalty * Math.pow(deficit, settings.model.recovery.stressPenalty.exponent);
  return 1 + clamp(penalty, 0, settings.model.recovery.stressPenalty.maxPenalty);
}

function getBoulderKey(holdType: HoldType, wallAngle: WallAngle): string {
  return `${holdType}__${wallAngle}`;
}

function expandWallAngles(wallAngle: WallAngle): WallAngle[] {
  if (wallAngle === "mixed") {
    return ["slab", "vert", "overhang", "roof"];
  }

  return [wallAngle];
}

export function calculateSessionLoad(session: SessionInput, settings: AppSettings): CalculationResult {
  const totalProblems = session.problems.reduce((sum, item) => sum + item.count, 0);
  const speedMultiplier = calculateSpeedMultiplier(totalProblems, session.durationMinutes, settings);
  const recoveryMultiplier = calculateSleepRecoveryMultiplier(session.sleepHours, settings);
  const grouped = new Map<string, BoulderTypeLoad>();

  for (const problem of session.problems) {
    const gradeIntensity = calculateGradeIntensity(problem.grade, settings);
    const targetAngles = expandWallAngles(problem.wallAngle);
    const splitCount = problem.count / targetAngles.length;

    for (const angle of targetAngles) {
      const key = getBoulderKey(problem.holdType, angle);
      const rawContribution = splitCount * gradeIntensity;
      const existing = grouped.get(key);

      if (existing) {
        existing.rawLoad += rawContribution;
        existing.adjustedLoad = existing.rawLoad * speedMultiplier * recoveryMultiplier;
      } else {
        grouped.set(key, {
          key,
          holdType: problem.holdType,
          wallAngle: angle,
          rawLoad: rawContribution,
          adjustedLoad: rawContribution * speedMultiplier * recoveryMultiplier,
        });
      }
    }
  }

  const byBoulderType = Array.from(grouped.values());

  const totalLoad = byBoulderType.reduce((sum, item) => sum + item.adjustedLoad, 0);

  return {
    totalLoad,
    speedMultiplier,
    recoveryMultiplier,
    byBoulderType,
  };
}

/**
 * Given current EWMA state and a target ACWR, compute what session load is needed.
 * Formula: newAcute = α * load + (1-α) * prevAcute = targetAcwr * prevChronic
 * → load = (targetAcwr * prevChronic - (1-α) * prevAcute) / α
 */
export function solveTargetLoad(
  prevAcute: number,
  prevChronic: number,
  targetAcwr: number,
  acuteWindow: number,
): number {
  const alpha = 2 / (acuteWindow + 1);
  const required = (targetAcwr * prevChronic - (1 - alpha) * prevAcute) / alpha;
  return Math.max(0, required);
}

/**
 * Simple session-load estimator for a uniform set of problems.
 * Used by the planner solver.
 */
export function estimateSimpleLoad(
  count: number,
  durationMinutes: number,
  grade: Grade,
  sleepHours: number,
  stressLevel: number,
  settings: AppSettings,
): number {
  const gradeIntensity = calculateGradeIntensity(grade, settings);
  const speed = calculateSpeedMultiplier(count, durationMinutes, settings);
  const recovery = calculateSleepRecoveryMultiplier(sleepHours, settings);
  const stress = calculateStressMultiplier(stressLevel, settings);
  return count * gradeIntensity * speed * recovery * stress;
}

export interface HistoryPoint {
  date: string;
  load: number;
  acute: number;
  chronic: number;
  acwr: number;
}

/**
 * Build a time-ordered list of EWMA/ACWR values from raw sessions.
 * Returns all sessions computed from scratch (full history needed for accurate EWMA),
 * filtered to the last `daysBack` days for display.
 */
export function buildSessionHistory(
  sessions: SessionInput[],
  settings: AppSettings,
  daysBack: number | null,
): HistoryPoint[] {
  if (sessions.length === 0) return [];

  const sorted = [...sessions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const acuteWindow = settings.model.acwr.acuteWindow;
  const chronicWindow = settings.model.acwr.chronicWindow;
  const acuteAlpha = 2 / (acuteWindow + 1);
  const chronicAlpha = 2 / (chronicWindow + 1);

  let acute = 0;
  let chronic = 0;
  const all: HistoryPoint[] = [];

  for (const session of sorted) {
    const load = calculateSessionLoad(session, settings).totalLoad;
    acute = acuteAlpha * load + (1 - acuteAlpha) * acute;
    chronic = chronicAlpha * load + (1 - chronicAlpha) * chronic;
    const acwr = chronic > 0 ? acute / chronic : 0;
    all.push({ date: session.createdAt.slice(0, 10), load, acute, chronic, acwr });
  }

  if (daysBack === null) return all;

  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  return all.filter((point) => point.date >= cutoffDate);
}

export function suggestedCapacityRange(climberMaxGrade: Grade): { min: number; max: number } {
  const maxNumeric = gradeToNumber(climberMaxGrade);
  const min = Math.max(0, maxNumeric * 0.4);
  const max = Math.max(min, maxNumeric * 0.6);
  return { min, max };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
