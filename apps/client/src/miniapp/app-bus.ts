// The mini-app bridge . A mini-app is a small HTML view rendered in a
// sandboxed iframe; the agent drives it through a local app-driver MCP. This bus is the in-process
// relay between them: the agent's command is queued, pushed to the browser (over SSE), executed in
// the sandbox, and its result reported back - matched by command id. It touches no credentials and
// no network; it is purely a local DOM-op relay (the prototype's app-bus, hardened + de-branded).
export interface AppCommand {
  app: string;
  op: "open" | "read" | "click" | "fill";
  selector?: string;
  value?: string;
}
export interface AppResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface AppFrame {
  id: string;
  command: AppCommand;
}

export interface AppBusDeps {
  idFactory: () => string;
}

export class AppBus {
  private subscribers = 0;
  private readonly queue: AppFrame[] = [];
  private readonly waiting = new Map<string, (r: AppResult) => void>();

  constructor(private readonly deps: AppBusDeps) {}

  /** The browser mini-app host connects; returns an unsubscribe. */
  subscribe(): () => void {
    this.subscribers++;
    return () => {
      this.subscribers = Math.max(0, this.subscribers - 1);
    };
  }

  /** Send a command to the open mini-app; resolves with its result. Fast-fails if no window. */
  send(command: AppCommand): Promise<AppResult> {
    if (this.subscribers === 0) {
      return Promise.reject(new Error("no mini-app window is open"));
    }
    const id = this.deps.idFactory();
    this.queue.push({ id, command });
    return new Promise<AppResult>((resolve) => {
      this.waiting.set(id, resolve);
    });
  }

  /** The browser host drains queued frames to execute (each frame is delivered once). */
  drain(): AppFrame[] {
    return this.queue.splice(0, this.queue.length);
  }

  /** The browser host reports a command's result; returns false for an unknown id. */
  resolve(id: string, result: AppResult): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    this.waiting.delete(id);
    w(result);
    return true;
  }
}
