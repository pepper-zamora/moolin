import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, isNewerVersion, parseVersion, releaseFromGitHub } from "./update-check";

const RELEASE_PAGE = "https://github.com/pepper-zamora/moolin/releases/tag/v0.2.0";

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag_name: "v0.2.0", html_url: RELEASE_PAGE, draft: false, prerelease: false, ...overrides };
}

// A fetch that answers every request with `status` and `body`, and records
// the URLs asked for.
function stubFetch(status: number, body: unknown, urls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("parseVersion accepts plain versions with or without a leading v", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("1.2.3-beta"), null);
  assert.equal(parseVersion("latest"), null);
});

test("isNewerVersion compares numerically, field by field", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("v0.10.0", "0.9.9"), true);
  assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("garbage", "0.1.0"), false);
});

test("releaseFromGitHub takes the version and page of a published release", () => {
  assert.deepEqual(releaseFromGitHub(release()), { version: "0.2.0", url: RELEASE_PAGE });
});

test("releaseFromGitHub rejects drafts, pre-releases, odd tags and off-site pages", () => {
  assert.equal(releaseFromGitHub(release({ draft: true })), null);
  assert.equal(releaseFromGitHub(release({ prerelease: true })), null);
  assert.equal(releaseFromGitHub(release({ tag_name: "nightly" })), null);
  assert.equal(releaseFromGitHub(release({ html_url: "https://example.com/moolin" })), null);
  assert.equal(releaseFromGitHub(release({ html_url: 42 })), null);
  assert.equal(releaseFromGitHub(null), null);
  assert.equal(releaseFromGitHub("v0.2.0"), null);
});

test("checkForUpdate asks GitHub for the latest release and reports a newer one", async () => {
  const urls: string[] = [];
  const result = await checkForUpdate("0.1.0", stubFetch(200, release(), urls));
  assert.deepEqual(result, { status: "update-available", release: { version: "0.2.0", url: RELEASE_PAGE } });
  assert.deepEqual(urls, ["https://api.github.com/repos/pepper-zamora/moolin/releases/latest"]);
});

test("checkForUpdate reports up to date for the same or an older release", async () => {
  const latest = { version: "0.2.0", url: RELEASE_PAGE };
  assert.deepEqual(await checkForUpdate("0.2.0", stubFetch(200, release())), { status: "up-to-date", latest });
  assert.deepEqual(await checkForUpdate("0.3.0", stubFetch(200, release())), { status: "up-to-date", latest });
});

test("checkForUpdate treats no published release as up to date", async () => {
  assert.deepEqual(await checkForUpdate("0.1.0", stubFetch(404, { message: "Not Found" })), {
    status: "up-to-date",
    latest: null,
  });
});

test("checkForUpdate reports failures instead of throwing", async () => {
  const failed = (result: { status: string }) => assert.equal(result.status, "failed");
  failed(await checkForUpdate("0.1.0", stubFetch(403, { message: "rate limited" })));
  failed(await checkForUpdate("0.1.0", stubFetch(200, "{not json")));
  failed(await checkForUpdate("0.1.0", stubFetch(200, release({ tag_name: "nightly" }))));
  const offline = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as typeof fetch;
  assert.deepEqual(await checkForUpdate("0.1.0", offline), {
    status: "failed",
    error: "getaddrinfo ENOTFOUND api.github.com",
  });
});
