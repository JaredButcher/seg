import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp({ config });

app.server.listen(config.port, config.host, () => {
  console.log(`[seg] server listening on http://${config.host}:${config.port}`);
  console.log(`[seg] database: ${config.databaseFile}`);
  if (!config.secureCookies) {
    console.log('[seg] cookies are NOT Secure — development only');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[seg] ${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
