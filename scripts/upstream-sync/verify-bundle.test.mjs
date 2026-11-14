import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function createArtifact({ patchFor }) {
  const root = mkdtempSync(join(tmpdir(), "coworkers-bundle-smuggle-"))
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.invalid")
  writeFileSync(join(root, "README.md"), "base\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  const base = git(root, "rev-parse", "HEAD")

  git(root, "checkout", "-b", "upstream")
  mkdirSync(join(root, ".github"), { recursive: true })
  writeFileSync(join(root, ".github/evil.yml"), "name: evil\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "upstream protected change")
  const upstream = git(root, "rev-parse", "HEAD")
  git(root, "checkout", "main")
  git(root, "merge", "--no-ff", "--no-edit", "upstream")
  const candidate = git(root, "rev-parse", "HEAD")

  git(root, "update-ref", "refs/heads/upstream-candidate", candidate)
  const artifact = join(root, ".upstream-artifact")
  mkdirSync(artifact)
  execFileSync(
    "git",
    [
      "bundle",
      "create",
      join(artifact, "candidate.bundle"),
      `${base}..refs/heads/upstream-candidate`,
    ],
    { cwd: root, stdio: "ignore" }
  )
  const patch = patchFor(git, root, base, candidate)
  writeFileSync(join(artifact, "candidate.patch"), patch)
  writeFileSync(
    join(artifact, "metadata.json"),
    JSON.stringify({
      base_sha: base,
      upstream_sha: upstream,
      candidate_sha: candidate,
      patch_sha256: createHash("sha256").update(patch).digest("hex"),
    })
  )
  git(root, "checkout", "--detach", base)
  return { artifact, base, root }
}

function verify(root, artifact, base) {
  return execFileSync(process.execPath, [join(here, "verify-bundle.mjs")], {
    cwd: root,
    env: { ...process.env, ARTIFACT_DIR: artifact, TRUSTED_HEAD_SHA: base },
    stdio: "pipe",
  })
}

function assertVerificationFails(root, artifact, base, message) {
  assert.throws(
    () => verify(root, artifact, base),
    (error) => {
      assert.match(String(error.stderr), message)
      return true
    }
  )
}

test("rejects a patch that does not match the bundle tree", () => {
  const { root, artifact, base } = createArtifact({
    patchFor: () =>
      Buffer.from(
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+safe\n"
      ),
  })
  try {
    assertVerificationFails(
      root,
      artifact,
      base,
      /candidate bundle tree does not match the transmitted patch/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects protected changes when patch and bundle agree", () => {
  const { root, artifact, base } = createArtifact({
    patchFor: (git, cwd, baseSha, candidate) =>
      execFileSync("git", ["diff", "--binary", baseSha, candidate], {
        cwd,
        encoding: "buffer",
      }),
  })
  try {
    assertVerificationFails(
      root,
      artifact,
      base,
      /protected or production-sensitive path: \.github\/evil\.yml/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
