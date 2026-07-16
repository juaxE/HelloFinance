import { buildApp } from './app';
import { HOST, PORT } from './config';
import { getDb } from './db/client';
import { runMigrations } from './db/migrate';

const db = getDb();
runMigrations(db);

const app = buildApp(db);

app
  .listen({ host: HOST, port: PORT })
  .then((address) => {
    app.log.info(`server listening on ${address} (loopback only)`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
