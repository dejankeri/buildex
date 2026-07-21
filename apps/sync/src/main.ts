// The process entrypoint - the only file in apps/sync that knows about env, sockets, signals and
// exit codes. Everything it needs is already built: config.ts validates, server.ts wires,
// node-server.ts binds. `start` is exported and returns a handle so the whole boot path is testable
// in-process on an ephemeral port; the bottom of the file is the only part that touches `process`.
import { readConfig } from "./config.js";
import { createServices } from "./server.js";
import { listen } from "./http/node-server.js";

export interface Started {
  port: number;
  /** Stop serving and release every handle. Idempotent. */
  stop: () => Promise<void>;
}

export async function start(env: Record<string, string | undefined>): Promise<Started> {
  const config = readConfig(env); // throws ConfigError - a half-configured boot is worse than none
  const services = await createServices(config);
  const bound = await listen(services.handler, { port: config.port, host: "0.0.0.0" });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await bound.close(); // force-closes keep-alive sockets; git and undici both hold them open
    services.close();
  };

  return { port: bound.port, stop };
}

type SignalRegistrar = (signal: string, handler: () => void) => void;

/** Wire SIGTERM/SIGINT to a single graceful stop. `on` is injected so this is testable without
 *  installing real handlers on the test runner's own process. */
export function installShutdown(stop: () => Promise<void>, on: SignalRegistrar): void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return; // a second Ctrl-C must not race two closes
    shuttingDown = true;
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  on("SIGTERM", handler);
  on("SIGINT", handler);
}

// Run only when executed directly (`node dist/main.js`), never when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start(process.env)
    .then((started) => {
      // Never log the service key or any token - only the shape of the boot.
      console.log(`[sync] listening on 0.0.0.0:${started.port}`);
      installShutdown(started.stop, (signal, h) => {
        process.on(signal, h);
      });
    })
    .catch((err: unknown) => {
      console.error(`[sync] failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
