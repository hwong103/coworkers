import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { inspectChangeSet } from "./lib.mjs"

const root = process.cwd()
const artifact = resolve(
  process.env.ARTIFACT_DIR ?? join(root, ".upstream-artifact")
)
const metadata = JSON.parse(
  readFileSync(join(artifact, "metadata.json"), "utf8")
)
const trustedHead = process.env.TRUSTED_HEAD_SHA
const current = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim()

if (!trustedHead || trustedHead !== current) {
  throw new Error(`checkout ${current} is not trusted head ${trustedHead}`)
}
if (metadata.base_sha !== trustedHead) {
  throw new Error(
    `metadata base ${metadata.base_sha} is not trusted head ${trustedHead}`
  )
}

execFileSync(
  "git",
  [
    "fetch",
    join(artifact, "candidate.bundle"),
    "refs/heads/upstream-candidate:refs/remotes/upstream-candidate",
  ],
  { cwd: root, stdio: "inherit" }
)
const candidate = execFileSync(
  "git",
  ["rev-parse", "refs/remotes/upstream-candidate"],
  { cwd: root, encoding: "utf8" }
).trim()
if (candidate !== metadata.candidate_sha) {
  throw new Error(
    `bundle head ${candidate} is not metadata candidate ${metadata.candidate_sha}`
  )
}

const parents = execFileSync(
  "git",
  ["rev-list", "--parents", "-n", "1", candidate],
  { cwd: root, encoding: "utf8" }
)
  .trim()
  .split(/\s+/)
  .slice(1)
if (
  parents.length !== 2 ||
  parents[0] !== metadata.base_sha ||
  parents[1] !== metadata.upstream_sha
) {
  throw new Error(`candidate ancestry mismatch: ${parents.join(", ")}`)
}

const actualDiff = execFileSync(
  "git",
  ["diff", "--binary", metadata.base_sha, candidate],
  {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  }
)
const transmitted = readFileSync(join(artifact, "candidate.patch"))
const actualHash = createHash("sha256").update(actualDiff).digest("hex")
const transmittedHash = createHash("sha256").update(transmitted).digest("hex")
if (actualHash !== transmittedHash || actualHash !== metadata.patch_sha256) {
  throw new Error("candidate bundle tree does not match the transmitted patch")
}

const changes = inspectChangeSet(root, metadata.base_sha, candidate)
if (changes.blockers.length) {
  throw new Error(`candidate bundle rejected: ${changes.blockers.join("; ")}`)
}

console.log(
  JSON.stringify({
    ok: true,
    base_sha: metadata.base_sha,
    upstream_sha: metadata.upstream_sha,
    candidate_sha: candidate,
    patch_sha256: actualHash,
  })
)
