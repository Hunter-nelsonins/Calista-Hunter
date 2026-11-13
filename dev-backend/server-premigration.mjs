// LOCAL-ONLY: fake backend in the "before the additive migration" state (tests that the site degrades gracefully).
import { startServer } from './server.mjs';
await startServer({ migrate: false });
