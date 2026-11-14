import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { hashTree, sha256File } from "./lib.mjs"

const root = process.cwd()
const artifact = resolve(root, ".upstream-artifact")
const base = process.env.BASE_SHA
const upstream = process.env.UPSTREAM_SHA
const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim()

if (!base || !upstream) throw new Error("BASE_SHA and UPSTREAM_SHA are required")
if (existsSync(artifact)) rmSync(artifact, { recursive: true, force: true })
mkdirSync(artifact, { recursive: true })

const patch = execFileSync("git", ["diff", "--binary", base, candidate], {
  cwd: root,
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024,
})
if (patch.length === 0) throw new Error("candidate patch is empty")
writeFileSync(join(artifact, "candidate.patch"), patch)
execFileSync(
  "git",
  ["update-ref", "refs/heads/upstream-candidate", candidate],
  { cwd: root },
)
try {
  execFileSync(
    "git",
    [
      "bundle",
      "create",
      join(artifact, "candidate.bundle"),
      `${base}..refs/heads/upstream-candidate`,
    ],
    { cwd: root, stdio: "inherit" },
  )
} finally {
  execFileSync(
    "git",
    ["update-ref", "-d", "refs/heads/upstream-candidate"],
    { cwd: root },
  )
}
cpSync(join(root, ".cloudflare/output"), join(artifact, "output"), {
  recursive: true,
  dereference: false,
})

const metadata = {
  schemaVersion: 1,
  base_sha: base,
  upstream_sha: upstream,
  candidate_sha: candidate,
  patch_sha256: sha256File(join(artifact, "candidate.patch")),
  bundle_sha256: sha256File(join(artifact, "candidate.bundle")),
  output_sha256: hashTree(join(artifact, "output")),
  expected: {
    account_id: process.env.COWORKERS_ACCOUNT_ID,
    worker_name: "coworkers",
    access_team_domain: process.env.COWORKERS_ACCESS_TEAM_DOMAIN,
    access_aud: process.env.COWORKERS_ACCESS_AUD,
  },
}
writeFileSync(join(artifact, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`)
console.log(JSON.stringify(metadata))
