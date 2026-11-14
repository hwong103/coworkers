import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  assertPersonalInvariants,
  git,
  gitSucceeds,
  inspectChangeSet,
} from "./lib.mjs"

const root = process.cwd()
const upstreamUrl =
  process.env.UPSTREAM_URL ?? "https://github.com/fayazara/coworkers.git"
const accountId = process.env.COWORKERS_ACCOUNT_ID
const accessTeamDomain = process.env.COWORKERS_ACCESS_TEAM_DOMAIN
const accessAud = process.env.COWORKERS_ACCESS_AUD

function output(entries) {
  const path = process.env.GITHUB_OUTPUT
  if (!path) return
  appendFileSync(
    path,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${String(value).replace(/\n/g, " ")}`)
      .join("\n") + "\n",
  )
}

function stop(status, reason) {
  output({ status, reason })
  console.error(`${status}: ${reason}`)
  process.exit(0)
}

for (const [name, value] of Object.entries({
  COWORKERS_ACCOUNT_ID: accountId,
  COWORKERS_ACCESS_TEAM_DOMAIN: accessTeamDomain,
  COWORKERS_ACCESS_AUD: accessAud,
})) {
  if (!value?.trim()) throw new Error(`${name} repository variable is required`)
}

const base = git(["rev-parse", "HEAD"], root)
git(["fetch", "--no-tags", upstreamUrl, "main:refs/remotes/upstream/main"], root, {
  stdio: ["ignore", "pipe", "inherit"],
})
const upstream = git(["rev-parse", "refs/remotes/upstream/main"], root)

if (gitSucceeds(["merge-base", "--is-ancestor", upstream, base], root)) {
  stop("no-update", `upstream ${upstream} is already integrated`)
}

const upstreamBase = git(["merge-base", base, upstream], root)
const upstreamChanges = inspectChangeSet(root, upstreamBase, upstream)
if (upstreamChanges.blockers.length) {
  stop("blocked-sensitive", upstreamChanges.blockers.join("; "))
}

try {
  git(["merge", "--no-ff", "--no-commit", "refs/remotes/upstream/main"], root, {
    stdio: ["ignore", "pipe", "inherit"],
  })
} catch {
  try {
    git(["merge", "--abort"], root)
  } catch {}
  stop("blocked-conflict", "upstream merge conflicts with personal changes")
}

const merged = inspectChangeSet(root, base, git(["write-tree"], root))
const invariantErrors = assertPersonalInvariants(root)
const blockers = [...merged.blockers, ...invariantErrors]
if (blockers.length) {
  git(["merge", "--abort"], root)
  stop("blocked-sensitive", blockers.join("; "))
}

writeFileSync(
  join(root, "coworkers.deploy.json"),
  `${JSON.stringify(
    {
      accountId,
      name: "coworkers",
      model: "dynamic/command-code",
      gateway: "coworkers",
      host: "coworkers.hwong103.work",
      accessTeamDomain,
      accessAud,
    },
    null,
    2,
  )}\n`,
)
git(
  ["commit", "-m", `Automated upstream update ${upstream.slice(0, 12)}`],
  root,
  { stdio: ["ignore", "pipe", "inherit"] },
)

output({
  status: "candidate-ready",
  base_sha: base,
  upstream_sha: upstream,
  candidate_sha: git(["rev-parse", "HEAD"], root),
})
