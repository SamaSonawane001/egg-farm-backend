import app from './app';
import { env } from './config/env';
import { runMigrations } from './config/migrate';

async function main() {
  if (env.autoMigrate) await runMigrations();
  app.listen(env.port, () => console.log(`🥚 Egg Farm API running on http://localhost:${env.port}`));
}

main().catch((e) => {
  console.error('Failed to start server:', e.message);
  process.exit(1);
});
