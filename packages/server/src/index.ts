import { buildApp } from './app';
import { HOST, PORT } from './config';

const app = buildApp();

app
  .listen({ host: HOST, port: PORT })
  .then((address) => {
    app.log.info(`server listening on ${address} (loopback only)`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
