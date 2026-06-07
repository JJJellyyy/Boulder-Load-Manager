export const GRADES = [
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

export const FONT_BY_GRADE: Record<(typeof GRADES)[number], string> = {
  V0: "4",
  V1: "5",
  V2: "5+",
  V3: "6A",
  V4: "6A+",
  V5: "6C",
  V6: "7A",
  V7: "7A+",
  V8: "7B",
  V9: "7C",
  V10: "7C+",
  V11: "8A",
  V12: "8A+",
  V13: "8B",
  V14: "8B+",
  V15: "8C",
  V16: "8C+",
  V17: "9A",
};

export const HOLD_TYPES = ["crimps", "sloper", "pockets", "mixed"] as const;

export const WALL_ANGLES = ["slab", "vert", "overhang", "roof", "board", "mixed"] as const;

export type Grade = (typeof GRADES)[number];
export type HoldType = (typeof HOLD_TYPES)[number];
export type WallAngle = (typeof WALL_ANGLES)[number];

export type EWMADays = 10 | 15 | 20 | 25;
export type GradeDisplayUnit = "v" | "font";
export type FiveThreeOneWeek = 1 | 2 | 3 | 4;

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
  basePoints: number;
  multiplierPerGrade: number;
}

export interface SpeedMultiplierConfig {
  targetMinutesPerBoulder: number;
  exponent: number;
  maxMultiplier: number;
  minMultiplier: number;
}

export interface RecoveryConfig {
  personalMaxSleepHours: number;
  sleepPenalty: {
    exponent: number;
    maxPenalty: number;
  };
  stressPenalty: {
    threshold: number;
    exponent: number;
    maxPenalty: number;
  };
}

export interface LoadModelConfig {
  gradeIntensity: GradeIntensityConfig;
  speed: SpeedMultiplierConfig;
  recovery: RecoveryConfig;
  ewmaWindows: EWMADays[];
  acwr: {
    acuteWindow: EWMADays;
    chronicWindow: EWMADays;
    lowThreshold: number;
    highThreshold: number;
    targetAcwr: number;
  };
  showAllCombinations: boolean;
}

export interface AppSettings {
  climberMaxGrade: Grade;
  gradeDisplayUnit: GradeDisplayUnit;
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
  strengthTemplates?: StrengthExerciseTemplate[];
  strengthSessions?: StrengthSession[];
}

export interface StrengthExerciseTemplate {
  id: string;
  name: string;
  oneRepMaxKg?: number;
  trainingMaxKg: number;
  incrementKg: number;
  amrapPerformedByWeek?: Partial<Record<FiveThreeOneWeek, number>>;
  cycleNumber?: number;
  cycleHistory?: { cycle: number; oneRepMaxKg: number }[];
}

export interface FiveThreeOneSet {
  percentage: number;
  reps: string;
  targetWeightKg: number;
}

export interface StrengthExercisePlan {
  templateId: string;
  name: string;
  trainingMaxKg: number;
  sets: FiveThreeOneSet[];
}

export interface StrengthSession {
  id: string;
  createdAt: string;
  sessionDate: string;
  week: FiveThreeOneWeek;
  exercises: StrengthExercisePlan[];
  notes?: string;
  cycleNumber?: number;
}
