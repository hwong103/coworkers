import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { isProtectedPath } from "./lib.mjs"

const root = process.cwd()
const artifact = resolve(process.env.ARTIFACT_DIR ?? join(root, ".upstream-artifact"))
const metadata = JSON.parse(readFileSync(join(artifact, "metadata.json"), "utf8"))
const result = JSON.parse(readFileSync(join(artifact, "deployment-result.json"), "utf8"))
const patch = join(artifact, "candidate.patch")
const statePath = join(root, ".github/upstream-sync/deployment-state.json")

const numeric = execFileSync("git", ["apply", "--numstat", patch], {
  cwd: root,
  encoding: "utf8",
})
const paths = numeric
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t").at(-1))
for (const path of paths) {
  if (isProtectedPath(path)) {
    throw new Error(`refusing to apply candidate change to protected path: ${path}`)
  }
}

execFileSync("git", ["apply", "--check", patch], { cwd: root, stdio: "inherit" })
execFileSync("git", ["apply", patch], { cwd: root, stdio: "inherit" })
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
