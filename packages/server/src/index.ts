import { buildApp } from './app';
import { HOST, NOW_OVERRIDE, PORT, databasePathFor, resolveMode } from './config';
import { assertNowOverrideAllowed, openDatabaseForMode } from './db/mode-guard';

// Resolve the mode before anything touches the filesystem: an unset or invalid
// FINANCE_MODE must fail without creating a database file (proposal 005).
const mode = resolveMode();
assertNowOverrideAllowed(mode, NOW_OVERRIDE);

const path = databasePathFor(mode);
const db = openDatabaseForMode(mode, path);

const app = buildApp(db, {
  mode,
  ...(NOW_OVERRIDE ? { now: () => new Date(`${NOW_OVERRIDE}T12:00:00`) } : {}),
});

app
  .listen({ host: HOST, port: PORT })
  .then((address) => {
    app.log.info(`server listening on ${address} (loopback only) — mode=${mode}, db=${path}`);
    if (mode === 'dev') {
      app.log.warn(
        `FINANCE_MODE=dev: serving the synthetic seed at ${path}. This is not your finances; ` +
          'the UI shows a banner saying so. Use "npm start" for real data.',
      );
    }
    if (NOW_OVERRIDE) {
      app.log.warn(
        `FINANCE_NOW is set: "today" is pinned to ${NOW_OVERRIDE}, not the wall clock. ` +
          'Budget materialization and the past-month write lock follow this date — ' +
          'unset it for normal use.',
      );
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
