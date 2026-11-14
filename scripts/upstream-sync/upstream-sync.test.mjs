import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  deployWithOneRecoveryAttempt,
  inspectChangeSet,
  isProtectedPath,
} from "./lib.mjs"

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "coworkers-upstream-test-"))
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.name", "Test")
  git(dir, "config", "user.email", "test@example.invalid")
  return dir
}

function commit(cwd, message) {
  git(cwd, "add", ".")
  git(cwd, "commit", "-m", message)
  return git(cwd, "rev-parse", "HEAD")
}

test("no update exits without a candidate", () => {
  const dir = repo()
  try {
    writeFileSync(join(dir, "README.md"), "base\n")
    const base = commit(dir, "base")
    assert.doesNotThrow(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], {
        cwd: dir,
        stdio: "ignore",
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("normal upstream update merges cleanly", () => {
  const dir = repo()
  try {
    writeFileSync(join(dir, "README.md"), "base\n")
    const base = commit(dir, "base")
    git(dir, "checkout", "-b", "upstream")
    writeFileSync(join(dir, "README.md"), "base\nupstream\n")
    const upstream = commit(dir, "upstream")
    git(dir, "checkout", "main")
    git(dir, "merge", "--no-ff", "--no-edit", upstream)
    assert.deepEqual(inspectChangeSet(dir, base, "HEAD").blockers, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("conflicting personal and upstream edits stop", () => {
  const dir = repo()
  try {
    writeFileSync(join(dir, "README.md"), "base\n")
    commit(dir, "base")
    writeFileSync(join(dir, "README.md"), "personal\n")
    commit(dir, "personal")
    git(dir, "checkout", "-b", "upstream", "HEAD~1")
    writeFileSync(join(dir, "README.md"), "upstream\n")
    commit(dir, "upstream")
    git(dir, "checkout", "main")
    assert.throws(() => git(dir, "merge", "--no-ff", "--no-edit", "upstream"))
    assert.notEqual(git(dir, "diff", "--name-only", "--diff-filter=U"), "")
    git(dir, "merge", "--abort")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sensitive dependency changes are rejected", () => {
  const dir = repo()
  try {
    writeFileSync(join(dir, "package.json"), "{}\n")
    const base = commit(dir, "base")
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"x":"1"}}\n')
    const upstream = commit(dir, "upstream dependency")
    assert.match(inspectChangeSet(dir, base, upstream).blockers.join("\n"), /package\.json/)
    assert.equal(isProtectedPath("pnpm-lock.yaml"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("failed deploy retries once only when live state is unchanged", async () => {
  let live = "version-1"
  let attempts = 0
  const result = await deployWithOneRecoveryAttempt({
    expectedVersionId: "version-1",
    deploy: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("transient")
      live = "version-2"
    },
    readLiveVersion: async () => live,
    sleep: async () => {},
  })
  assert.equal(result.attempts, 2)
  assert.equal(attempts, 2)
})

test("partial live change prevents an automatic retry", async () => {
  let live = "version-1"
  let attempts = 0
  await assert.rejects(
    deployWithOneRecoveryAttempt({
      expectedVersionId: "version-1",
      deploy: async () => {
        attempts += 1
        live = "version-partial"
        throw new Error("transport closed")
      },
      readLiveVersion: async () => live,
      sleep: async () => {},
    }),
    /may have changed; no retry/,
  )
  assert.equal(attempts, 1)
})

test("a successful command with unchanged live state is not replayed", async () => {
  let attempts = 0
  await assert.rejects(
    deployWithOneRecoveryAttempt({
      expectedVersionId: "version-1",
      deploy: async () => {
        attempts += 1
      },
      readLiveVersion: async () => "version-1",
      sleep: async () => {},
    }),
    /succeeded but live deployment did not change/,
  )
  assert.equal(attempts, 1)
})
