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
  calculateSpeedMultiplier,
  calculateSessionLoad,
  gradeToDisplay,
  gradeToNumber,
  suggestedCapacityRange,
} from "./domain/loadCalculator";
import {
  authorizeGoogleDrive,
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
    return roundToIncrement(template.oneRepMaxKg * 0.9, template.incrementKg);
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
  const width = 320;
  const height = 180;
  const pad = 22;

  if (points.length < 2) {
    return (
      <article className="curve-card">
        <h4>{title}</h4>
        <p>Not enough data points to draw curve.</p>
      </article>
    );
  }

  const transformY = (v: number) => (yLogarithmic ? Math.log(Math.max(v, 0.001)) : v);

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minYT = Math.min(...points.map((point) => transformY(point.y)));
  const maxYT = Math.max(...points.map((point) => transformY(point.y)));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));

  const spanX = Math.max(0.0001, maxX - minX);
  const spanYT = Math.max(0.0001, maxYT - minYT);

  const polyline = points
    .map((point) => {
      const x = pad + ((point.x - minX) / spanX) * (width - pad * 2);
      const yt = transformY(point.y);
      const y = height - pad - ((yt - minYT) / spanYT) * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <article className="curve-card">
      <h4>{title}{yLogarithmic && <span className="log-badge"> (log scale)</span>}</h4>
      <svg className="curve-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="curve-axis" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} className="curve-axis" />
        <polyline points={polyline} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
      </svg>
      <p className="curve-caption">
        {xLabel}: {xFormatter(minX)} to {xFormatter(maxX)} | {yLabel}: {yFormatter(minY)} to {yFormatter(maxY)}
      </p>
    </article>
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
  const [tab, setTab] = useState<TabName>("session");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState<SessionInput[]>([]);
  const [strengthTemplates, setStrengthTemplates] = useState<StrengthExerciseTemplate[]>([]);
  const [strengthSessions, setStrengthSessions] = useState<StrengthSession[]>([]);
  const [ewmaSnapshots, setEwmaSnapshots] = useState<Record<string, EWMASnapshot>>({});
  const [draft, setDraft] = useState<SessionDraft>(createSessionDraft(DEFAULT_SETTINGS));
  const [editingSessionId, setEditingSessionId] = useState<string | undefined>();
  const [editingSessionCreatedAt, setEditingSessionCreatedAt] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [driveSession, setDriveSession] = useState<GoogleAuthSession | undefined>();
  const [googleProfile, setGoogleProfile] = useState<GoogleProfile | undefined>();
  const [driveStatus, setDriveStatus] = useState<string>("Google Drive not connected.");

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

  const acwrExample = useMemo(() => {
    const dummyProblems = 24;
    const dummyDuration = 120;
    const dummySleep = 7.5;
    const prevAcuteEwma = 95;
    const prevChronicEwma = 110;

    const acuteWindow = settings.model.acwr.acuteWindow;
    const chronicWindow = settings.model.acwr.chronicWindow;
    const acuteAlpha = 2 / (acuteWindow + 1);
    const chronicAlpha = 2 / (chronicWindow + 1);

    const baselineGrade = calculateGradeIntensity("V6", settings);
    const baselineSpeed = calculateSpeedMultiplier(dummyProblems, dummyDuration, settings);
    const baselineRecovery = calculateSleepRecoveryMultiplier(dummySleep, settings);
    const baselineLoad = dummyProblems * baselineGrade * baselineSpeed * baselineRecovery;
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
      baselineRecovery;

    const fasterPaceLoad =
      dummyProblems *
      baselineGrade *
      calculateSpeedMultiplier(dummyProblems, 75, settings) *
      baselineRecovery;

    const poorSleepLoad =
      dummyProblems *
      baselineGrade *
      baselineSpeed *
      calculateSleepRecoveryMultiplier(6.0, settings);

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

      const existingDriveSession = readStoredDriveSession();
      if (existingDriveSession) {
        try {
          const profile = await fetchGoogleProfile(existingDriveSession.accessToken);
          setDriveSession(existingDriveSession);
          setGoogleProfile(profile);
          setDriveStatus(`Google Drive connected as ${profile.email}.`);
        } catch {
          if (googleClientId) {
            try {
              const refreshedSession = await authorizeGoogleDrive(googleClientId, "");
              const refreshedProfile = await fetchGoogleProfile(refreshedSession.accessToken);
              setDriveSession(refreshedSession);
              setGoogleProfile(refreshedProfile);
              setDriveStatus(`Google Drive connected as ${refreshedProfile.email}.`);
              storeDriveSession(refreshedSession);
            } catch {
              storeDriveSession(undefined);
            }
          } else {
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

  async function saveStrengthProtocolSession(): Promise<void> {
    if (strengthTemplates.length === 0) {
      return;
    }

    const exercises = strengthTemplates.map((template) => ({
      templateId: template.id,
      name: template.name,
      trainingMaxKg: getTemplateTrainingMax(template),
      sets: build531Sets(getTemplateTrainingMax(template), template.incrementKg, strengthWeek),
    }));

    const session: StrengthSession = {
      id: getId(),
      createdAt: new Date().toISOString(),
      sessionDate: strengthDate,
      week: strengthWeek,
      exercises,
      notes: strengthNotes.trim() || undefined,
    };

    await saveStrengthSession(session);
    setStrengthSessions((previous) => [session, ...previous]);
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
    setTab("session");
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

  async function connectGoogleDrive(): Promise<string | undefined> {
    if (!googleClientId) {
      setDriveStatus("Missing VITE_GOOGLE_CLIENT_ID. Configure it in Vercel and .env.local.");
      return undefined;
    }

    try {
      const session = await authorizeGoogleDrive(googleClientId, "consent");
      const profile = await fetchGoogleProfile(session.accessToken);
      setDriveSession(session);
      setGoogleProfile(profile);
      setDriveStatus(`Google Drive connected as ${profile.email}.`);
      storeDriveSession(session);
      return session.accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Drive connection failed.";
      setDriveStatus(message);
      return undefined;
    }
  }

  function disconnectGoogleDrive(): void {
    setDriveSession(undefined);
    setGoogleProfile(undefined);
    storeDriveSession(undefined);
    setDriveStatus("Google Drive disconnected.");
  }

  async function ensureDriveAccessToken(): Promise<string | undefined> {
    if (driveSession && Date.now() < driveSession.expiresAt - 15_000) {
      return driveSession.accessToken;
    }

    if (googleClientId) {
      try {
        const silentSession = await authorizeGoogleDrive(googleClientId, "");
        const profile = googleProfile ?? (await fetchGoogleProfile(silentSession.accessToken));
        setDriveSession(silentSession);
        setGoogleProfile(profile);
        storeDriveSession(silentSession);
        return silentSession.accessToken;
      } catch {
        return connectGoogleDrive();
      }
    }

    return undefined;
  }

  async function handleDriveUpload(): Promise<void> {
    const token = await ensureDriveAccessToken();
    if (!token) {
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
    const token = await ensureDriveAccessToken();
    if (!token) {
      return;
    }

    try {
      const payload = await downloadBackupFromGoogleDrive(token);
      await clearSessions();
      await clearEwmaSnapshots();
      await clearStrengthTemplates();
      await clearStrengthSessions();

      const restoredSettings = clampSettings(payload.settings ?? DEFAULT_SETTINGS);
      await saveSettings(restoredSettings);

      for (const restoredSession of payload.sessions) {
        await saveSession(restoredSession);
      }

      for (const snapshot of payload.ewmaSnapshots ?? []) {
        await saveEwmaSnapshot(snapshot);
      }

      for (const template of payload.strengthTemplates ?? [DEFAULT_STRENGTH_TEMPLATE]) {
        await saveStrengthTemplate(template);
      }

      for (const session of payload.strengthSessions ?? []) {
        await saveStrengthSession(session);
      }

      const [sessionsFromDb, snapshotsFromDb, templatesFromDb, strengthSessionsFromDb] = await Promise.all([
        loadSessions(),
        loadEwmaSnapshots(),
        loadStrengthTemplates(),
        loadStrengthSessions(),
      ]);
      const mappedSnapshots = snapshotsFromDb.reduce<Record<string, EWMASnapshot>>((acc, snapshot) => {
        acc[snapshot.key] = snapshot;
        return acc;
      }, {});

      setSettings(restoredSettings);
      setSessions(sessionsFromDb);
      setEwmaSnapshots(mappedSnapshots);
      setStrengthTemplates(templatesFromDb);
      setStrengthSessions(strengthSessionsFromDb);
      setDraft(createSessionDraft(restoredSettings));
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
    setTab("dashboard");
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
            <button type="button" className="connect-top-btn" onClick={() => void connectGoogleDrive()}>
              Sign in with Google
            </button>
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
        <button type="button" onClick={() => setTab("session")} className={tab === "session" ? "active" : ""}>
          Session
        </button>
        <button
          type="button"
          onClick={() => setTab("dashboard")}
          className={tab === "dashboard" ? "active" : ""}
        >
          Dashboard
        </button>
        <button type="button" onClick={() => setTab("strength")} className={tab === "strength" ? "active" : ""}>
          Strength
        </button>
        <button type="button" onClick={() => setTab("settings")} className={tab === "settings" ? "active" : ""}>
          Settings
        </button>
        <button type="button" onClick={() => setTab("history")} className={tab === "history" ? "active" : ""}>
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
          <article className="panel full-width">
            <h2>ACWR by Boulder Type (Main Metric)</h2>
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
            <button type="button" onClick={() => void saveStrengthProtocolSession()} disabled={strengthTemplates.length === 0}>
              Save Strength Session
            </button>
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
                    <th>1RM</th>
                    <th>TM</th>
                    <th>Increment</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {strengthTemplates.map((template) => (
                    <tr key={template.id}>
                      <td>{template.name}</td>
                      <td>{(template.oneRepMaxKg ?? template.trainingMaxKg / 0.9).toFixed(1)} kg</td>
                      <td>{getTemplateTrainingMax(template).toFixed(1)} kg</td>
                      <td>{template.incrementKg.toFixed(1)} kg</td>
                      <td>
                        <button type="button" className="danger" onClick={() => void removeStrengthTemplate(template.id)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>

          <article className="panel full-width">
            <h2>Calculated 5/3/1 Sets (Week {strengthWeek})</h2>
            {strengthTemplates.length === 0 && <p>Add at least one exercise template.</p>}
            {strengthTemplates.length > 0 && (
              <div className="panel-grid">
                {strengthTemplates.map((template) => {
                  const tm = getTemplateTrainingMax(template);
                  const sets = build531Sets(tm, template.incrementKg, strengthWeek);
                  return (
                    <article key={`plan-${template.id}`} className="panel">
                      <h3>{template.name}</h3>
                      <p>
                        1RM: {(template.oneRepMaxKg ?? template.trainingMaxKg / 0.9).toFixed(1)} kg | TM (90%): {tm.toFixed(1)} kg
                      </p>
                      <table>
                        <thead>
                          <tr>
                            <th>Set</th>
                            <th>%</th>
                            <th>Reps</th>
                            <th>Target</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sets.map((set, index) => (
                            <tr key={`${template.id}-set-${index}`}>
                              <td>{index + 1}</td>
                              <td>{Math.round(set.percentage * 100)}%</td>
                              <td>{set.reps}</td>
                              <td>{set.targetWeightKg.toFixed(1)} kg</td>
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

          <article className="panel full-width">
            <h2>Strength History</h2>
            {strengthSessions.length === 0 && <p>No strength sessions saved yet.</p>}
            {strengthSessions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Entry Date</th>
                    <th>Session Date</th>
                    <th>Week</th>
                    <th>Exercises</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {strengthSessions.map((session) => (
                    <tr key={session.id}>
                      <td>{new Date(session.createdAt).toLocaleString()}</td>
                      <td>{session.sessionDate}</td>
                      <td>{session.week}</td>
                      <td>{session.exercises.length}</td>
                      <td>{session.notes ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

            <h3>Google Drive Sync</h3>
            <p>{driveStatus}</p>
            <p>
              Current origin: <strong>{window.location.origin}</strong>
            </p>
            <div className="metric-row">
              <button type="button" onClick={() => void connectGoogleDrive()}>
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
            <h2>Session History</h2>
            {sessions.length === 0 && <p>No sessions saved yet.</p>}
            {sessions.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Entry Date</th>
                    <th>Climbing Date</th>
                    <th>Problems</th>
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

                    return (
                      <tr key={session.id}>
                        <td>{new Date(session.createdAt).toLocaleString()}</td>
                        <td>{climbingDateLabel}</td>
                        <td>{count}</td>
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
        </section>
      )}
    </main>
  );
}

export default App;
