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
import { GRADES } from "../types";
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

export function calculateSpeedMultiplier(totalProblems: number, durationMinutes: number, settings: AppSettings): number {
  // Linear speed penalty: 10 min/boulder = 0% impact, 1 min/boulder = 100% impact
  const safeProblems = Math.max(1, totalProblems);
  const safeDuration = Math.max(1, durationMinutes);
  const minutesPerBoulder = safeDuration / safeProblems;

  if (minutesPerBoulder >= 10) return 1;
  if (minutesPerBoulder <= 1) return 1 + settings.model.speed.impactPercent / 100;
  
  // Linear interpolation: 10 min = 1x, 1 min = 1 + impactPercent%
  const deficit = (10 - minutesPerBoulder) / 9; // 0 at 10 min, 1 at 1 min
  return 1 + (settings.model.speed.impactPercent / 100) * deficit;
}

export function calculateSleepRecoveryMultiplier(actualSleepHours: number, settings: AppSettings): number {
  // Linear sleep penalty: personalMaxSleep = 0% impact, 0 hours = 100% impact
  const personalMax = Math.max(0.1, settings.model.recovery.personalMaxSleepHours);
  const deficit = clamp((personalMax - actualSleepHours) / personalMax, 0, 1);
  return 1 + (settings.model.recovery.sleepImpactPercent / 100) * deficit;
}

export function calculateStressMultiplier(stressLevel: number, settings: AppSettings): number {
  // Linear stress penalty: 0 stress = 0% impact, 10 stress = 100% impact
  const deficit = clamp(stressLevel / 10, 0, 1);
  return 1 + (settings.model.recovery.stressImpactPercent / 100) * deficit;
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

export function calculateGradeDistribution(
  targetLoad: number,
  durationMinutes: number,
  sleepHours: number,
  stressLevel: number,
  settings: AppSettings,
): Record<string, number> {
  const speed = calculateSpeedMultiplier(1, durationMinutes, settings);
  const recovery = calculateSleepRecoveryMultiplier(sleepHours, settings);
  const stress = calculateStressMultiplier(stressLevel, settings);
  const speedRecoveryStress = speed * recovery * stress;

  const distribution: Record<string, number> = {};
  for (const grade of GRADES) {
    const gradeIntensity = calculateGradeIntensity(grade, settings);
    const countForGrade = targetLoad / (gradeIntensity * speedRecoveryStress);
    distribution[grade] = Math.round(countForGrade);
  }
  return distribution;
}

export interface HistoryPoint {
  date: string;
  load: number;
  acute: number;
  chronic: number;
  acwr: number;
}

export interface MovingAveragePoint {
  date: string;
  average: number;
}

export function getSessionDayKey(session: SessionInput): string {
  const createdDay = session.createdAt?.slice(0, 10);
  if (createdDay && /^\d{4}-\d{2}-\d{2}$/.test(createdDay)) {
    return createdDay;
  }

  const climbedOn = session.problems.find((problem) => Boolean(problem.climbedOn))?.climbedOn;
  if (climbedOn) {
    return climbedOn.slice(0, 10);
  }

  const parsed = new Date(session.createdAt);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
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

  const sessionsByDate = new Map<string, SessionInput[]>();
  for (const session of sorted) {
    const dayKey = getSessionDayKey(session);
    const existing = sessionsByDate.get(dayKey) ?? [];
    existing.push(session);
    sessionsByDate.set(dayKey, existing);
  }

  const startDate = new Date(sorted[0].createdAt);
  startDate.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(sorted[sorted.length - 1].createdAt);
  endDate.setUTCHours(0, 0, 0, 0);

  let acute = 0;
  let chronic = 0;
  const all: HistoryPoint[] = [];
  const currentDate = new Date(startDate);

  while (currentDate <= endDate) {
    const dayKey = currentDate.toISOString().slice(0, 10);
    const daySessions = sessionsByDate.get(dayKey) ?? [];
    const load = daySessions.reduce((sum, session) => sum + calculateSessionLoad(session, settings).totalLoad, 0);

    acute = acuteAlpha * load + (1 - acuteAlpha) * acute;
    chronic = chronicAlpha * load + (1 - chronicAlpha) * chronic;
    const acwr = chronic > 0 ? acute / chronic : 0;

    all.push({ date: dayKey, load, acute, chronic, acwr });
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  if (daysBack === null) return all;

  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  return all.filter((point) => point.date >= cutoffDate);
}

export function buildMovingAverageSeries(history: HistoryPoint[], windowDays: number): MovingAveragePoint[] {
  if (history.length === 0 || windowDays <= 0) return [];

  const points: MovingAveragePoint[] = [];
  const rolling: number[] = [];

  for (const point of history) {
    rolling.push(point.load);
    if (rolling.length > windowDays) {
      rolling.shift();
    }
    const average = rolling.reduce((sum, value) => sum + value, 0) / rolling.length;
    points.push({ date: point.date, average });
  }

  return points;
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
