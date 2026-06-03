# Boulder Load Manager

Local-first web app for tracking bouldering load with configurable EWMA calculations.

## What Is Implemented

- Session logging flow: problems count, grade (V4-V13), hold type, wall angle.
- Session context: duration, sleep before session, stress, motivation.
- Configurable load model values in settings:
  - Grade intensity curve.
  - Speed multiplier curve.
  - Sleep penalty curve.
- EWMA output per hold x angle combination for windows 10, 15, 20, 25.
- Local persistence with IndexedDB (sessions, settings, EWMA snapshots).

## Run Locally

```bash
npm install
npm run dev
```

Open the local URL shown in the terminal.

## Build

```bash
npm run build
npm run preview
```

## Deployment Recommendation

Deploy on Vercel first.

Why this is a good fit:
- Static React/Vite frontend deploys fast.
- Easy preview URLs per commit.
- Simple environment variable management when Google Drive sync is added.

### Vercel Steps

1. Push this project to GitHub.
2. Import the repository in Vercel.
3. Framework preset: Vite.
4. Build command: `npm run build`.
5. Output directory: `dist`.
6. Deploy.

### Vercel CLI (optional)

1. Install CLI globally: `npm i -g vercel`
2. Login: `vercel login`
3. Run first deploy: `vercel`
4. Run production deploy: `npm run deploy:vercel`

### Post Deploy Checks

1. Open the deployed URL.
2. Create a test session and refresh the page.
3. Confirm the session is still present (IndexedDB persistence).
4. Open Vercel project settings and set your production domain.

When Google Drive sync is added, register production and preview OAuth redirect URLs in Google Cloud.

## Core Files

- `src/App.tsx` - Main UI and save flow.
- `src/domain/loadCalculator.ts` - Grade intensity, speed multiplier, sleep penalty, session load.
- `src/domain/ewma.ts` - EWMA updates.
- `src/domain/loadModelConfig.ts` - Default and clamped model configuration.
- `src/db/indexedDb.ts` - Local database access.
- `src/types/index.ts` - Domain models and config types.
