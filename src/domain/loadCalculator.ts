import type {
  AppSettings,
  BoulderTypeLoad,
  CalculationResult,
  Grade,
  HoldType,
  ProblemEntry,
  SessionInput,
  SleepPenaltyPoint,
  WallAngle,
} from "../types";

const V_GRADE_OFFSET = 4;

export function gradeToNumber(grade: Grade): number {
  return Number(grade.replace("V", ""));
}

function relativeIntensity(problemGrade: Grade, climberMaxGrade: Grade): number {
  const problem = gradeToNumber(problemGrade);
  const max = gradeToNumber(climberMaxGrade);

  if (max <= 0) {
    return 1;
  }

  return Math.max(0, problem / max);
}

export function calculateGradeIntensity(problemGrade: Grade, settings: AppSettings): number {
  const { exponent, base, scale, minimum, maximum } = settings.model.gradeIntensity;
  const relative = relativeIntensity(problemGrade, settings.climberMaxGrade);

  const weighted = base + scale * Math.pow(relative, exponent);
  return clamp(weighted, minimum, maximum);
}

export function calculateSpeedMultiplier(totalProblems: number, durationMinutes: number, settings: AppSettings): number {
  const safeDuration = Math.max(1, durationMinutes);
  const pace = totalProblems / safeDuration;
  const speed = settings.model.speed;

  const normalized = pace / Math.max(0.01, speed.baselineProblemsPerMinute);
  const growth = 1 - Math.exp(-speed.curveSteepness * normalized);

  const value = speed.minMultiplier + growth * (speed.maxMultiplier - speed.minMultiplier);
  return clamp(value, speed.minMultiplier, speed.maxMultiplier);
}

function interpolatePenalty(points: SleepPenaltyPoint[], deficit: number): number {
  const sorted = [...points].sort((a, b) => a.deficit - b.deficit);

  if (deficit <= sorted[0].deficit) {
    return sorted[0].penalty;
  }

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];

    if (deficit <= end.deficit) {
      const ratio = (deficit - start.deficit) / Math.max(0.0001, end.deficit - start.deficit);
      return start.penalty + ratio * (end.penalty - start.penalty);
    }
  }

  return sorted[sorted.length - 1].penalty;
}

export function calculateSleepRecoveryMultiplier(actualSleepHours: number, settings: AppSettings): number {
  const personalMax = Math.max(0.1, settings.model.recovery.personalMaxSleepHours);
  const deficit = clamp((personalMax - actualSleepHours) / personalMax, 0, 1);
  const penalty = interpolatePenalty(settings.model.recovery.sleepPenalty.points, deficit);
  return 1 - clamp(penalty, 0, settings.model.recovery.sleepPenalty.maxPenalty);
}

function getBoulderKey(holdType: HoldType, wallAngle: WallAngle): string {
  return `${holdType}__${wallAngle}`;
}

function aggregateProblemGroups(problems: ProblemEntry[]): Map<string, ProblemEntry[]> {
  const grouped = new Map<string, ProblemEntry[]>();

  for (const problem of problems) {
    const key = getBoulderKey(problem.holdType, problem.wallAngle);
    const existing = grouped.get(key) ?? [];
    existing.push(problem);
    grouped.set(key, existing);
  }

  return grouped;
}

export function calculateSessionLoad(session: SessionInput, settings: AppSettings): CalculationResult {
  const totalProblems = session.problems.reduce((sum, item) => sum + item.count, 0);
  const speedMultiplier = calculateSpeedMultiplier(totalProblems, session.durationMinutes, settings);
  const recoveryMultiplier = calculateSleepRecoveryMultiplier(session.sleepHours, settings);
  const grouped = aggregateProblemGroups(session.problems);

  const byBoulderType: BoulderTypeLoad[] = [];

  for (const [key, entries] of grouped.entries()) {
    const holdType = entries[0].holdType;
    const wallAngle = entries[0].wallAngle;

    const rawLoad = entries.reduce((sum, item) => {
      const gradeIntensity = calculateGradeIntensity(item.grade, settings);
      return sum + item.count * gradeIntensity;
    }, 0);

    byBoulderType.push({
      key,
      holdType,
      wallAngle,
      rawLoad,
      adjustedLoad: rawLoad * speedMultiplier * recoveryMultiplier,
    });
  }

  const totalLoad = byBoulderType.reduce((sum, item) => sum + item.adjustedLoad, 0);

  return {
    totalLoad,
    speedMultiplier,
    recoveryMultiplier,
    byBoulderType,
  };
}

export function suggestedCapacityRange(climberMaxGrade: Grade): { min: number; max: number } {
  const maxNumeric = gradeToNumber(climberMaxGrade) - V_GRADE_OFFSET;
  const min = V_GRADE_OFFSET + Math.max(0, maxNumeric * 0.4);
  const max = V_GRADE_OFFSET + Math.max(0, maxNumeric * 0.6);
  return { min, max };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
