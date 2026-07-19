// The embedded git service (net-new - drops the prototype's Gitea). It owns bare-repo management and
// serves the smart-HTTP protocol by bridging to git's own `git http-backend` CGI. It performs NO
// authorization - the HTTP layer authenticates the machine token and checks the control-plane
// permission matrix before calling `cgi` (so "core read-only by construction" is one identity
// system, not a forge's ACLs).
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { type GitService, assertSafeRepoName } from "./types.js";

export interface CgiRequest {
  repo: string;
  /** The path after `<repo>.git`, e.g. "/info/refs" or "/git-upload-pack". */
  pathAfterRepo: string;
  method: string;
  query: string;
  contentType?: string | undefined;
  body: Buffer;
}
export interface CgiResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class EmbeddedGitService implements GitService {
  private readonly reposRoot: string;
  constructor(opts: { reposRoot: string }) {
    this.reposRoot = opts.reposRoot;
  }

  repoDir(name: string): string {
    assertSafeRepoName(name);
    return join(this.reposRoot, `${name}.git`);
  }

  async ensureRepo(name: string): Promise<void> {
    const dir = this.repoDir(name);
    if (existsSync(dir)) return;
    execFileSync("git", ["init", "--bare", "--initial-branch=main", dir], { stdio: "ignore" });
    // Allow pushes over HTTP; the permission gate (HTTP layer) decides who may actually push.
    execFileSync("git", ["-C", dir, "config", "http.receivepack", "true"], { stdio: "ignore" });
  }

  /** Run a smart-HTTP request through git's own CGI backend and return the raw response. */
  async cgi(req: CgiRequest): Promise<CgiResponse> {
    assertSafeRepoName(req.repo);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      GIT_PROJECT_ROOT: this.reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${req.repo}.git${req.pathAfterRepo}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.query,
      CONTENT_TYPE: req.contentType ?? "",
      CONTENT_LENGTH: String(req.body.length),
    };

    return new Promise<CgiResponse>((resolve, reject) => {
      const child = spawn("git", ["http-backend"], { env });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => errChunks.push(d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 && chunks.length === 0) {
          reject(new Error(`git http-backend exited ${code}: ${Buffer.concat(errChunks).toString()}`));
          return;
        }
        resolve(parseCgi(Buffer.concat(chunks)));
      });
      child.stdin.end(req.body);
    });
  }
}

/** Split a CGI response (headers, blank line, body) and map a `Status:` header to an HTTP code. */
function parseCgi(out: Buffer): CgiResponse {
  let sep = out.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (sep === -1) {
    sep = out.indexOf("\n\n");
    sepLen = 2;
  }
  if (sep === -1) {
    // No headers - treat the whole thing as body.
    return { status: 200, headers: {}, body: out };
  }
  const headerText = out.subarray(0, sep).toString("utf8");
  const body = out.subarray(sep + sepLen);
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.toLowerCase() === "status") {
      status = parseInt(value, 10) || 200;
    } else {
      headers[key] = value;
    }
  }
  return { status, headers, body };
}
