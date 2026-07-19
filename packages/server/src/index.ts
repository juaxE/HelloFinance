import { buildApp } from './app';
import { HOST, NOW_OVERRIDE, PORT } from './config';
import { getDb } from './db/client';
import { runMigrations } from './db/migrate';

const db = getDb();
runMigrations(db);

const app = buildApp(
  db,
  NOW_OVERRIDE ? { now: () => new Date(`${NOW_OVERRIDE}T12:00:00`) } : {},
);

app
  .listen({ host: HOST, port: PORT })
  .then((address) => {
    app.log.info(`server listening on ${address} (loopback only)`);
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
