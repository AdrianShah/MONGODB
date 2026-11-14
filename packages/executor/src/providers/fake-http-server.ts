// Standalone fake payment provider for the demo fallback:
//   FAKE_PROVIDER_PORT=4700 npm run fake-provider
// then run the executor with PAYMENTS=fake-http FAKE_PROVIDER_URL=http://127.0.0.1:4700
import { startFakeProviderServer } from "./fake-http.js";

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 4700);
const { url } = await startFakeProviderServer(port);
console.log(`[fake-provider] listening on ${url}`);
