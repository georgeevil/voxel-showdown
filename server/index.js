// Entry point: `npm start`. All game logic lives in ./game.js (startServer).

import { PORT } from '../shared/constants.js';
import { startServer } from './game.js';

const port = Number(process.env.PORT) || PORT;

startServer({ port, quiet: false, tick: true }).then((srv) => {
  const stop = () => { srv.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch((err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: PORT=${port + 1} npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
