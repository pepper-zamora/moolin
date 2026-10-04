// Checks GitHub for a newer release than the one running. Moolin has no
// auto-update, so this is how people hear that a release was replaced,
// including one withdrawn for a serious bug.
//
// GitHub's "latest release" is the newest published one: drafts and
// pre-releases are skipped, so turning a bad release back into a draft
// takes it out of the comparison.

export const RELEASES_REPO = "pepper-zamora/moolin";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const TIMEOUT_MS = 10000;

export interface Release {
  version: string; // "0.2.0", from a tag like "v0.2.0"
  url: string; // the release's page, where its downloads are
}

export type UpdateCheckResult =
  | { status: "update-available"; release: Release }
  | { status: "up-to-date"; latest: Release | null }
  | { status: "failed"; error: string };

// "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else (including pre-release
// suffixes like "1.2.3-beta") -> null, so an odd tag is never offered.
export function parseVersion(text: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? match.slice(1).map(Number) : null;
}

// Whether `candidate` is a later version than `current`. False if either
// can't be parsed.
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// The parts of GitHub's release JSON this needs, or null if it isn't a
// usable published release. The page URL must be on github.com, since it's
// opened in the user's browser.
export function releaseFromGitHub(json: unknown): Release | null {
  if (typeof json !== "object" || json === null) return null;
  const record = json as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true) return null;
  if (typeof record.tag_name !== "string" || typeof record.html_url !== "string") return null;
  const parsed = parseVersion(record.tag_name);
  if (!parsed || !record.html_url.startsWith("https://github.com/")) return null;
  return { version: parsed.join("."), url: record.html_url };
}

// `fetchFn` is Electron's net.fetch in the app (so system proxy settings
// apply) and a stub in tests. Never throws.
export async function checkForUpdate(currentVersion: string, fetchFn: typeof fetch): Promise<UpdateCheckResult> {
  let response: Response;
  try {
    response = await fetchFn(LATEST_RELEASE_URL, {
      // GitHub requires a User-Agent; this one says nothing about the user,
      // not even which version is asking.
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Moolin" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
  // No published release yet.
  if (response.status === 404) return { status: "up-to-date", latest: null };
  if (!response.ok) return { status: "failed", error: `GitHub answered ${response.status}` };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: "failed", error: "GitHub's answer wasn't valid JSON" };
  }
  const release = releaseFromGitHub(json);
  if (!release) return { status: "failed", error: "GitHub's answer didn't describe a usable release" };
  return isNewerVersion(release.version, currentVersion)
    ? { status: "update-available", release }
    : { status: "up-to-date", latest: release };
}
