import { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  clearEwmaSnapshots,
  clearSessions,
  loadEwmaSnapshots,
  loadSessions,
  loadSettings,
  saveEwmaSnapshot,
  saveSession,
  saveSettings,
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
  type ProblemEntry,
  type SessionInput,
  type WallAngle,
} from "./types";

type TabName = "session" | "dashboard" | "settings" | "history";

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
}

function CurveChart({
  title,
  xLabel,
  yLabel,
  points,
  stroke,
  xFormatter = (value) => value.toFixed(2),
  yFormatter = (value) => value.toFixed(2),
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

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));

  const spanX = Math.max(0.0001, maxX - minX);
  const spanY = Math.max(0.0001, maxY - minY);

  const polyline = points
    .map((point) => {
      const x = pad + ((point.x - minX) / spanX) * (width - pad * 2);
      const y = height - pad - ((point.y - minY) / spanY) * (height - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <article className="curve-card">
      <h4>{title}</h4>
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

function App() {
  const [tab, setTab] = useState<TabName>("session");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState<SessionInput[]>([]);
  const [ewmaSnapshots, setEwmaSnapshots] = useState<Record<string, EWMASnapshot>>({});
  const [draft, setDraft] = useState<SessionDraft>(createSessionDraft(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [driveToken, setDriveToken] = useState<string | undefined>();
  const [driveStatus, setDriveStatus] = useState<string>("Google Drive not connected.");

  const [entryCount, setEntryCount] = useState(1);
  const [entryGrade, setEntryGrade] = useState<Grade>("V4");
  const [entryHold, setEntryHold] = useState<HoldType>("mixed");
  const [entryAngle, setEntryAngle] = useState<WallAngle>("vert");
  const [entryDate, setEntryDate] = useState<string>(todayIsoDate());
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

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
      const [savedSettings, savedSessions, savedSnapshots] = await Promise.all([
        loadSettings(),
        loadSessions(),
        loadEwmaSnapshots(),
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

  function getBackupPayload(): DriveBackupPayload {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      sessions,
      ewmaSnapshots: Object.values(ewmaSnapshots),
    };
  }

  async function connectGoogleDrive(): Promise<string | undefined> {
    if (!googleClientId) {
      setDriveStatus("Missing VITE_GOOGLE_CLIENT_ID. Configure it in Vercel and .env.local.");
      return undefined;
    }

    try {
      const token = await authorizeGoogleDrive(googleClientId);
      setDriveToken(token);
      setDriveStatus("Google Drive connected.");
      return token;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Drive connection failed.";
      setDriveStatus(message);
      return undefined;
    }
  }

  async function handleDriveUpload(): Promise<void> {
    const token = driveToken ?? (await connectGoogleDrive());
    if (!token) {
      return;
    }

    try {
      await uploadBackupToGoogleDrive(token, getBackupPayload());
      setDriveStatus("Backup uploaded to Google Drive.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setDriveStatus(message);
      setDriveToken(undefined);
    }
  }

  async function handleDriveRestore(): Promise<void> {
    const token = driveToken ?? (await connectGoogleDrive());
    if (!token) {
      return;
    }

    try {
      const payload = await downloadBackupFromGoogleDrive(token);
      await clearSessions();
      await clearEwmaSnapshots();

      const restoredSettings = clampSettings(payload.settings ?? DEFAULT_SETTINGS);
      await saveSettings(restoredSettings);

      for (const restoredSession of payload.sessions) {
        await saveSession(restoredSession);
      }

      for (const snapshot of payload.ewmaSnapshots ?? []) {
        await saveEwmaSnapshot(snapshot);
      }

      const sessionsFromDb = await loadSessions();
      const snapshotsFromDb = await loadEwmaSnapshots();
      const mappedSnapshots = snapshotsFromDb.reduce<Record<string, EWMASnapshot>>((acc, snapshot) => {
        acc[snapshot.key] = snapshot;
        return acc;
      }, {});

      setSettings(restoredSettings);
      setSessions(sessionsFromDb);
      setEwmaSnapshots(mappedSnapshots);
      setDraft(createSessionDraft(restoredSettings));
      setDriveStatus("Backup restored from Google Drive.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore failed.";
      setDriveStatus(message);
      setDriveToken(undefined);
    }
  }

  async function saveCurrentSession(): Promise<void> {
    if (draft.problems.length === 0) {
      return;
    }

    const session: SessionInput = {
      id: getId(),
      createdAt: new Date().toISOString(),
      durationMinutes: draft.durationMinutes,
      sleepHours: draft.sleepHours,
      stress: draft.stress,
      motivation: draft.motivation,
      problems: draft.problems,
    };

    const calculation = calculateSessionLoad(session, settings);
    const nextSnapshots = { ...ewmaSnapshots };

    const saveSnapshotJobs = calculation.byBoulderType.map(async (entry) => {
      const previous = nextSnapshots[entry.key];
      const updated = updateSnapshot(previous, entry.key, entry.adjustedLoad, settings.model.ewmaWindows);
      nextSnapshots[entry.key] = updated;
      await saveEwmaSnapshot(updated);
    });

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

    await Promise.all([...saveSnapshotJobs, saveSession(session)]);
    setEwmaSnapshots(nextSnapshots);
    setSessions((previous) => [session, ...previous]);
    setDraft(createSessionDraft(nextSettings));
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
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={entryCount}
                  onChange={(event) => setEntryCount(Number(event.target.value))}
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
            <div className="field-grid">
              <label>
                Duration (minutes)
                <input
                  type="number"
                  min={10}
                  value={draft.durationMinutes}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft((previous) => ({ ...previous, durationMinutes: Math.max(10, value) }));
                  }}
                />
              </label>
              <label>
                Sleep before session (hours)
                <input
                  type="number"
                  min={0}
                  max={12}
                  step={0.25}
                  value={draft.sleepHours}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft((previous) => ({ ...previous, sleepHours: Math.max(0, value) }));
                  }}
                />
              </label>
              <label>
                Stress ({settings.stressScaleMax} max)
                <input
                  type="number"
                  min={1}
                  max={settings.stressScaleMax}
                  value={draft.stress}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft((previous) => ({ ...previous, stress: value }));
                  }}
                />
              </label>
              <label>
                Motivation ({settings.motivationScaleMax} max)
                <input
                  type="number"
                  min={1}
                  max={settings.motivationScaleMax}
                  value={draft.motivation}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setDraft((previous) => ({ ...previous, motivation: value }));
                  }}
                />
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

            <button type="button" onClick={() => void saveCurrentSession()} disabled={draft.problems.length === 0}>
              Save Session And Update EWMA
            </button>
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
                <input
                  type="number"
                  value={settings.stressScaleMax}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.stressScaleMax = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Motivation scale max
                <input
                  type="number"
                  value={settings.motivationScaleMax}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.motivationScaleMax = Number(event.target.value);
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
                <input
                  type="number"
                  step={1}
                  value={settings.model.gradeIntensity.basePoints}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.basePoints = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Grade multiplier per grade
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.gradeIntensity.multiplierPerGrade}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.multiplierPerGrade = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Speed target minutes per boulder
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.speed.targetMinutesPerBoulder}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.speed.targetMinutesPerBoulder = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Speed exponent
                <input
                  type="number"
                  step={0.01}
                  value={settings.model.speed.exponent}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.speed.exponent = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Sleep penalty exponent
                <input
                  type="number"
                  step={0.1}
                  value={settings.model.recovery.sleepPenalty.exponent}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.recovery.sleepPenalty.exponent = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Max sleep penalty
                <input
                  type="number"
                  step={0.01}
                  value={settings.model.recovery.sleepPenalty.maxPenalty}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.recovery.sleepPenalty.maxPenalty = Number(event.target.value);
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
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.acwr.lowThreshold}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.acwr.lowThreshold = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                ACWR high threshold
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.acwr.highThreshold}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.acwr.highThreshold = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Sleep max hours
                <input
                  type="number"
                  step={0.25}
                  value={settings.model.recovery.personalMaxSleepHours}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.recovery.personalMaxSleepHours = Number(event.target.value);
                    })
                  }
                />
              </label>
            </div>
            <button type="button" onClick={() => setSettings(DEFAULT_SETTINGS)}>
              Reset defaults
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
                    <th>Date</th>
                    <th>Problems</th>
                    <th>Duration</th>
                    <th>Sleep</th>
                    <th>Stress</th>
                    <th>Motivation</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => {
                    const count = session.problems.reduce((sum, problem) => sum + problem.count, 0);
                    return (
                      <tr key={session.id}>
                        <td>{new Date(session.createdAt).toLocaleString()}</td>
                        <td>{count}</td>
                        <td>{session.durationMinutes} min</td>
                        <td>{session.sleepHours.toFixed(1)} h</td>
                        <td>{session.stress}</td>
                        <td>{session.motivation}</td>
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
