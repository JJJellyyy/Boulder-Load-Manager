import { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  clearEwmaSnapshots,
  clearSessions,
  clearStrengthSessions,
  clearStrengthTemplates,
  deleteStrengthTemplate,
  loadEwmaSnapshots,
  loadSessions,
  loadSettings,
  loadStrengthSessions,
  loadStrengthTemplates,
  saveEwmaSnapshot,
  saveSession,
  saveSettings,
  saveStrengthSession,
  saveStrengthTemplate,
} from "./db/indexedDb";
import { updateSnapshot } from "./domain/ewma";
import { DEFAULT_SETTINGS, clampSettings } from "./domain/loadModelConfig";
import {
  calculateGradeIntensity,
  calculateSleepRecoveryMultiplier,
  calculateStressMultiplier,
  calculateSpeedMultiplier,
  calculateSessionLoad,
  calculateGradeDistribution,
  gradeToDisplay,
  gradeToNumber,
  suggestedCapacityRange,
  solveTargetLoad,
  estimateSimpleLoad,
  buildSessionHistory,
  type HistoryPoint,
} from "./domain/loadCalculator";
import {
  initiateGoogleOAuthRedirect,
  extractOAuthTokenFromUrl,
  downloadBackupFromGoogleDrive,
  fetchGoogleProfile,
  type GoogleAuthSession,
  type GoogleProfile,
  uploadBackupToGoogleDrive,
} from "./integrations/googleDrive";
import {
  GRADES,
  HOLD_TYPES,
  WALL_ANGLES,
  type AppSettings,
  type DriveBackupPayload,
  type EWMADays,
  type EWMASnapshot,
  type Grade,
  type GradeDisplayUnit,
  type HoldType,
  type FiveThreeOneSet,
  type FiveThreeOneWeek,
  type ProblemEntry,
  type SessionInput,
  type StrengthExerciseTemplate,
  type StrengthSession,
  type WallAngle,
} from "./types";

type TabName = "session" | "dashboard" | "strength" | "settings" | "history";

interface SessionDraft {
  durationMinutes: number;
  sleepHours: number;
  stress: number;
  motivation: number;
  problems: ProblemEntry[];
}

function createSessionDraft(settings: AppSettings): SessionDraft {
  return {
    durationMinutes: 120,
    sleepHours: settings.model.recovery.personalMaxSleepHours,
    stress: 5,
    motivation: 5,
    problems: [],
  };
}

function getId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.round(Math.random() * 100_000)}`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const GOOGLE_SESSION_STORAGE_KEY = "blm_google_session";

const DEFAULT_STRENGTH_TEMPLATE: StrengthExerciseTemplate = {
  id: "weighted-pull-up",
  name: "Weighted Pull-up",
  oneRepMaxKg: 22.5,
  trainingMaxKg: 20,
  incrementKg: 2.5,
};

function roundToIncrement(value: number, increment: number): number {
  const safeIncrement = Math.max(0.5, increment);
  return Math.round(value / safeIncrement) * safeIncrement;
}

function getTemplateTrainingMax(template: StrengthExerciseTemplate): number {
  if (typeof template.oneRepMaxKg === "number") {
    return template.oneRepMaxKg * 0.9;
  }

  return template.trainingMaxKg;
}

function get531Prescription(week: FiveThreeOneWeek): Array<{ percentage: number; reps: string }> {
  if (week === 1) {
    return [
      { percentage: 0.65, reps: "5" },
      { percentage: 0.75, reps: "5" },
      { percentage: 0.85, reps: "5+" },
    ];
  }

  if (week === 2) {
    return [
      { percentage: 0.7, reps: "3" },
      { percentage: 0.8, reps: "3" },
      { percentage: 0.9, reps: "3+" },
    ];
  }

  if (week === 3) {
    return [
      { percentage: 0.75, reps: "5" },
      { percentage: 0.85, reps: "3" },
      { percentage: 0.95, reps: "1+" },
    ];
  }

  return [
    { percentage: 0.4, reps: "5" },
    { percentage: 0.5, reps: "5" },
    { percentage: 0.6, reps: "5" },
  ];
}

function build531Sets(trainingMaxKg: number, incrementKg: number, week: FiveThreeOneWeek): FiveThreeOneSet[] {
  return get531Prescription(week).map((step) => ({
    percentage: step.percentage,
    reps: step.reps,
    targetWeightKg: roundToIncrement(trainingMaxKg * step.percentage, incrementKg),
  }));
}

function estimateOneRepMaxFromTopSet(
  trainingMaxKg: number,
  incrementKg: number,
  week: FiveThreeOneWeek,
): number {
  const sets = build531Sets(trainingMaxKg, incrementKg, week);
  const topSet = sets[sets.length - 1];
  const repsFloor = Math.max(1, Number.parseInt(topSet.reps, 10) || 1);
  const estimated = topSet.targetWeightKg * (1 + repsFloor / 30);
  return roundToIncrement(estimated, incrementKg);
}

function getEwmaValue(snapshot: EWMASnapshot, windowDays: EWMADays): number {
  if (windowDays === 10) {
    return snapshot.ewma10;
  }

  if (windowDays === 15) {
    return snapshot.ewma15;
  }

  if (windowDays === 20) {
    return snapshot.ewma20;
  }

  return snapshot.ewma25;
}

function getAcwrZone(acwr: number, lowThreshold: number, highThreshold: number): string {
  if (acwr < lowThreshold) {
    return "Detraining";
  }

  if (acwr > highThreshold) {
    return "High Risk";
  }

  return "Goldilocks";
}

interface CurvePoint {
  x: number;
  y: number;
}

interface CurveChartProps {
  title: string;
  xLabel: string;
  yLabel: string;
  points: CurvePoint[];
  stroke: string;
  xFormatter?: (value: number) => string;
  yFormatter?: (value: number) => string;
  yLogarithmic?: boolean;
}

function CurveChart({
  title,
  xLabel,
  yLabel,
  points,
  stroke,
  xFormatter = (value) => value.toFixed(2),
  yFormatter = (value) => value.toFixed(2),
  yLogarithmic = false,
}: CurveChartProps) {
  const width = 340;
  const height = 200;
  const padLeft = 52;
  const padRight = 16;
  const padTop = 12;
  const padBottom = 44;

  if (points.length < 2) {
    return (
      <article className="curve-card">
        <h4>{title}</h4>
        <p>Not enough data points to draw curve.</p>
      </article>
    );
  }

  const transformY = (v: number) => (yLogarithmic ? Math.log(Math.max(v, 0.001)) : v);

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minYT = Math.min(...points.map((p) => transformY(p.y)));
  const maxYT = Math.max(...points.map((p) => transformY(p.y)));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));

  const spanX = Math.max(0.0001, maxX - minX);
  const spanYT = Math.max(0.0001, maxYT - minYT);

  const toSvgX = (x: number) => padLeft + ((x - minX) / spanX) * (width - padLeft - padRight);
  const toSvgY = (y: number) => height - padBottom - ((transformY(y) - minYT) / spanYT) * (height - padTop - padBottom);

  const polyline = points.map((p) => `${toSvgX(p.x)},${toSvgY(p.y)}`).join(" ");

  // X axis ticks: 5 evenly spaced
  const xTicks = Array.from({ length: 5 }, (_, i) => minX + (i / 4) * spanX);
  // Y axis ticks: 5 evenly spaced (in original scale, not log)
  const yTicks = Array.from({ length: 5 }, (_, i) => minY + (i / 4) * (maxY - minY));

  return (
    <article className="curve-card">
      <h4>{title}{yLogarithmic && <span className="log-badge"> (log scale)</span>}</h4>
      <svg className="curve-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {/* Grid lines */}
        {yTicks.map((v, i) => (
          <line key={i} x1={padLeft} y1={toSvgY(v)} x2={width - padRight} y2={toSvgY(v)}
            stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
        ))}
        {/* Axes */}
        <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} className="curve-axis" />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={height - padBottom} className="curve-axis" />
        {/* X ticks + labels */}
        {xTicks.map((v, i) => (
          <g key={i}>
            <line x1={toSvgX(v)} y1={height - padBottom} x2={toSvgX(v)} y2={height - padBottom + 4} className="curve-axis" />
            <text x={toSvgX(v)} y={height - padBottom + 14} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.6">{xFormatter(v)}</text>
          </g>
        ))}
        {/* Y ticks + labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padLeft - 4} y1={toSvgY(v)} x2={padLeft} y2={toSvgY(v)} className="curve-axis" />
            <text x={padLeft - 6} y={toSvgY(v) + 3} textAnchor="end" fontSize="9" fill="currentColor" opacity="0.6">{yFormatter(v)}</text>
          </g>
        ))}
        {/* Axis labels */}
        <text x={padLeft + (width - padLeft - padRight) / 2} y={height - 4} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.75">{xLabel}</text>
        <text x={10} y={padTop + (height - padTop - padBottom) / 2} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.75"
          transform={`rotate(-90, 10, ${padTop + (height - padTop - padBottom) / 2})`}>{yLabel}</text>
        {/* Curve */}
        <polyline points={polyline} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </article>
  );
}

function AcwrHistoryChart({
  points,
  lowThreshold,
  highThreshold,
  targetAcwr,
}: {
  points: HistoryPoint[];
  lowThreshold: number;
  highThreshold: number;
  targetAcwr: number;
}) {
  const width = 600;
  const height = 220;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 48;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const maxAcwr = Math.max(2, ...points.map((p) => p.acwr)) * 1.05;
  const toX = (i: number) => padL + (i / (points.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - (v / maxAcwr) * chartH;

  const acwrLine = points.map((p, i) => `${toX(i)},${toY(p.acwr)}`).join(" ");

  // Colored zone rectangles
  const greenY1 = toY(highThreshold);
  const greenY2 = toY(lowThreshold);
  const yellowLoY1 = toY(lowThreshold);
  const yellowHiY2 = toY(highThreshold);

  // X-axis date ticks: show ~5 labels
  const tickIndices: number[] = [];
  const step = Math.max(1, Math.floor(points.length / 5));
  for (let i = 0; i < points.length; i += step) tickIndices.push(i);
  if (tickIndices[tickIndices.length - 1] !== points.length - 1) tickIndices.push(points.length - 1);

  // Y-axis ticks: 0, 0.5, 1.0, 1.5, 2.0 (up to maxAcwr)
  const yTicks = [0, 0.5, 1.0, 1.5, 2.0].filter((v) => v <= maxAcwr);

  return (
    <svg className="acwr-history-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="ACWR history">
      {/* Zone bands */}
      <rect x={padL} y={greenY1} width={chartW} height={greenY2 - greenY1} fill="#22c55e" opacity="0.12" />
      <rect x={padL} y={toY(maxAcwr)} width={chartW} height={Math.max(0, yellowLoY1 - toY(maxAcwr) - (chartH - yellowHiY2))} fill="transparent" />
      {/* Low zone (below low threshold) */}
      <rect x={padL} y={toY(lowThreshold)} width={chartW} height={Math.max(0, padT + chartH - toY(lowThreshold))} fill="#f59e0b" opacity="0.10" />
      {/* High zone (above high threshold) */}
      <rect x={padL} y={padT} width={chartW} height={Math.max(0, toY(highThreshold) - padT)} fill="#ef4444" opacity="0.10" />
      {/* Grid + threshold lines */}
      {yTicks.map((v) => (
        <line key={v} x1={padL} y1={toY(v)} x2={padL + chartW} y2={toY(v)} stroke="currentColor" strokeOpacity="0.1" strokeWidth="1" />
      ))}
      <line x1={padL} y1={toY(lowThreshold)} x2={padL + chartW} y2={toY(lowThreshold)} stroke="#f59e0b" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="4,3" />
      <line x1={padL} y1={toY(highThreshold)} x2={padL + chartW} y2={toY(highThreshold)} stroke="#ef4444" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="4,3" />
      <line x1={padL} y1={toY(targetAcwr)} x2={padL + chartW} y2={toY(targetAcwr)} stroke="#3b82f6" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="6,3" />
      {/* Axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" />
      <line x1={padL} y1={padT + chartH} x2={padL + chartW} y2={padT + chartH} stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" />
      {/* Y ticks */}
      {yTicks.map((v) => (
        <text key={v} x={padL - 6} y={toY(v) + 4} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.6">{v.toFixed(1)}</text>
      ))}
      {/* X ticks */}
      {tickIndices.map((i) => (
        <text key={i} x={toX(i)} y={padT + chartH + 14} textAnchor="middle" fontSize="9" fill="currentColor" opacity="0.6">
          {points[i].date.slice(5)}
        </text>
      ))}
      {/* ACWR line */}
      <polyline points={acwrLine} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Dots for each session */}
      {points.map((p, i) => (
        <circle key={i} cx={toX(i)} cy={toY(p.acwr)} r="3" fill="#6366f1" opacity="0.75" />
      ))}
      {/* Axis labels */}
      <text x={padL + chartW / 2} y={height - 4} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.7">Date</text>
      <text x={10} y={padT + chartH / 2} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.7"
        transform={`rotate(-90, 10, ${padT + chartH / 2})`}>ACWR</text>
      {/* Legend */}
      <line x1={padL + chartW - 110} y1={12} x2={padL + chartW - 95} y2={12} stroke="#6366f1" strokeWidth="2" />
      <text x={padL + chartW - 92} y={16} fontSize="9" fill="currentColor" opacity="0.7">ACWR</text>
      <line x1={padL + chartW - 60} y1={12} x2={padL + chartW - 45} y2={12} stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4,2" />
      <text x={padL + chartW - 42} y={16} fontSize="9" fill="currentColor" opacity="0.7">Target</text>
    </svg>
  );
}

interface NumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

function NumberInput({ value, onCommit, min, max, step }: NumberInputProps) {
  const [text, setText] = useState<string>(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commitValue() {
    if (text.trim() === "") {
      setText(String(value));
      return;
    }

    const parsed = Number(text);
    if (Number.isNaN(parsed)) {
      setText(String(value));
      return;
    }

    let next = parsed;
    if (typeof min === "number") {
      next = Math.max(min, next);
    }
    if (typeof max === "number") {
      next = Math.min(max, next);
    }

    onCommit(next);
    setText(String(next));
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commitValue}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commitValue();
        }

        if (event.key === "Escape") {
          setText(String(value));
        }
      }}
    />
  );
}

function App() {
  const [tab, setTab] = useState<TabName>(() => {
    const saved = localStorage.getItem("blm_tab");
    return (saved as TabName | null) ?? "session";
  });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState<SessionInput[]>([]);
  const [strengthTemplates, setStrengthTemplates] = useState<StrengthExerciseTemplate[]>([]);
  const [strengthSessions, setStrengthSessions] = useState<StrengthSession[]>([]);
  const [selectedStrengthTemplateId, setSelectedStrengthTemplateId] = useState<string | undefined>();
  const [amrapDraftByTemplateWeek, setAmrapDraftByTemplateWeek] = useState<Record<string, string>>({});
  const [editingStrengthSessionId, setEditingStrengthSessionId] = useState<string | undefined>();
  const [editingStrengthSessionCreatedAt, setEditingStrengthSessionCreatedAt] = useState<string | undefined>();
  const [editingStrengthExercises, setEditingStrengthExercises] = useState<StrengthSession["exercises"]>([]);
  const [ewmaSnapshots, setEwmaSnapshots] = useState<Record<string, EWMASnapshot>>({});
  const [draft, setDraft] = useState<SessionDraft>(createSessionDraft(DEFAULT_SETTINGS));
  const [editingSessionId, setEditingSessionId] = useState<string | undefined>();
  const [editingSessionCreatedAt, setEditingSessionCreatedAt] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [driveSession, setDriveSession] = useState<GoogleAuthSession | undefined>();
  const [googleProfile, setGoogleProfile] = useState<GoogleProfile | undefined>();
  const [driveStatus, setDriveStatus] = useState<string>("Google Drive not connected.");
  const [driveConnectError, setDriveConnectError] = useState<string | undefined>(undefined);
  const [driveLog, setDriveLog] = useState<string[]>([]);
  // Dashboard history graph
  const [historyRange, setHistoryRange] = useState<30 | 90 | null>(30);
  // Next-session planner
  const [plannerGrade, setPlannerGrade] = useState<Grade>("V5");
  const [plannerCount, setPlannerCount] = useState<number>(20);
  const [plannerDuration, setPlannerDuration] = useState<number>(120);

  const [plannerSleep, setPlannerSleep] = useState<number>(8);
  const [plannerStress, setPlannerStress] = useState<number>(5);

  function setTabAndPersist(t: TabName): void {
    localStorage.setItem("blm_tab", t);
    setTab(t);
  }

  function addDriveLog(msg: string): void {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log("[Drive]", msg);
    setDriveLog((prev) => [...prev.slice(-19), entry]);
  }

  const [entryCount, setEntryCount] = useState(1);
  const [entryGrade, setEntryGrade] = useState<Grade>("V4");
  const [entryHold, setEntryHold] = useState<HoldType>("mixed");
  const [entryAngle, setEntryAngle] = useState<WallAngle>("vert");
  const [entryDate, setEntryDate] = useState<string>(todayIsoDate());
  const [strengthWeek, setStrengthWeek] = useState<FiveThreeOneWeek>(1);
  const [strengthDate, setStrengthDate] = useState<string>(todayIsoDate());
  const [strengthNotes, setStrengthNotes] = useState<string>("");
  const [templateName, setTemplateName] = useState<string>("");
  const [templateOneRepMax, setTemplateOneRepMax] = useState<number>(22.5);
  const [templateIncrement, setTemplateIncrement] = useState<number>(2.5);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  function storeDriveSession(session: GoogleAuthSession | undefined): void {
    if (!session) {
      localStorage.removeItem(GOOGLE_SESSION_STORAGE_KEY);
      return;
    }

    localStorage.setItem(GOOGLE_SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  function readStoredDriveSession(): GoogleAuthSession | undefined {
    const raw = localStorage.getItem(GOOGLE_SESSION_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as GoogleAuthSession;
      if (!parsed.accessToken || !parsed.expiresAt) {
        return undefined;
      }

      if (Date.now() > parsed.expiresAt - 15_000) {
        return undefined;
      }

      return parsed;
    } catch {
      return undefined;
    }
  }

  const totalProblems = useMemo(
    () => draft.problems.reduce((sum, problem) => sum + problem.count, 0),
    [draft.problems],
  );

  const estimatedLoad = useMemo(() => {
    if (draft.problems.length === 0) {
      return undefined;
    }

    return calculateSessionLoad(
      {
        id: "draft",
        createdAt: new Date().toISOString(),
        durationMinutes: draft.durationMinutes,
        sleepHours: draft.sleepHours,
        stress: draft.stress,
        motivation: draft.motivation,
        problems: draft.problems,
      },
      settings,
    );
  }, [draft, settings]);

  const capacityRange = useMemo(
    () => suggestedCapacityRange(settings.climberMaxGrade),
    [settings.climberMaxGrade],
  );

  const acwrRows = useMemo(() => {
    const acuteWindow = settings.model.acwr.acuteWindow;
    const chronicWindow = settings.model.acwr.chronicWindow;

    return Object.values(ewmaSnapshots)
      .map((snapshot) => {
        const acute = getEwmaValue(snapshot, acuteWindow);
        const chronic = getEwmaValue(snapshot, chronicWindow);
        const acwr = chronic <= 0 ? 0 : acute / chronic;

        return {
          key: snapshot.key,
          acute,
          chronic,
          acwr,
          zone: getAcwrZone(acwr, settings.model.acwr.lowThreshold, settings.model.acwr.highThreshold),
        };
      })
      .sort((a, b) => b.acwr - a.acwr);
  }, [ewmaSnapshots, settings.model.acwr]);

  const acwrSummary = useMemo(() => {
    if (acwrRows.length === 0) {
      return { avgAcwr: 0, highRiskCount: 0, goldilocksCount: 0 };
    }

    const avgAcwr = acwrRows.reduce((sum, row) => sum + row.acwr, 0) / acwrRows.length;
    const highRiskCount = acwrRows.filter((row) => row.zone === "High Risk").length;
    const goldilocksCount = acwrRows.filter((row) => row.zone === "Goldilocks").length;

    return { avgAcwr, highRiskCount, goldilocksCount };
  }, [acwrRows]);

  // Overall ACWR: sum all acute / sum all chronic across every boulder type snapshot
  const overallAcwr = useMemo(() => {
    const snapshots = Object.values(ewmaSnapshots);
    if (snapshots.length === 0) return null;
    const sumAcute = snapshots.reduce((s, snap) => s + getEwmaValue(snap, settings.model.acwr.acuteWindow), 0);
    const sumChronic = snapshots.reduce((s, snap) => s + getEwmaValue(snap, settings.model.acwr.chronicWindow), 0);
    return sumChronic > 0 ? sumAcute / sumChronic : null;
  }, [ewmaSnapshots, settings.model.acwr]);

  // Session history for ACWR+Load graph (combined across all types)
  const sessionHistory = useMemo(
    () => buildSessionHistory(sessions, settings, historyRange),
    [sessions, settings, historyRange],
  );

  // Planner: calculate predicted ACWR from manual inputs
  const plannerPrediction = useMemo(() => {
    const snapshots = Object.values(ewmaSnapshots);
    if (snapshots.length === 0) return null;
    const prevAcute = snapshots.reduce((s, snap) => s + getEwmaValue(snap, settings.model.acwr.acuteWindow), 0);
    const prevChronic = snapshots.reduce((s, snap) => s + getEwmaValue(snap, settings.model.acwr.chronicWindow), 0);
    if (prevChronic === 0) return null;

    const acuteWindow = settings.model.acwr.acuteWindow;
    const actualLoad = estimateSimpleLoad(plannerCount, plannerDuration, plannerGrade, plannerSleep, plannerStress, settings);
    const newAcute = (2 / (acuteWindow + 1)) * actualLoad + (1 - 2 / (acuteWindow + 1)) * prevAcute;
    const predAcwr = prevChronic > 0 ? newAcute / prevChronic : 0;
    return { predAcwr, actualLoad };
  }, [ewmaSnapshots, settings, plannerSleep, plannerStress, plannerGrade, plannerCount, plannerDuration]);

  const acwrExample = useMemo(() => {
    const dummyProblems = 24;
    const dummyDuration = 120;
    const dummySleep = 7.5;
    const dummyStress = 5;
    const prevAcuteEwma = 95;
    const prevChronicEwma = 110;

    const acuteWindow = settings.model.acwr.acuteWindow;
    const chronicWindow = settings.model.acwr.chronicWindow;
    const acuteAlpha = 2 / (acuteWindow + 1);
    const chronicAlpha = 2 / (chronicWindow + 1);

    const baselineGrade = calculateGradeIntensity("V6", settings);
    const baselineSpeed = calculateSpeedMultiplier(dummyProblems, dummyDuration, settings);
    const baselineRecovery = calculateSleepRecoveryMultiplier(dummySleep, settings);
    const baselineStress = calculateStressMultiplier(dummyStress, settings);
    const baselineLoad = dummyProblems * baselineGrade * baselineSpeed * baselineRecovery * baselineStress;
    const nextAcuteEwma = acuteAlpha * baselineLoad + (1 - acuteAlpha) * prevAcuteEwma;
    const nextChronicEwma = chronicAlpha * baselineLoad + (1 - chronicAlpha) * prevChronicEwma;
    const nextAcwr = nextChronicEwma <= 0 ? 0 : nextAcuteEwma / nextChronicEwma;

    function projectAcwr(newLoad: number): number {
      const acute = acuteAlpha * newLoad + (1 - acuteAlpha) * prevAcuteEwma;
      const chronic = chronicAlpha * newLoad + (1 - chronicAlpha) * prevChronicEwma;
      return chronic <= 0 ? 0 : acute / chronic;
    }

    const hardGradeLoad =
      dummyProblems *
      calculateGradeIntensity("V9", settings) *
      baselineSpeed *
      baselineRecovery *
      baselineStress;

    const fasterPaceLoad =
      dummyProblems *
      baselineGrade *
      calculateSpeedMultiplier(dummyProblems, 75, settings) *
      baselineRecovery *
      baselineStress;

    const poorSleepLoad =
      dummyProblems *
      baselineGrade *
      baselineSpeed *
      calculateSleepRecoveryMultiplier(6.0, settings) *
      baselineStress;

    return {
      dummyProblems,
      dummyDuration,
      dummySleep,
      prevAcuteEwma,
      prevChronicEwma,
      acuteWindow,
      chronicWindow,
      acuteAlpha,
      chronicAlpha,
      baselineGrade,
      baselineSpeed,
      baselineRecovery,
      baselineLoad,
      nextAcuteEwma,
      nextChronicEwma,
      nextAcwr,
      hardGradeLoad,
      fasterPaceLoad,
      poorSleepLoad,
      hardGradeAcwr: projectAcwr(hardGradeLoad),
      fasterPaceAcwr: projectAcwr(fasterPaceLoad),
      poorSleepAcwr: projectAcwr(poorSleepLoad),
    };
  }, [settings]);

  const gradeCurvePoints = useMemo(
    () =>
      GRADES.map((grade) => ({
        x: gradeToNumber(grade),
        y: calculateGradeIntensity(grade, settings),
      })),
    [settings],
  );

  const speedCurvePoints = useMemo(
    () =>
      Array.from({ length: 16 }, (_, index) => {
        const problemsPerHour = 8 + index * 4;
        return {
          x: problemsPerHour,
          y: calculateSpeedMultiplier(problemsPerHour, 60, settings),
        };
      }),
    [settings],
  );

  const sleepPenaltyCurvePoints = useMemo(() => {
    const maxSleep = settings.model.recovery.personalMaxSleepHours;

    return Array.from({ length: 16 }, (_, index) => {
      const deficit = index * 0.03;
      const actualSleep = maxSleep * (1 - deficit);
      const recovery = calculateSleepRecoveryMultiplier(actualSleep, settings);
      return {
        x: deficit * 100,
        y: (1 - recovery) * 100,
      };
    });
  }, [settings]);

  const stressPenaltyCurvePoints = useMemo(() => {
    return Array.from({ length: 11 }, (_, index) => {
      const stress = index;
      const multiplier = calculateStressMultiplier(stress, settings);
      return {
        x: stress * 10,
        y: (multiplier - 1) * 100,
      };
    });
  }, [settings]);

  const displayGradeLabel = (grade: Grade): string => gradeToDisplay(grade, settings.gradeDisplayUnit);
  const gradeFromNumber = (value: number): Grade => {
    const bounded = Math.min(17, Math.max(0, Math.round(value)));
    return `V${bounded}` as Grade;
  };

  useEffect(() => {
    async function bootstrap() {
      const [savedSettings, savedSessions, savedSnapshots, savedTemplates, savedStrengthSessions] = await Promise.all([
        loadSettings(),
        loadSessions(),
        loadEwmaSnapshots(),
        loadStrengthTemplates(),
        loadStrengthSessions(),
      ]);

      const nextSettings = clampSettings(savedSettings ?? DEFAULT_SETTINGS);
      setSettings(nextSettings);
      setDraft(createSessionDraft(nextSettings));
      setSessions(savedSessions);

      const mapped = savedSnapshots.reduce<Record<string, EWMASnapshot>>((acc, snapshot) => {
        acc[snapshot.key] = snapshot;
        return acc;
      }, {});
      setEwmaSnapshots(mapped);

      if (savedTemplates.length === 0) {
        await saveStrengthTemplate(DEFAULT_STRENGTH_TEMPLATE);
        setStrengthTemplates([DEFAULT_STRENGTH_TEMPLATE]);
      } else {
        setStrengthTemplates(savedTemplates);
      }

      setStrengthSessions(savedStrengthSessions);

      // Check if Google redirected back with a code (or error) in the URL query.
      let redirectSession: GoogleAuthSession | null = null;
      try {
        const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
        if (clientId) {
          redirectSession = await extractOAuthTokenFromUrl(clientId);
        }
      } catch (oauthErr) {
        const msg = oauthErr instanceof Error ? oauthErr.message : String(oauthErr);
        addDriveLog(`OAuth error on return: ${msg}`);
        setDriveConnectError(msg);
      }
      if (redirectSession) {
        try {
          addDriveLog("OAuth redirect detected. Fetching profile…");
          const profile = await fetchGoogleProfile(redirectSession.accessToken);
          addDriveLog(`Profile OK: ${profile.email}`);
          setDriveSession(redirectSession);
          setGoogleProfile(profile);
          storeDriveSession(redirectSession);
          if (savedSessions.length === 0) {
            setDriveStatus(`Signed in as ${profile.email}. Restoring backup…`);
            addDriveLog("No local data — restoring from Drive…");
            await applyDriveBackup(redirectSession.accessToken);
            addDriveLog("Restore complete.");
            setDriveStatus(`Backup restored. Signed in as ${profile.email}.`);
          } else {
            setDriveStatus(`Google Drive connected as ${profile.email}.`);
          }
        } catch (err) {
          addDriveLog(`Redirect sign-in error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        const existingDriveSession = readStoredDriveSession();
        if (existingDriveSession) {
          try {
            const profile = await fetchGoogleProfile(existingDriveSession.accessToken);
            setDriveSession(existingDriveSession);
            setGoogleProfile(profile);
            if (savedSessions.length === 0) {
              setDriveStatus(`Signed in as ${profile.email}. Restoring backup…`);
              await applyDriveBackup(existingDriveSession.accessToken);
              setDriveStatus(`Backup restored. Signed in as ${profile.email}.`);
            } else {
              setDriveStatus(`Google Drive connected as ${profile.email}.`);
            }
          } catch {
            storeDriveSession(undefined);
          }
        }
      }

      setLoading(false);
    }

    void bootstrap();
  }, []);

  useEffect(() => {
    if (loading) {
      return;
    }

    void saveSettings(settings);
  }, [settings, loading]);

  function addProblem(): void {
    setDraft((previous) => ({
      ...previous,
      problems: [
        ...previous.problems,
        {
          id: getId(),
          count: Math.max(1, Math.min(100, entryCount)),
          grade: entryGrade,
          holdType: entryHold,
          wallAngle: entryAngle,
          climbedOn: entryDate,
        },
      ],
    }));
  }

  function removeProblem(problemId: string): void {
    setDraft((previous) => ({
      ...previous,
      problems: previous.problems.filter((problem) => problem.id !== problemId),
    }));
  }

  function patchSettings(update: (draftValue: AppSettings) => void): void {
    setSettings((previous) => {
      const next = structuredClone(previous);
      update(next);
      return clampSettings(next);
    });
  }

  async function addStrengthTemplate(): Promise<void> {
    const name = templateName.trim();
    if (!name) {
      return;
    }

    const template: StrengthExerciseTemplate = {
      id: getId(),
      name,
      oneRepMaxKg: Math.max(1, templateOneRepMax),
      trainingMaxKg: roundToIncrement(Math.max(1, templateOneRepMax) * 0.9, Math.max(0.5, templateIncrement)),
      incrementKg: Math.max(0.5, templateIncrement),
    };

    await saveStrengthTemplate(template);
    setStrengthTemplates((previous) => [...previous, template].sort((a, b) => a.name.localeCompare(b.name)));
    setTemplateName("");
  }

  async function removeStrengthTemplate(templateId: string): Promise<void> {
    await deleteStrengthTemplate(templateId);
    setStrengthTemplates((previous) => previous.filter((item) => item.id !== templateId));
  }

  async function advanceCycle(templateId: string): Promise<void> {
    const template = strengthTemplates.find((t) => t.id === templateId);
    if (!template) return;
    const currentCycle = template.cycleNumber ?? 1;
    const currentOneRepMax = template.oneRepMaxKg ?? template.trainingMaxKg / 0.9;
    const newOneRepMax = currentOneRepMax + template.incrementKg;
    const updated: StrengthExerciseTemplate = {
      ...template,
      cycleNumber: currentCycle + 1,
      cycleHistory: [...(template.cycleHistory ?? []), { cycle: currentCycle, oneRepMaxKg: currentOneRepMax }],
      oneRepMaxKg: newOneRepMax,
      trainingMaxKg: newOneRepMax * 0.9,
    };
    await saveStrengthTemplate(updated);
    setStrengthTemplates((prev) => prev.map((t) => (t.id === templateId ? updated : t)));
  }

  function getTemplateWeekKey(templateId: string, week: FiveThreeOneWeek): string {
    return `${templateId}-${week}`;
  }

  async function saveAmrapPerformed(templateId: string, week: FiveThreeOneWeek): Promise<void> {
    const key = getTemplateWeekKey(templateId, week);
    const rawValue = amrapDraftByTemplateWeek[key] ?? "";
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed) || parsed < 0) {
      return;
    }

    const reps = Math.round(parsed);

    const targetTemplate = strengthTemplates.find((item) => item.id === templateId);
    if (!targetTemplate) {
      return;
    }

    const updatedTemplate: StrengthExerciseTemplate = {
      ...targetTemplate,
      amrapPerformedByWeek: {
        ...(targetTemplate.amrapPerformedByWeek ?? {}),
        [week]: reps,
      },
    };

    await saveStrengthTemplate(updatedTemplate);
    setStrengthTemplates((previous) =>
      previous.map((item) => (item.id === templateId ? updatedTemplate : item)).sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAmrapDraftByTemplateWeek((previous) => ({
      ...previous,
      [key]: String(reps),
    }));
  }

  async function saveStrengthProtocolSession(): Promise<void> {
    if (strengthTemplates.length === 0 && !editingStrengthSessionId) {
      return;
    }

    const exercises = editingStrengthSessionId
      ? editingStrengthExercises
      : strengthTemplates.map((template) => ({
          templateId: template.id,
          name: template.name,
          trainingMaxKg: getTemplateTrainingMax(template),
          sets: build531Sets(getTemplateTrainingMax(template), template.incrementKg, strengthWeek),
        }));

    const session: StrengthSession = {
      id: editingStrengthSessionId ?? getId(),
      createdAt: editingStrengthSessionCreatedAt ?? new Date().toISOString(),
      sessionDate: strengthDate,
      week: strengthWeek,
      exercises,
      notes: strengthNotes.trim() || undefined,
      cycleNumber: strengthTemplates[0]?.cycleNumber ?? 1,
    };

    await saveStrengthSession(session);
    setStrengthSessions((previous) => {
      const updated = editingStrengthSessionId
        ? previous.map((item) => (item.id === session.id ? session : item))
        : [session, ...previous];
      return updated.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });
    setStrengthNotes("");
    setEditingStrengthSessionId(undefined);
    setEditingStrengthSessionCreatedAt(undefined);
    setEditingStrengthExercises([]);
  }

  function beginEditStrengthSession(session: StrengthSession): void {
    setEditingStrengthSessionId(session.id);
    setEditingStrengthSessionCreatedAt(session.createdAt);
    setEditingStrengthExercises(session.exercises.map((exercise) => ({ ...exercise, sets: exercise.sets.map((set) => ({ ...set })) })));
    setStrengthDate(session.sessionDate);
    setStrengthWeek(session.week);
    setStrengthNotes(session.notes ?? "");
    setTabAndPersist("strength");
  }

  function cancelEditStrengthSession(): void {
    setEditingStrengthSessionId(undefined);
    setEditingStrengthSessionCreatedAt(undefined);
    setEditingStrengthExercises([]);
    setStrengthDate(todayIsoDate());
    setStrengthWeek(1);
    setStrengthNotes("");
  }

  function beginEditSession(session: SessionInput): void {
    setEditingSessionId(session.id);
    setEditingSessionCreatedAt(session.createdAt);
    setDraft({
      durationMinutes: session.durationMinutes,
      sleepHours: session.sleepHours,
      stress: session.stress,
      motivation: session.motivation,
      problems: session.problems.map((problem) => ({ ...problem })),
    });
    setEntryDate(session.problems[0]?.climbedOn ?? todayIsoDate());
    setTabAndPersist("session");
  }

  function cancelEditSession(): void {
    setEditingSessionId(undefined);
    setEditingSessionCreatedAt(undefined);
    setDraft(createSessionDraft(settings));
  }

  async function recomputeAndPersistSnapshots(
    sessionsToReplay: SessionInput[],
    settingsForCalc: AppSettings,
  ): Promise<Record<string, EWMASnapshot>> {
    await clearEwmaSnapshots();
    const ordered = [...sessionsToReplay].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    // Bootstrap: seed EWMA with session average when fewer sessions than longest window
    const maxWindow = Math.max(...settingsForCalc.model.ewmaWindows);
    const sumByKey: Record<string, number> = {};
    const countByKey: Record<string, number> = {};
    for (const sessionItem of ordered) {
      const sessionCalc = calculateSessionLoad(sessionItem, settingsForCalc);
      for (const entry of sessionCalc.byBoulderType) {
        sumByKey[entry.key] = (sumByKey[entry.key] ?? 0) + entry.adjustedLoad;
        countByKey[entry.key] = (countByKey[entry.key] ?? 0) + 1;
      }
    }

    const nextSnapshots: Record<string, EWMASnapshot> = {};

    if (ordered.length < maxWindow && ordered.length > 0) {
      for (const key of Object.keys(sumByKey)) {
        const avg = sumByKey[key] / countByKey[key];
        nextSnapshots[key] = {
          key,
          ewma10: avg,
          ewma15: avg,
          ewma20: avg,
          ewma25: avg,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    for (const sessionItem of ordered) {
      const sessionCalc = calculateSessionLoad(sessionItem, settingsForCalc);
      for (const entry of sessionCalc.byBoulderType) {
        const updated = updateSnapshot(
          nextSnapshots[entry.key],
          entry.key,
          entry.adjustedLoad,
          settingsForCalc.model.ewmaWindows,
        );
        nextSnapshots[entry.key] = updated;
      }
    }

    await Promise.all(Object.values(nextSnapshots).map((snapshot) => saveEwmaSnapshot(snapshot)));
    return nextSnapshots;
  }

  function getBackupPayload(): DriveBackupPayload {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      sessions,
      ewmaSnapshots: Object.values(ewmaSnapshots),
      strengthTemplates,
      strengthSessions,
    };
  }

  function downloadBlob(content: string, filename: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportBackupAsJSON(): void {
    const payload = getBackupPayload();
    const json = JSON.stringify(payload, null, 2);
    downloadBlob(json, `boulder-load-manager-backup-${new Date().toISOString().slice(0,10)}.json`, "application/json");
  }

  function exportBouldersToCSV(): void {
    const header = "sessionId,createdAt,durationMinutes,sleepHours,stress,motivation,problemId,count,grade,holdType,wallAngle,climbedOn";
    const rows: string[] = [header];
    for (const s of sessions) {
      if (s.problems.length === 0) {
        rows.push([s.id, s.createdAt, s.durationMinutes, s.sleepHours, s.stress, s.motivation, "", "", "", "", "", ""].join(","));
      } else {
        for (const p of s.problems) {
          rows.push([s.id, s.createdAt, s.durationMinutes, s.sleepHours, s.stress, s.motivation, p.id, p.count, p.grade, p.holdType, p.wallAngle, p.climbedOn ?? ""].join(","));
        }
      }
    }
    downloadBlob(rows.join("\n"), `bouldering-sessions-${new Date().toISOString().slice(0,10)}.csv`, "text/csv");
  }

  function exportStrengthToCSV(): void {
    const header = "sessionId,createdAt,sessionDate,week,cycleNumber,exerciseName,templateId,trainingMaxKg,setIndex,percentage,reps,targetWeightKg,amrapPerformed";
    const rows: string[] = [header];
    for (const s of strengthSessions) {
      const cycle = s.cycleNumber ?? 1;
      for (const ex of s.exercises) {
        ex.sets.forEach((set, idx) => {
          const amrap = (strengthTemplates.find((t) => t.id === ex.templateId)?.amrapPerformedByWeek?.[s.week]) ?? "";
          rows.push([s.id, s.createdAt, s.sessionDate, s.week, cycle, ex.name, ex.templateId, ex.trainingMaxKg, idx + 1, set.percentage, set.reps, set.targetWeightKg, idx === ex.sets.length - 1 ? amrap : ""].join(","));
        });
      }
    }
    downloadBlob(rows.join("\n"), `strength-sessions-${new Date().toISOString().slice(0,10)}.csv`, "text/csv");
  }

  async function importBackupFromJSON(file: File): Promise<void> {
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as DriveBackupPayload;
      
      await clearSessions();
      await clearEwmaSnapshots();
      await clearStrengthTemplates();
      await clearStrengthSessions();

      const restoredSettings = clampSettings(payload.settings ?? DEFAULT_SETTINGS);
      await saveSettings(restoredSettings);
      for (const s of payload.sessions) { await saveSession(s); }
      for (const snap of payload.ewmaSnapshots ?? []) { await saveEwmaSnapshot(snap); }
      for (const t of payload.strengthTemplates ?? [DEFAULT_STRENGTH_TEMPLATE]) { await saveStrengthTemplate(t); }
      for (const ss of payload.strengthSessions ?? []) { await saveStrengthSession(ss); }

      const [sessionsFromDb, snapshotsFromDb, templatesFromDb, strengthSessionsFromDb] = await Promise.all([
        loadSessions(), loadEwmaSnapshots(), loadStrengthTemplates(), loadStrengthSessions(),
      ]);
      const mappedSnapshots = snapshotsFromDb.reduce<Record<string, EWMASnapshot>>((acc, snap) => {
        acc[snap.key] = snap;
        return acc;
      }, {});

      setSettings(restoredSettings);
      setSessions(sessionsFromDb);
      setEwmaSnapshots(mappedSnapshots);
      setStrengthTemplates(templatesFromDb.length > 0 ? templatesFromDb : [DEFAULT_STRENGTH_TEMPLATE]);
      setStrengthSessions(strengthSessionsFromDb);
      setDraft(createSessionDraft(restoredSettings));
      addDriveLog("Backup imported successfully!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addDriveLog(`Error importing backup: ${msg}`);
    }
  }

  async function importBouldersFromCSV(file: File): Promise<void> {
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return;
    // Group by sessionId
    const sessionMap = new Map<string, SessionInput>();
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const [sid, createdAt, durationMinutes, sleepHours, stress, motivation, problemId, count, grade, holdType, wallAngle, climbedOn] = cols;
      if (!sid) continue;
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, { id: sid, createdAt, durationMinutes: Number(durationMinutes), sleepHours: Number(sleepHours), stress: Number(stress), motivation: Number(motivation), problems: [] });
      }
      if (problemId && grade) {
        sessionMap.get(sid)!.problems.push({ id: problemId, count: Number(count), grade: grade as Grade, holdType: holdType as HoldType, wallAngle: wallAngle as WallAngle, climbedOn: climbedOn || undefined });
      }
    }
    for (const session of sessionMap.values()) {
      await saveSession(session);
    }
    const updated = await loadSessions();
    setSessions(updated.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
  }

  async function importStrengthFromCSV(file: File): Promise<void> {
    const text = await file.text();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return;
    const sessionMap = new Map<string, StrengthSession>();
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const [sid, createdAt, sessionDate, week, cycleNumber, exerciseName, templateId, trainingMaxKg, setIndex, percentage, reps, targetWeightKg, amrapPerformed] = cols;
      if (!sid) continue;
      if (!sessionMap.has(sid)) {
        sessionMap.set(sid, { id: sid, createdAt, sessionDate, week: Number(week) as FiveThreeOneWeek, cycleNumber: Number(cycleNumber) || 1, exercises: [], notes: undefined });
      }
      const sess = sessionMap.get(sid)!;
      let ex = sess.exercises.find((e) => e.templateId === templateId);
      if (!ex) {
        ex = { templateId, name: exerciseName, trainingMaxKg: Number(trainingMaxKg), sets: [] };
        sess.exercises.push(ex);
      }
      ex.sets[Number(setIndex) - 1] = { percentage: Number(percentage), reps, targetWeightKg: Number(targetWeightKg) };
      if (amrapPerformed && Number(setIndex) === ex.sets.length + 1) {
        // Will be added to amrap on template if needed
      }
    }
    for (const session of sessionMap.values()) {
      await saveStrengthSession(session);
    }
    const updated = await loadStrengthSessions();
    setStrengthSessions(updated);
  }

  async function applyDriveBackup(token: string): Promise<void> {
    try {
      const payload = await downloadBackupFromGoogleDrive(token);
      await clearSessions();
      await clearEwmaSnapshots();
      await clearStrengthTemplates();
      await clearStrengthSessions();

      const restoredSettings = clampSettings(payload.settings ?? DEFAULT_SETTINGS);
      await saveSettings(restoredSettings);
      for (const s of payload.sessions) { await saveSession(s); }
      for (const snap of payload.ewmaSnapshots ?? []) { await saveEwmaSnapshot(snap); }
      for (const t of payload.strengthTemplates ?? [DEFAULT_STRENGTH_TEMPLATE]) { await saveStrengthTemplate(t); }
      for (const ss of payload.strengthSessions ?? []) { await saveStrengthSession(ss); }

      const [sessionsFromDb, snapshotsFromDb, templatesFromDb, strengthSessionsFromDb] = await Promise.all([
        loadSessions(), loadEwmaSnapshots(), loadStrengthTemplates(), loadStrengthSessions(),
      ]);
      const mappedSnapshots = snapshotsFromDb.reduce<Record<string, EWMASnapshot>>((acc, snap) => {
        acc[snap.key] = snap;
        return acc;
      }, {});

      setSettings(restoredSettings);
      setSessions(sessionsFromDb);
      setEwmaSnapshots(mappedSnapshots);
      setStrengthTemplates(templatesFromDb.length > 0 ? templatesFromDb : [DEFAULT_STRENGTH_TEMPLATE]);
      setStrengthSessions(strengthSessionsFromDb);
      setDraft(createSessionDraft(restoredSettings));
    } catch {
      // No backup file yet — that's fine, just continue with local data.
    }
  }

  async function connectGoogleDrive(): Promise<void> {
    if (!googleClientId) {
      setDriveConnectError("Missing VITE_GOOGLE_CLIENT_ID. Configure it in Vercel and .env.local.");
      return;
    }
    // Navigate immediately — no state update before redirect to avoid blocking navigation
    await initiateGoogleOAuthRedirect(googleClientId);
  }

  function disconnectGoogleDrive(): void {
    setDriveSession(undefined);
    setGoogleProfile(undefined);
    storeDriveSession(undefined);
    setDriveStatus("Google Drive disconnected.");
  }

  function ensureDriveAccessToken(): string | undefined {
    if (driveSession && Date.now() < driveSession.expiresAt - 15_000) {
      return driveSession.accessToken;
    }
    return undefined;
  }


  async function handleDriveUpload(): Promise<void> {
    const token = ensureDriveAccessToken();
    if (!token) {
      setDriveStatus("Token expired — please sign in again.");
      return;
    }

    try {
      await uploadBackupToGoogleDrive(token, getBackupPayload());
      setDriveStatus("Backup uploaded to Google Drive.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setDriveStatus(message);
    }
  }

  async function handleDriveRestore(): Promise<void> {
    const token = ensureDriveAccessToken();
    if (!token) {
      setDriveStatus("Token expired — please sign in again.");
      return;
    }

    try {
      await applyDriveBackup(token);
      setDriveStatus("Backup restored from Google Drive.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore failed.";
      setDriveStatus(message);
    }
  }

  async function saveCurrentSession(): Promise<void> {
    if (draft.problems.length === 0) {
      return;
    }

    const isEditing = Boolean(editingSessionId);

    const session: SessionInput = {
      id: editingSessionId ?? getId(),
      createdAt: editingSessionCreatedAt ?? new Date().toISOString(),
      durationMinutes: draft.durationMinutes,
      sleepHours: draft.sleepHours,
      stress: draft.stress,
      motivation: draft.motivation,
      problems: draft.problems,
    };

    const highestLoggedGrade = session.problems.reduce((max, item) => {
      const score = gradeToNumber(item.grade);
      return Math.max(max, score);
    }, gradeToNumber(settings.climberMaxGrade));

    let nextSettings = settings;
    if (highestLoggedGrade > gradeToNumber(settings.climberMaxGrade)) {
      const upgraded = `V${highestLoggedGrade}` as Grade;
      nextSettings = clampSettings({ ...settings, climberMaxGrade: upgraded });
      setSettings(nextSettings);
      await saveSettings(nextSettings);
    }

    const updatedSessions = isEditing
      ? sessions.map((item) => (item.id === session.id ? session : item))
      : [session, ...sessions];

    await saveSession(session);
    const recalculatedSnapshots = await recomputeAndPersistSnapshots(updatedSessions, nextSettings);

    setEwmaSnapshots(recalculatedSnapshots);
    setSessions(updatedSessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    setDraft(createSessionDraft(nextSettings));
    setEditingSessionId(undefined);
    setEditingSessionCreatedAt(undefined);
    setTabAndPersist("dashboard");
  }

  if (loading) {
    return (
      <main className="app-shell">
        <p>Loading boulder tracker...</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="hero-header">
        <div className="hero-top-row">
          {googleProfile ? (
            <div className="profile-chip">
              {googleProfile.picture ? (
                <img src={googleProfile.picture} alt={googleProfile.name} className="profile-avatar" referrerPolicy="no-referrer" crossOrigin="anonymous" />
              ) : (
                <div className="profile-avatar-fallback">{googleProfile.name.slice(0, 1).toUpperCase()}</div>
              )}
              <div>
                <p className="profile-name">{googleProfile.name}</p>
                <p className="profile-email">{googleProfile.email}</p>
              </div>
              <button type="button" onClick={disconnectGoogleDrive}>Sign out</button>
            </div>
          ) : (
            <div className="connect-top-col">
              <button type="button" className="connect-top-btn" onClick={() => { setDriveConnectError(undefined); connectGoogleDrive(); }}>
                Sign in with Google
              </button>
              {driveConnectError && (
                <>
                  <p className="drive-connect-error">{driveConnectError}</p>
                  <p className="drive-connect-hint">⚠️ If Google shows "This app isn't verified", click <strong>Advanced</strong> → <strong>Go to boulder-load-manager.vercel.app</strong> to continue.</p>
                </>
              )}
            </div>
          )}
        </div>
        <div>
          <p className="eyebrow">Boulder Load Manager</p>
          <h1>ACWR + EWMA Load Tracking</h1>
          <p>
            Capacity range suggestion for max {displayGradeLabel(settings.climberMaxGrade)}: {" "}
            {displayGradeLabel(gradeFromNumber(capacityRange.min))} to {" "}
            {displayGradeLabel(gradeFromNumber(capacityRange.max))}
          </p>
        </div>
        <div className="hero-stats">
          <article>
            <span>Total Sessions</span>
            <strong>{sessions.length}</strong>
          </article>
          <article>
            <span>Current Draft</span>
            <strong>{totalProblems} problems</strong>
          </article>
          <article>
            <span>Avg ACWR</span>
            <strong>{acwrSummary.avgAcwr.toFixed(2)}</strong>
          </article>
        </div>
      </header>

      <nav className="tab-nav" aria-label="Main tabs">
        <button type="button" onClick={() => setTabAndPersist("session")} className={tab === "session" ? "active" : ""}>
          Session
        </button>
        <button
          type="button"
          onClick={() => setTabAndPersist("dashboard")}
          className={tab === "dashboard" ? "active" : ""}
        >
          Dashboard
        </button>
        <button type="button" onClick={() => setTabAndPersist("strength")} className={tab === "strength" ? "active" : ""}>
          Strength
        </button>
        <button type="button" onClick={() => setTabAndPersist("settings")} className={tab === "settings" ? "active" : ""}>
          Settings
        </button>
        <button type="button" onClick={() => setTabAndPersist("history")} className={tab === "history" ? "active" : ""}>
          History
        </button>
      </nav>

      {tab === "session" && (
        <section className="panel-grid">
          <article className="panel">
            <h2>Quick Problem Entry</h2>
            <div className="field-grid">
              <label>
                Date
                <input
                  type="date"
                  value={entryDate}
                  onChange={(event) => setEntryDate(event.target.value)}
                />
              </label>
              <label>
                Problems (1-100)
                <NumberInput
                  value={entryCount}
                  min={1}
                  max={100}
                  step={1}
                  onCommit={(value) => setEntryCount(Math.round(value))}
                />
              </label>
              <label>
                Grade
                <select value={entryGrade} onChange={(event) => setEntryGrade(event.target.value as Grade)}>
                  {GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {displayGradeLabel(grade)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Hold type
                <select value={entryHold} onChange={(event) => setEntryHold(event.target.value as HoldType)}>
                  {HOLD_TYPES.map((holdType) => (
                    <option key={holdType} value={holdType}>
                      {holdType}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Wall angle
                <select value={entryAngle} onChange={(event) => setEntryAngle(event.target.value as WallAngle)}>
                  {WALL_ANGLES.map((angle) => (
                    <option key={angle} value={angle}>
                      {angle}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button type="button" onClick={addProblem}>Save To Session</button>
          </article>

          <article className="panel">
            <h2>Session Context</h2>
            {editingSessionId && (
              <p>
                Editing existing session. Save will update the same history entry and recalculate ACWR/EWMA.
              </p>
            )}
            <div className="field-grid">
              <label>
                Duration (minutes)
                <NumberInput
                  value={draft.durationMinutes}
                  min={10}
                  step={1}
                  onCommit={(value) =>
                    setDraft((previous) => ({ ...previous, durationMinutes: Math.round(value) }))
                  }
                />
              </label>
              <label>
                Sleep before session (hours)
                <NumberInput
                  value={draft.sleepHours}
                  min={0}
                  max={12}
                  step={0.25}
                  onCommit={(value) => setDraft((previous) => ({ ...previous, sleepHours: value }))}
                />
              </label>
              <label>
                Stress ({settings.stressScaleMax} max)
                <select
                  value={draft.stress}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft((previous) => ({ ...previous, stress: value }));
                  }}
                >
                  {Array.from({ length: settings.stressScaleMax }, (_, index) => index + 1).map((value) => (
                    <option key={`stress-${value}`} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Motivation ({settings.motivationScaleMax} max)
                <select
                  value={draft.motivation}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft((previous) => ({ ...previous, motivation: value }));
                  }}
                >
                  {Array.from({ length: settings.motivationScaleMax }, (_, index) => index + 1).map((value) => (
                    <option key={`motivation-${value}`} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {estimatedLoad && (
              <div className="metric-row">
                <span>
                  Estimated load: <strong>{estimatedLoad.totalLoad.toFixed(2)}</strong>
                </span>
                <span>Speed x {estimatedLoad.speedMultiplier.toFixed(2)}</span>
                <span>Recovery x {estimatedLoad.recoveryMultiplier.toFixed(2)}</span>
              </div>
            )}

            <div className="metric-row">
              <button type="button" onClick={() => void saveCurrentSession()} disabled={draft.problems.length === 0}>
                {editingSessionId ? "Update Session And Recalculate" : "Save Session And Update EWMA"}
              </button>
              {editingSessionId && (
                <button type="button" onClick={cancelEditSession}>
                  Cancel Edit
                </button>
              )}
            </div>
          </article>

          <article className="panel full-width">
            <h2>Problems In Current Session</h2>
            {draft.problems.length === 0 && <p>No problems logged yet.</p>}
            {draft.problems.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Count</th>
                    <th>Grade</th>
                    <th>Hold</th>
                    <th>Angle</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.problems.map((problem) => (
                    <tr key={problem.id}>
                      <td>{problem.climbedOn ?? todayIsoDate()}</td>
                      <td>{problem.count}</td>
                      <td>{displayGradeLabel(problem.grade)}</td>
                      <td>{problem.holdType}</td>
                      <td>{problem.wallAngle}</td>
                      <td>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => removeProblem(problem.id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </section>
      )}

      {tab === "dashboard" && (
        <section className="panel-grid">
          {/* Overall ACWR stat */}
          <article className="panel">
            <h2>Overall ACWR</h2>
            {overallAcwr === null ? (
              <p>Save a session to see your overall ACWR.</p>
            ) : (
              <div className="overall-acwr-stat">
                <span className={`acwr-big ${getAcwrZone(overallAcwr, settings.model.acwr.lowThreshold, settings.model.acwr.highThreshold).toLowerCase().replace(" ", "-")}`}>
                  {overallAcwr.toFixed(2)}
                </span>
                <span className="acwr-zone-label">{getAcwrZone(overallAcwr, settings.model.acwr.lowThreshold, settings.model.acwr.highThreshold)}</span>
                <p className="acwr-range-hint">Goldilocks: {settings.model.acwr.lowThreshold.toFixed(2)} – {settings.model.acwr.highThreshold.toFixed(2)} | Target: {settings.model.acwr.targetAcwr.toFixed(2)}</p>
              </div>
            )}
          </article>

          {/* ACWR + Load history graph */}
          <article className="panel full-width">
            <div className="panel-header-row">
              <h2>ACWR History</h2>
              <select className="range-select" value={historyRange ?? "all"} onChange={(e) => {
                const v = e.target.value;
                setHistoryRange(v === "all" ? null : (Number(v) as 30 | 90));
              }}>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
                <option value="all">All time</option>
              </select>
            </div>
            {sessionHistory.length < 2 ? (
              <p>Log at least 2 sessions to see the history graph.</p>
            ) : (
              <AcwrHistoryChart
                points={sessionHistory}
                lowThreshold={settings.model.acwr.lowThreshold}
                highThreshold={settings.model.acwr.highThreshold}
                targetAcwr={settings.model.acwr.targetAcwr}
              />
            )}
          </article>

          {/* Next-session planner */}
          <article className="panel full-width">
            <h2>Next Session Planner</h2>
            <p className="muted-hint">Enter your planned session details to see what ACWR you'll reach. Your ACWR target: <strong>{settings.model.acwr.targetAcwr.toFixed(2)}</strong>.</p>
            {plannerPrediction === null ? (
              <p>Log at least one session to enable the planner.</p>
            ) : (
              <>
                <div className="planner-inputs-row">
                  <label className="planner-input-label">
                    Sleep (h)
                    <NumberInput value={plannerSleep} min={0} max={14} step={0.5} onCommit={setPlannerSleep} />
                  </label>
                  <label className="planner-input-label">
                    Stress (1–{settings.stressScaleMax})
                    <NumberInput value={plannerStress} min={1} max={settings.stressScaleMax} step={1} onCommit={setPlannerStress} />
                  </label>
                </div>
                <div className="planner-grid">
                  <div className="planner-field">
                    <label>
                      Duration (min)
                    </label>
                    <NumberInput value={plannerDuration} min={5} max={600} step={5} onCommit={setPlannerDuration} />
                  </div>
                  <div className="planner-field">
                    <label>
                      Boulder count
                    </label>
                    <NumberInput value={plannerCount} min={1} max={150} step={1} onCommit={setPlannerCount} />
                  </div>
                  <div className="planner-field">
                    <label>
                      Avg grade
                    </label>
                    <select value={plannerGrade} onChange={(e) => setPlannerGrade(e.target.value as Grade)}>
                      {GRADES.map((g) => (
                        <option key={g} value={g}>{gradeToDisplay(g, settings.gradeDisplayUnit)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="planner-result">
                    <span className="planner-acwr-label">Predicted ACWR</span>
                    <span className={`planner-acwr-value ${getAcwrZone(plannerPrediction.predAcwr, settings.model.acwr.lowThreshold, settings.model.acwr.highThreshold).toLowerCase().replace(" ", "-")}`}>
                      {plannerPrediction.predAcwr.toFixed(2)}
                    </span>
                  </div>
                  <div className="planner-result">
                    <span className="planner-acwr-label">Estimated Load</span>
                    <span className="planner-acwr-value">
                      {plannerPrediction.actualLoad.toFixed(0)}
                    </span>
                  </div>
                </div>
                
              </>
            )}
          </article>

          <article className="panel full-width">
            <h2>ACWR by Boulder Type</h2>
            <p>
              Acute window: {settings.model.acwr.acuteWindow} | Chronic window: {settings.model.acwr.chronicWindow}
              {" "}| Goldilocks: {settings.model.acwr.lowThreshold.toFixed(2)} to {settings.model.acwr.highThreshold.toFixed(2)}
            </p>
            {sessions.length > 0 && sessions.length < Math.max(...settings.model.ewmaWindows) && (
              <p className="bootstrap-warning">
                ⚠ EWMA is still stabilising — using session average as seed ({sessions.length}/{Math.max(...settings.model.ewmaWindows)} sessions logged). Values will become more accurate as you log more sessions.
              </p>
            )}
            {acwrRows.length === 0 && <p>Save a session to generate ACWR values.</p>}
            {acwrRows.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Boulder type</th>
                    <th>Acute EWMA</th>
                    <th>Chronic EWMA</th>
                    <th>ACWR</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {acwrRows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.key.replace("__", " + ")}</td>
                        <td>{row.acute.toFixed(2)}</td>
                        <td>{row.chronic.toFixed(2)}</td>
                        <td>{row.acwr.toFixed(2)}</td>
                        <td>{row.zone}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </article>
        </section>
      )}

      {tab === "strength" && (
        <section className="panel-grid">
          <article className="panel">
            <h2>5/3/1 Planner</h2>
            <p>
              Standard 5/3/1 math: training max = 90% of true 1RM. Week presets: 1 (5s), 2 (3s), 3 (5/3/1), 4 (deload).
            </p>
            {editingStrengthSessionId && (
              <p>
                Editing strength session from history. Save will update that entry.
              </p>
            )}
            <div className="field-grid">
              <label>
                Week
                <select value={strengthWeek} onChange={(event) => setStrengthWeek(Number(event.target.value) as FiveThreeOneWeek)}>
                  <option value={1}>Week 1 - 5/5/5+</option>
                  <option value={2}>Week 2 - 3/3/3+</option>
                  <option value={3}>Week 3 - 5/3/1+</option>
                  <option value={4}>Week 4 - Deload</option>
                </select>
              </label>
              <label>
                Session date
                <input type="date" value={strengthDate} onChange={(event) => setStrengthDate(event.target.value)} />
              </label>
            </div>
            <label>
              Notes
              <input value={strengthNotes} onChange={(event) => setStrengthNotes(event.target.value)} placeholder="Optional notes for this strength day" />
            </label>
            <div className="metric-row">
              <button type="button" onClick={() => void saveStrengthProtocolSession()} disabled={strengthTemplates.length === 0 && !editingStrengthSessionId}>
                {editingStrengthSessionId ? "Update Strength Session" : "Save Strength Session"}
              </button>
              {editingStrengthSessionId && (
                <button type="button" onClick={cancelEditStrengthSession}>
                  Cancel Edit
                </button>
              )}
            </div>
          </article>

          <article className="panel">
            <h2>How 5/3/1 Works</h2>
            <p>
              5/3/1 was created by Jim Wendler as a simple long-term strength progression system built around submaximal work and steady progress.
            </p>
            <p>
              Step 1: set a conservative training max at 90% of true 1RM.
            </p>
            <p>
              Step 2: follow weekly waves (5s, 3s, 5/3/1, deload).
            </p>
            <p>
              Step 3: aim to beat minimum reps on the final + set while keeping form strict.
            </p>
            <p>
              Step 4: increase your training max next cycle and repeat.
            </p>
          </article>

          <article className="panel">
            <h2>Exercise Templates</h2>
            <p>
              Start with Weighted Pull-up by default, then add your own lifts.
            </p>
            <div className="field-grid">
              <label>
                Exercise name
                <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="e.g. Front Squat" />
              </label>
              <label>
                True 1RM (kg)
                <NumberInput value={templateOneRepMax} min={1} step={0.5} onCommit={setTemplateOneRepMax} />
              </label>
              <label>
                Plate increment (kg)
                <NumberInput value={templateIncrement} min={0.5} step={0.5} onCommit={setTemplateIncrement} />
              </label>
            </div>
            <button type="button" onClick={() => void addStrengthTemplate()}>
              Add Exercise
            </button>

            {strengthTemplates.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Exercise</th>
                    <th>Cycle</th>
                    <th>1RM</th>
                    <th>TM</th>
                    <th>Est. current 1RM</th>
                    <th>Increment</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {strengthTemplates.map((template) => {
                    const tm = getTemplateTrainingMax(template);
                    const estimatedCurrentOneRepMax = estimateOneRepMaxFromTopSet(tm, template.incrementKg, strengthWeek);
                    const cycle = template.cycleNumber ?? 1;
                    return (
                      <tr key={template.id}>
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedStrengthTemplateId((previous) =>
                                previous === template.id ? undefined : template.id,
                              );
                              setAmrapDraftByTemplateWeek((previous) => {
                                const next = { ...previous };
                                for (const weekValue of [1, 2, 3, 4] as FiveThreeOneWeek[]) {
                                  const key = getTemplateWeekKey(template.id, weekValue);
                                  if (next[key] === undefined) {
                                    const saved = template.amrapPerformedByWeek?.[weekValue];
                                    next[key] = typeof saved === "number" ? String(saved) : "";
                                  }
                                }
                                return next;
                              });
                            }}
                          >
                            {template.name}
                          </button>
                        </td>
                        <td>
                          <span className="cycle-badge">Cycle {cycle}</span>
                        </td>
                        <td>{(template.oneRepMaxKg ?? template.trainingMaxKg / 0.9).toFixed(1)} kg</td>
                        <td>{tm.toFixed(1)} kg</td>
                        <td>{estimatedCurrentOneRepMax.toFixed(1)} kg</td>
                        <td>{template.incrementKg.toFixed(1)} kg</td>
                        <td>
                          <button
                            type="button"
                            className="advance-cycle-btn"
                            title={`Start cycle ${cycle + 1}: 1RM → ${((template.oneRepMaxKg ?? template.trainingMaxKg / 0.9) + template.incrementKg).toFixed(1)} kg`}
                            onClick={() => {
                              if (window.confirm(`Advance ${template.name} to Cycle ${cycle + 1}?\n\n1RM: ${(template.oneRepMaxKg ?? template.trainingMaxKg / 0.9).toFixed(1)} kg → ${((template.oneRepMaxKg ?? template.trainingMaxKg / 0.9) + template.incrementKg).toFixed(1)} kg (+${template.incrementKg} kg)`)) {
                                void advanceCycle(template.id);
                              }
                            }}
                          >
                            ↑ Advance cycle
                          </button>
                          <button type="button" className="danger" onClick={() => void removeStrengthTemplate(template.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </article>

          <article className="panel full-width">
            <h2>Next 4 Weeks Plan</h2>
            {!selectedStrengthTemplateId && <p>Click an exercise name above to open its 2x2 four-week plan.</p>}
            {selectedStrengthTemplateId && (
              <div className="panel-grid">
                {[1, 2, 3, 4].map((week) => {
                  const template = strengthTemplates.find((item) => item.id === selectedStrengthTemplateId);
                  if (!template) {
                    return null;
                  }

                  const tm = getTemplateTrainingMax(template);
                  const weekTyped = week as FiveThreeOneWeek;
                  const sets = build531Sets(tm, template.incrementKg, weekTyped);
                  const topSet = sets[sets.length - 1];
                  const hasAmrapSet = topSet.reps.includes("+");
                  const draftKey = getTemplateWeekKey(template.id, weekTyped);
                  const amrapDraft = amrapDraftByTemplateWeek[draftKey] ?? "";

                  return (
                    <article key={`week-preview-${week}`} className="panel">
                      <div className="metric-row">
                        <h3>{template.name} - Week {week}</h3>
                        {hasAmrapSet && (
                          <button type="button" onClick={() => void saveAmrapPerformed(template.id, weekTyped)}>
                            Save
                          </button>
                        )}
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>Set</th>
                            <th>%</th>
                            <th>Reps</th>
                            <th>Target</th>
                            <th>Reps performed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sets.map((set, index) => (
                            <tr key={`week-${week}-set-${index}`}>
                              <td>{index + 1}</td>
                              <td>{Math.round(set.percentage * 100)}%</td>
                              <td>{set.reps}</td>
                              <td>{set.targetWeightKg.toFixed(1)} kg</td>
                              <td>
                                {index === sets.length - 1 && hasAmrapSet ? (
                                  <input
                                    type="number"
                                    min={0}
                                    value={amrapDraft}
                                    onChange={(event) =>
                                      setAmrapDraftByTemplateWeek((previous) => ({
                                        ...previous,
                                        [draftKey]: event.target.value,
                                      }))
                                    }
                                    placeholder="AMRAP reps"
                                  />
                                ) : (
                                  "-"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </article>
                  );
                })}
              </div>
            )}
          </article>
        </section>
      )}

      {tab === "settings" && (
        <section className="panel-grid">
          <article className="panel">
            <h2>Profile</h2>
            <div className="field-grid">
              <label>
                Max grade
                <select
                  value={settings.climberMaxGrade}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.climberMaxGrade = event.target.value as Grade;
                    })
                  }
                >
                  {GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {displayGradeLabel(grade)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Grade unit
                <select
                  value={settings.gradeDisplayUnit}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.gradeDisplayUnit = event.target.value as GradeDisplayUnit;
                    })
                  }
                >
                  <option value="v">V grade</option>
                  <option value="font">Font</option>
                </select>
              </label>
              <label>
                Stress scale max
                <NumberInput
                  value={settings.stressScaleMax}
                  min={3}
                  max={20}
                  step={1}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.stressScaleMax = Math.round(value);
                    })
                  }
                />
              </label>
              <label>
                Motivation scale max
                <NumberInput
                  value={settings.motivationScaleMax}
                  min={3}
                  max={20}
                  step={1}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.motivationScaleMax = Math.round(value);
                    })
                  }
                />
              </label>
            </div>
          </article>

          <article className="panel">
            <h2>Model Tuning</h2>
            <div className="field-grid">
              <label>
                Grade base points (V0)
                <NumberInput
                  value={settings.model.gradeIntensity.basePoints}
                  min={1}
                  max={100}
                  step={1}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.basePoints = value;
                    })
                  }
                />
              </label>
              <label>
                Grade multiplier per grade
                <NumberInput
                  value={settings.model.gradeIntensity.multiplierPerGrade}
                  min={1.01}
                  max={10}
                  step={0.05}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.multiplierPerGrade = value;
                    })
                  }
                />
              </label>
              <label>
                Speed model
                <input value="Fixed: 10 min = x0, 1 min = x5 (exponential)" readOnly />
              </label>
              <label>
                Sleep penalty exponent
                <NumberInput
                  value={settings.model.recovery.sleepPenalty.exponent}
                  min={0.1}
                  max={10}
                  step={0.1}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.recovery.sleepPenalty.exponent = value;
                    })
                  }
                />
              </label>
              <label>
                Max sleep penalty
                <NumberInput
                  value={settings.model.recovery.sleepPenalty.maxPenalty}
                  min={0}
                  max={1}
                  step={0.01}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.recovery.sleepPenalty.maxPenalty = value;
                    })
                  }
                />
              </label>
              <label>
                Stress threshold (0-10 scale)
                <NumberInput
                  value={settings.model.recovery.stressPenalty.threshold}
                  min={0}
                  max={10}
                  step={0.5}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.recovery.stressPenalty.threshold = value;
                    })
                  }
                />
              </label>
              <label>
                Stress penalty exponent
                <NumberInput
                  value={settings.model.recovery.stressPenalty.exponent}
                  min={0.1}
                  max={10}
                  step={0.1}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.recovery.stressPenalty.exponent = value;
                    })
                  }
                />
              </label>
              <label>
                Max stress penalty
                <NumberInput
                  value={settings.model.recovery.stressPenalty.maxPenalty}
                  min={0}
                  max={1}
                  step={0.01}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.recovery.stressPenalty.maxPenalty = value;
                    })
                  }
                />
              </label>
              <label>
                ACWR acute window
                <select
                  value={settings.model.acwr.acuteWindow}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.acwr.acuteWindow = Number(event.target.value) as EWMADays;
                    })
                  }
                >
                  {[10, 15, 20, 25].map((windowValue) => (
                    <option key={`acute-${windowValue}`} value={windowValue}>
                      {windowValue}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                ACWR chronic window
                <select
                  value={settings.model.acwr.chronicWindow}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.acwr.chronicWindow = Number(event.target.value) as EWMADays;
                    })
                  }
                >
                  {[10, 15, 20, 25].map((windowValue) => (
                    <option key={`chronic-${windowValue}`} value={windowValue}>
                      {windowValue}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                ACWR low threshold
                <NumberInput
                  value={settings.model.acwr.lowThreshold}
                  min={0.1}
                  max={3}
                  step={0.05}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.acwr.lowThreshold = value;
                    })
                  }
                />
              </label>
              <label>
                ACWR high threshold
                <NumberInput
                  value={settings.model.acwr.highThreshold}
                  min={0.1}
                  max={4}
                  step={0.05}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.acwr.highThreshold = value;
                    })
                  }
                />
              </label>
              <label>
                ACWR planner target
                <input
                  type="range"
                  min={0.8}
                  max={1.3}
                  step={0.05}
                  value={settings.model.acwr.targetAcwr}
                  onChange={(e) =>
                    patchSettings((next) => {
                      next.model.acwr.targetAcwr = Number(e.target.value);
                    })
                  }
                />
                <span className="range-value">{settings.model.acwr.targetAcwr.toFixed(2)}</span>
              </label>
              <label>
                Sleep max hours
                <NumberInput
                  value={settings.model.recovery.personalMaxSleepHours}
                  min={1}
                  max={14}
                  step={0.25}
                  onCommit={(value) =>
                    patchSettings((next) => {
                      next.model.recovery.personalMaxSleepHours = value;
                    })
                  }
                />
              </label>
            </div>
            <button type="button" className="danger" onClick={() => setSettings(DEFAULT_SETTINGS)}>
              ↺ Revert All Settings To Default
            </button>

            <h3>Data Export / Import</h3>
            <p>Download complete backup as JSON, or re-import to restore all data (same format as Google Drive).</p>
            <div className="metric-row">
              <button type="button" onClick={exportBackupAsJSON}>⬇ Export Full Backup (JSON)</button>
              <label className="file-import-label">
                ⬆ Import Full Backup (JSON)
                <input type="file" accept=".json" className="hidden-file-input" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importBackupFromJSON(file);
                  e.target.value = "";
                }} />
              </label>
            </div>
            <details>
              <summary>Legacy CSV Export (for reference)</summary>
              <div className="metric-row">
                <button type="button" onClick={exportBouldersToCSV}>⬇ Export Bouldering CSV</button>
                <button type="button" onClick={exportStrengthToCSV}>⬇ Export Strength CSV</button>
              </div>
              <div className="import-row">
                <label className="file-import-label">
                  ⬆ Import Bouldering CSV
                  <input type="file" accept=".csv" className="hidden-file-input" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importBouldersFromCSV(file);
                    e.target.value = "";
                  }} />
                </label>
                <label className="file-import-label">
                  ⬆ Import Strength CSV
                  <input type="file" accept=".csv" className="hidden-file-input" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importStrengthFromCSV(file);
                    e.target.value = "";
                  }} />
                </label>
              </div>
            </details>

            <h3>Google Drive Sync</h3>
            <p>{driveStatus}</p>
            <p>
              Current origin: <strong>{window.location.origin}</strong>
            </p>
            <div className="metric-row">
              <button type="button" onClick={() => connectGoogleDrive()}>
                Connect Google Drive
              </button>
              <button type="button" onClick={disconnectGoogleDrive}>
                Disconnect
              </button>
              <button type="button" onClick={() => void handleDriveUpload()}>
                Upload Backup
              </button>
              <button type="button" onClick={() => void handleDriveRestore()}>
                Restore Backup
              </button>
            </div>
            {driveLog.length > 0 && (
              <div className="drive-log">
                <div className="drive-log-header">
                  <span>Auth log</span>
                  <button type="button" className="drive-log-clear" onClick={() => setDriveLog([])}>Clear</button>
                </div>
                {driveLog.map((entry, i) => <p key={i} className="drive-log-entry">{entry}</p>)}
              </div>
            )}

            <h3>ACWR Math Demo</h3>
            <p>
              Dummy session: {acwrExample.dummyProblems} problems, {acwrExample.dummyDuration} min, {" "}
              {acwrExample.dummySleep.toFixed(1)}h sleep.
            </p>
            <p>
              Base load = problems x gradeIntensity x speedMultiplier x recoveryMultiplier
            </p>
            <p>
              Base load = {acwrExample.dummyProblems} x {acwrExample.baselineGrade.toFixed(3)} x {" "}
              {acwrExample.baselineSpeed.toFixed(3)} x {acwrExample.baselineRecovery.toFixed(3)} = {" "}
              {acwrExample.baselineLoad.toFixed(2)}
            </p>
            <p>
              Acute EWMA ({acwrExample.acuteWindow}) = alphaA x load + (1 - alphaA) x prevAcute
            </p>
            <p>
              Chronic EWMA ({acwrExample.chronicWindow}) = alphaC x load + (1 - alphaC) x prevChronic
            </p>
            <p>
              ACWR = Acute EWMA / Chronic EWMA = {acwrExample.nextAcuteEwma.toFixed(2)} / {" "}
              {acwrExample.nextChronicEwma.toFixed(2)} = {acwrExample.nextAcwr.toFixed(2)}
            </p>

            <h3>Model Curves</h3>
            <div className="curve-grid">
              <CurveChart
                title="Grade Intensity Curve"
                xLabel="Grade"
                yLabel="Intensity"
                points={gradeCurvePoints}
                stroke="#0f7f88"
                xFormatter={(value) => gradeToDisplay(gradeFromNumber(value), settings.gradeDisplayUnit)}
                yFormatter={(value) => value.toFixed(2)}
                yLogarithmic
              />
              <CurveChart
                title="Speed Multiplier Curve"
                xLabel="Problems per hour"
                yLabel="Speed multiplier"
                points={speedCurvePoints}
                stroke="#d97706"
                xFormatter={(value) => value.toFixed(0)}
                yFormatter={(value) => `${value.toFixed(2)}x`}
              />
              <CurveChart
                title="Sleep Penalty Curve"
                xLabel="Sleep deficit %"
                yLabel="Penalty %"
                points={sleepPenaltyCurvePoints}
                stroke="#9f2a2a"
                xFormatter={(value) => `${value.toFixed(0)}%`}
                yFormatter={(value) => `${value.toFixed(1)}%`}
              />
              <CurveChart
                title="Stress Penalty Curve"
                xLabel="Stress level (0-10)"
                yLabel="Penalty %"
                points={stressPenaltyCurvePoints}
                stroke="#d97706"
                xFormatter={(value) => (value / 10).toFixed(1)}
                yFormatter={(value) => `${value.toFixed(1)}%`}
              />
            </div>

            <div className="example-grid">
              <article className="math-card">
                <h4>Grade harder (V6 to V9)</h4>
                <p>Load changes to {acwrExample.hardGradeLoad.toFixed(2)}</p>
                <p>
                  ACWR: {acwrExample.hardGradeAcwr.toFixed(2)}
                </p>
              </article>
              <article className="math-card">
                <h4>Climb faster (120 to 75 min)</h4>
                <p>Load changes to {acwrExample.fasterPaceLoad.toFixed(2)}</p>
                <p>
                  ACWR: {acwrExample.fasterPaceAcwr.toFixed(2)}
                </p>
              </article>
              <article className="math-card">
                <h4>Sleep less (7.5h to 6.0h)</h4>
                <p>Load changes to {acwrExample.poorSleepLoad.toFixed(2)}</p>
                <p>
                  ACWR: {acwrExample.poorSleepAcwr.toFixed(2)}
                </p>
              </article>
            </div>
          </article>
        </section>
      )}

      {tab === "history" && (
        <section className="panel-grid">
          <article className="panel full-width">
            <h2>Bouldering History</h2>
            {sessions.length === 0 && <p>No sessions saved yet.</p>}
            {sessions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Entry Date</th>
                    <th>Climbing Date</th>
                    <th>Problems</th>
                    <th>Grades</th>
                    <th>Duration</th>
                    <th>Sleep</th>
                    <th>Stress</th>
                    <th>Motivation</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => {
                    const count = session.problems.reduce((sum, problem) => sum + problem.count, 0);
                    const climbingDates = Array.from(
                      new Set(session.problems.map((problem) => problem.climbedOn).filter(Boolean)),
                    ) as string[];
                    const climbingDateLabel =
                      climbingDates.length === 0
                        ? "-"
                        : climbingDates.length === 1
                          ? climbingDates[0]
                          : `${climbingDates[0]} to ${climbingDates[climbingDates.length - 1]}`;
                    
                    const gradesLabel = session.problems.length === 0 
                      ? "-"
                      : Array.from(new Set(session.problems.map((p) => gradeToDisplay(p.grade, settings.gradeDisplayUnit)))).sort().join(", ");

                    return (
                      <tr key={session.id}>
                        <td>{new Date(session.createdAt).toLocaleString()}</td>
                        <td>{climbingDateLabel}</td>
                        <td>{count}</td>
                        <td>{gradesLabel}</td>
                        <td>{session.durationMinutes} min</td>
                        <td>{session.sleepHours.toFixed(1)} h</td>
                        <td>{session.stress}</td>
                        <td>{session.motivation}</td>
                        <td>
                          <button type="button" onClick={() => beginEditSession(session)}>
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </article>

          <article className="panel full-width">
            <h2>Strength History</h2>
            {strengthSessions.length === 0 && <p>No strength sessions saved yet.</p>}
            {strengthSessions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Entry Date</th>
                    <th>Session Date</th>
                    <th>Cycle</th>
                    <th>Week</th>
                    <th>Exercises</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {strengthSessions.map((session) => (
                    <tr key={session.id}>
                      <td>{new Date(session.createdAt).toLocaleString()}</td>
                      <td>{session.sessionDate}</td>
                      <td><span className="cycle-badge">Cycle {session.cycleNumber ?? 1}</span></td>
                      <td>{session.week}</td>
                      <td>{session.exercises.length}</td>
                      <td>{session.notes ?? "-"}</td>
                      <td>
                        <button type="button" onClick={() => beginEditStrengthSession(session)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </section>
      )}
    </main>
  );
}

export default App;
