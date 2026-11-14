import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const commit = (cwd, message) => {
  git(cwd, "add", ".")
  git(cwd, "commit", "-m", message)
  return git(cwd, "rev-parse", "HEAD")
}
const run = (cwd, script, env) =>
  execFileSync(process.execPath, [join(here, script)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim()

test("two real releases preserve upstream ancestry and fail closed on drift", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkers-release-integration-"))
  try {
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.invalid")
    mkdirSync(join(root, ".github/upstream-sync"), { recursive: true })
    mkdirSync(join(root, ".cloudflare/output/v0"), { recursive: true })
    writeFileSync(join(root, "README.md"), "base\n")
    writeFileSync(
      join(root, ".github/upstream-sync/deployment-state.json"),
      "{}\n"
    )
    writeFileSync(join(root, ".cloudflare/output/v0/config.json"), "{}\n")
    const base1 = commit(root, "base")

    git(root, "checkout", "-b", "upstream", base1)
    writeFileSync(join(root, "upstream-one.txt"), "one\n")
    const up1 = commit(root, "upstream one")
    git(root, "checkout", "main")
    git(root, "merge", "--no-ff", "--no-edit", "upstream")
    const candidate1 = git(root, "rev-parse", "HEAD")

    const env = {
      COWORKERS_ACCOUNT_ID: "00000000000000000000000000000000",
      COWORKERS_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      COWORKERS_ACCESS_AUD: "0".repeat(64),
    }
    const artifact = join(root, ".upstream-artifact")
    const makeRelease = (base, upstream, version) => {
      run(root, "create-artifact.mjs", {
        ...env,
        BASE_SHA: base,
        UPSTREAM_SHA: upstream,
      })
      writeFileSync(
        join(artifact, "deployment-result.json"),
        JSON.stringify({
          state: {
            schemaVersion: 1,
            worker: "coworkers",
            expectedVersionId: version,
          },
          attempts: 1,
          warnings: [],
        })
      )
      git(root, "checkout", "--detach", base)
      run(root, "finalize.mjs", { ARTIFACT_DIR: artifact })
      assert.doesNotThrow(() =>
        execFileSync("git", ["merge-base", "--is-ancestor", upstream, "HEAD"], {
          cwd: root,
          stdio: "ignore",
        })
      )
      return git(root, "rev-parse", "HEAD")
    }

    const release1 = makeRelease(base1, up1, "version-1")
    assert.equal(git(root, "rev-parse", `${release1}^`), candidate1)

    git(root, "switch", "-C", "main")
    git(root, "checkout", "-b", "upstream2", up1)
    writeFileSync(join(root, "upstream-two.txt"), "two\n")
    const up2 = commit(root, "upstream two")
    git(root, "checkout", "main")
    git(root, "merge", "--no-ff", "--no-edit", "upstream2")
    const release2 = makeRelease(release1, up2, "version-2")
    assert.doesNotThrow(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", up2, release2], {
        cwd: root,
        stdio: "ignore",
      })
    )

    const metadata = JSON.parse(
      readFileSync(join(artifact, "metadata.json"), "utf8")
    )
    metadata.upstream_sha = "d".repeat(40)
    writeFileSync(join(artifact, "metadata.json"), JSON.stringify(metadata))
    git(root, "checkout", "--detach", release2)
    assert.throws(() => run(root, "finalize.mjs", { ARTIFACT_DIR: artifact }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a blocked prepare emits its SHA and can be persistently suppressed", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkers-blocked-prepare-"))
  const upstreamRepo = mkdtempSync(join(tmpdir(), "coworkers-upstream-source-"))
  try {
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.invalid")
    writeFileSync(join(root, "package.json"), "{}\n")
    commit(root, "base")

    git(upstreamRepo, "clone", root, ".")
    git(upstreamRepo, "config", "user.name", "Test")
    git(upstreamRepo, "config", "user.email", "test@example.invalid")
    writeFileSync(
      join(upstreamRepo, "package.json"),
      '{"dependencies":{"blocked":"1"}}\n'
    )
    const upstream = commit(upstreamRepo, "blocked dependency change")

    const prepareOutput = join(root, "prepare-output.txt")
    writeFileSync(prepareOutput, "")
    run(root, "prepare.mjs", {
      UPSTREAM_URL: upstreamRepo,
      COWORKERS_ACCOUNT_ID: "0".repeat(32),
      COWORKERS_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      COWORKERS_ACCESS_AUD: "0".repeat(64),
      GITHUB_OUTPUT: prepareOutput,
    })

    const prepared = Object.fromEntries(
      readFileSync(prepareOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    )
    assert.equal(prepared.status, "blocked-sensitive")
    assert.equal(prepared.upstream_sha, upstream)

    const comments = join(root, "comments.json")
    const suppressionOutput = join(root, "suppression-output.txt")
    writeFileSync(
      comments,
      JSON.stringify([
        { body: `<!-- coworkers-upstream-failure:${upstream} -->` },
      ])
    )
    writeFileSync(suppressionOutput, "")
    run(root, "check-failure.mjs", {
      PREPARE_STATUS: prepared.status,
      PREPARE_REASON: prepared.reason,
      UPSTREAM_SHA: prepared.upstream_sha,
      GITHUB_EVENT_NAME: "schedule",
      COWORKERS_UPDATE_ISSUE_NUMBER: "42",
      FAILURE_COMMENTS_FILE: comments,
      GITHUB_OUTPUT: suppressionOutput,
    })
    assert.match(
      readFileSync(suppressionOutput, "utf8"),
      /status=failed-candidate-suppressed/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(upstreamRepo, { recursive: true, force: true })
  }
})

test("a conflicting prepare also emits the SHA used for suppression", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkers-conflict-prepare-"))
  const upstreamRepo = mkdtempSync(join(tmpdir(), "coworkers-conflict-source-"))
  try {
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.invalid")
    writeFileSync(join(root, "README.md"), "base\n")
    commit(root, "base")

    git(upstreamRepo, "clone", root, ".")
    git(upstreamRepo, "config", "user.name", "Test")
    git(upstreamRepo, "config", "user.email", "test@example.invalid")
    writeFileSync(join(upstreamRepo, "README.md"), "upstream\n")
    const upstream = commit(upstreamRepo, "conflicting upstream change")

    writeFileSync(join(root, "README.md"), "personal\n")
    commit(root, "conflicting personal change")

    const prepareOutput = join(root, "prepare-output.txt")
    writeFileSync(prepareOutput, "")
    run(root, "prepare.mjs", {
      UPSTREAM_URL: upstreamRepo,
      COWORKERS_ACCOUNT_ID: "0".repeat(32),
      COWORKERS_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      COWORKERS_ACCESS_AUD: "0".repeat(64),
      GITHUB_OUTPUT: prepareOutput,
    })
    const prepared = Object.fromEntries(
      readFileSync(prepareOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    )
    assert.equal(prepared.status, "blocked-conflict")
    assert.equal(prepared.upstream_sha, upstream)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(upstreamRepo, { recursive: true, force: true })
  }
})
