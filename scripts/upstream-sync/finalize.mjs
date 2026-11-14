import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = process.cwd()
const artifact = resolve(process.env.ARTIFACT_DIR ?? join(root, ".upstream-artifact"))
const metadata = JSON.parse(readFileSync(join(artifact, "metadata.json"), "utf8"))
const result = JSON.parse(readFileSync(join(artifact, "deployment-result.json"), "utf8"))
const statePath = join(root, ".github/upstream-sync/deployment-state.json")

const current = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim()
if (current !== metadata.base_sha) {
  throw new Error(`main moved during release: expected ${metadata.base_sha}, found ${current}`)
}
const parents = execFileSync(
  "git",
  ["rev-list", "--parents", "-n", "1", metadata.candidate_sha],
  { cwd: root, encoding: "utf8" },
).trim().split(/\s+/).slice(1)
if (parents.length !== 2) throw new Error("candidate is not a two-parent merge commit")
if (parents[0] !== metadata.base_sha || parents[1] !== metadata.upstream_sha) {
  throw new Error(`candidate ancestry mismatch: ${parents.join(", ")}`)
}

execFileSync("git", ["switch", "--detach", metadata.candidate_sha], {
  cwd: root,
  stdio: "inherit",
})
writeFileSync(statePath, `${JSON.stringify(result.state, null, 2)}\n`)

execFileSync("git", ["add", "-A"], { cwd: root, stdio: "inherit" })
execFileSync(
  "git",
  ["commit", "-m", `Deploy upstream update ${metadata.upstream_sha.slice(0, 12)}`],
  { cwd: root, stdio: "inherit" },
)

console.log(
  JSON.stringify({
    candidate_sha: metadata.candidate_sha,
    upstream_sha: metadata.upstream_sha,
    deployed_version_id: result.state.expectedVersionId,
    attempts: result.attempts,
    warnings: result.warnings,
  }),
)
