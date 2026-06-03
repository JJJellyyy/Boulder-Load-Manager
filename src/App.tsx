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
  calculateSessionLoad,
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
  type EWMASnapshot,
  type Grade,
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
          <h1>EWMA Load Tracking</h1>
          <p>
            Capacity range suggestion for max {settings.climberMaxGrade}: V
            {capacityRange.min.toFixed(1)} to V{capacityRange.max.toFixed(1)}
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
            <span>EWMA Types</span>
            <strong>{Object.keys(ewmaSnapshots).length}</strong>
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
                      {grade}
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
                      <td>{problem.count}</td>
                      <td>{problem.grade}</td>
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
            <h2>EWMA by Boulder Type (Hold x Angle)</h2>
            {Object.values(ewmaSnapshots).length === 0 && <p>Save a session to generate EWMA values.</p>}
            {Object.values(ewmaSnapshots).length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Boulder type</th>
                    <th>EWMA 10</th>
                    <th>EWMA 15</th>
                    <th>EWMA 20</th>
                    <th>EWMA 25</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(ewmaSnapshots)
                    .sort((a, b) => a.key.localeCompare(b.key))
                    .map((snapshot) => (
                      <tr key={snapshot.key}>
                        <td>{snapshot.key.replace("__", " + ")}</td>
                        <td>{snapshot.ewma10.toFixed(2)}</td>
                        <td>{snapshot.ewma15.toFixed(2)}</td>
                        <td>{snapshot.ewma20.toFixed(2)}</td>
                        <td>{snapshot.ewma25.toFixed(2)}</td>
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
                      {grade}
                    </option>
                  ))}
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
                Grade exponent
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.gradeIntensity.exponent}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.exponent = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Grade base
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.gradeIntensity.base}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.base = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Grade scale
                <input
                  type="number"
                  step={0.05}
                  value={settings.model.gradeIntensity.scale}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.gradeIntensity.scale = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Speed baseline (problems/min)
                <input
                  type="number"
                  step={0.01}
                  value={settings.model.speed.baselineProblemsPerMinute}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.speed.baselineProblemsPerMinute = Number(event.target.value);
                    })
                  }
                />
              </label>
              <label>
                Speed curve steepness
                <input
                  type="number"
                  step={0.1}
                  value={settings.model.speed.curveSteepness}
                  onChange={(event) =>
                    patchSettings((next) => {
                      next.model.speed.curveSteepness = Number(event.target.value);
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
              <label>
                Penalty at 10% deficit
                <input
                  type="number"
                  step={0.01}
                  value={settings.model.recovery.sleepPenalty.points.find((point) => point.deficit === 0.1)?.penalty ?? 0.05}
                  onChange={(event) =>
                    patchSettings((next) => {
                      const point = next.model.recovery.sleepPenalty.points.find((entry) => entry.deficit === 0.1);
                      if (point) {
                        point.penalty = Number(event.target.value);
                      }
                    })
                  }
                />
              </label>
              <label>
                Penalty at 20% deficit
                <input
                  type="number"
                  step={0.01}
                  value={settings.model.recovery.sleepPenalty.points.find((point) => point.deficit === 0.2)?.penalty ?? 0.15}
                  onChange={(event) =>
                    patchSettings((next) => {
                      const point = next.model.recovery.sleepPenalty.points.find((entry) => entry.deficit === 0.2);
                      if (point) {
                        point.penalty = Number(event.target.value);
                      }
                    })
                  }
                />
              </label>
              <label>
                Penalty at 30% deficit
                <input
                  type="number"
                  step={0.01}
                  value={settings.model.recovery.sleepPenalty.points.find((point) => point.deficit === 0.3)?.penalty ?? 0.3}
                  onChange={(event) =>
                    patchSettings((next) => {
                      const point = next.model.recovery.sleepPenalty.points.find((entry) => entry.deficit === 0.3);
                      if (point) {
                        point.penalty = Number(event.target.value);
                      }
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
