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

const FONT_TO_V: Record<string, Grade> = {
  "4": "V0",
  "5": "V1",
  "5+": "V2",
  "6A": "V3",
  "6A+": "V4",
  "6B": "V5",
  "6B+": "V6",
  "6C": "V6",
  "6C+": "V7",
  "7A": "V7",
  "7A+": "V8",
  "7B": "V8",
  "7B+": "V9",
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

export function gradeToNumber(grade: Grade): number {
  return Number(grade.replace("V", ""));
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

export function displayToGrade(display: string, unit: GradeDisplayUnit): Grade | undefined {
  if (unit === "v") {
    return (GRADES_ORDER.find((grade) => grade === display) as Grade | undefined);
  }

  return FONT_TO_V[display.toUpperCase()];
}

export function calculateGradeIntensity(problemGrade: Grade, settings: AppSettings): number {
  return gradeToPoints(problemGrade, settings);
}

export function calculateSpeedMultiplier(totalProblems: number, durationMinutes: number, settings: AppSettings): number {
  const safeProblems = Math.max(1, totalProblems);
  const safeDuration = Math.max(1, durationMinutes);
  const minutesPerBoulder = safeDuration / safeProblems;
  const speed = settings.model.speed;

  const normalized = speed.targetMinutesPerBoulder / Math.max(0.05, minutesPerBoulder);
  const value = Math.pow(normalized, speed.exponent);
  return clamp(value, speed.minMultiplier, speed.maxMultiplier);
}

export function calculateSleepRecoveryMultiplier(actualSleepHours: number, settings: AppSettings): number {
  const personalMax = Math.max(0.1, settings.model.recovery.personalMaxSleepHours);
  const deficit = clamp((personalMax - actualSleepHours) / personalMax, 0, 1);
  const penalty = settings.model.recovery.sleepPenalty.maxPenalty * Math.pow(deficit, settings.model.recovery.sleepPenalty.exponent);
  return 1 - clamp(penalty, 0, settings.model.recovery.sleepPenalty.maxPenalty);
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

export function suggestedCapacityRange(climberMaxGrade: Grade): { min: number; max: number } {
  const maxNumeric = gradeToNumber(climberMaxGrade);
  const min = Math.max(0, maxNumeric * 0.4);
  const max = Math.max(min, maxNumeric * 0.6);
  return { min, max };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
