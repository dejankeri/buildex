// The machine token reaches git ONLY here, as an http.extraHeader Basic credential injected through
// GIT_CONFIG_* environment (git >= 2.31). Nothing is written to disk, to .git/config, to a remote
// URL, or to argv, so no `ps` or secret-scan leak is possible. The server (apps/sync) reads HTTP
// Basic auth and takes the token from the PASSWORD field, ignoring the username - so the username is
// a throwaway "x". This is the invariant `[release-gate:no-token-on-disk]` exists to protect.
export function gitAuthEnv(token: string): Record<string, string> {
  const header = "Authorization: Basic " + Buffer.from("x:" + token).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: header,
  };
}
