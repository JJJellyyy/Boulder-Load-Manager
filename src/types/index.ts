export const GRADES = [
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
] as const;

export const HOLD_TYPES = ["crimps", "sloper", "pockets", "mixed"] as const;

export const WALL_ANGLES = ["slab", "vert", "overhang", "roof", "board"] as const;

export type Grade = (typeof GRADES)[number];
export type HoldType = (typeof HOLD_TYPES)[number];
export type WallAngle = (typeof WALL_ANGLES)[number];

export type EWMADays = 10 | 15 | 20 | 25;

export interface ProblemEntry {
  id: string;
  count: number;
  grade: Grade;
  holdType: HoldType;
  wallAngle: WallAngle;
  climbedOn?: string;
}

export interface SessionInput {
  id: string;
  createdAt: string;
  durationMinutes: number;
  sleepHours: number;
  stress: number;
  motivation: number;
  problems: ProblemEntry[];
}

export interface BoulderTypeLoad {
  key: string;
  holdType: HoldType;
  wallAngle: WallAngle;
  rawLoad: number;
  adjustedLoad: number;
}

export interface EWMASnapshot {
  key: string;
  ewma10: number;
  ewma15: number;
  ewma20: number;
  ewma25: number;
  updatedAt: string;
}

export interface GradeIntensityConfig {
  exponent: number;
  base: number;
  scale: number;
  minimum: number;
  maximum: number;
}

export interface SpeedMultiplierConfig {
  baselineProblemsPerMinute: number;
  curveSteepness: number;
  maxMultiplier: number;
  minMultiplier: number;
}

export interface SleepPenaltyPoint {
  deficit: number;
  penalty: number;
}

export interface SleepPenaltyConfig {
  points: SleepPenaltyPoint[];
  maxPenalty: number;
}

export interface RecoveryConfig {
  personalMaxSleepHours: number;
  sleepPenalty: SleepPenaltyConfig;
}

export interface LoadModelConfig {
  gradeIntensity: GradeIntensityConfig;
  speed: SpeedMultiplierConfig;
  recovery: RecoveryConfig;
  ewmaWindows: EWMADays[];
  showAllCombinations: boolean;
}

export interface AppSettings {
  climberMaxGrade: Grade;
  stressScaleMax: number;
  motivationScaleMax: number;
  model: LoadModelConfig;
}

export interface CalculationResult {
  totalLoad: number;
  speedMultiplier: number;
  recoveryMultiplier: number;
  byBoulderType: BoulderTypeLoad[];
}

export interface DriveBackupPayload {
  version: number;
  exportedAt: string;
  settings: AppSettings;
  sessions: SessionInput[];
  ewmaSnapshots: EWMASnapshot[];
}
