import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  deployWithOneRecoveryAttempt,
  latestDeploymentId,
  parseWorkerDeployments,
} from "./lib.mjs"

const root = process.cwd()
const artifact = resolve(process.env.ARTIFACT_DIR ?? join(root, ".upstream-artifact"))
const stage = resolve(process.env.DEPLOY_STAGE ?? "/tmp/coworkers-deploy-stage")
const cf = process.env.CF_BIN ?? "cf"
const account = process.env.COWORKERS_ACCOUNT_ID
const worker = "coworkers"
const statePath = resolve(
  process.env.COWORKERS_STATE_FILE ??
    join(root, ".github/upstream-sync/deployment-state.json"),
)
const metadata = JSON.parse(readFileSync(join(artifact, "metadata.json"), "utf8"))
const state = JSON.parse(readFileSync(statePath, "utf8"))

if (!account) throw new Error("COWORKERS_ACCOUNT_ID is required")
if (state.worker !== worker) {
  throw new Error(`state worker ${state.worker} is not ${worker}`)
}

function cfJson(args) {
  const output = execFileSync(cf, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account },
    stdio: ["ignore", "pipe", "inherit"],
  })
  return parseWorkerDeployments(output)
}

const readLiveVersion = () =>
  latestDeploymentId(
    cfJson([
      "workers",
      "deployments",
      "list",
      "--worker",
      worker,
      "--per-page",
      "1",
    ]),
  )

const current = await readLiveVersion()
if (current !== state.expectedVersionId) {
  throw new Error(
    `live deployment changed outside this automation: expected ${state.expectedVersionId}, found ${current}`,
  )
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, ".cloudflare"), { recursive: true })
cpSync(join(artifact, "output"), join(stage, ".cloudflare/output"), {
  recursive: true,
  dereference: false,
})

const deploy = () =>
  execFileSync(
    cf,
    [
      "deploy",
      "--prebuilt",
      "--tag",
      `upstream-${metadata.upstream_sha.slice(0, 12)}`,
      "--message",
      `Automated upstream update ${metadata.upstream_sha}`,
    ],
    {
      cwd: stage,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account },
      stdio: ["ignore", "inherit", "inherit"],
    },
  )

const result = await deployWithOneRecoveryAttempt({
  expectedVersionId: state.expectedVersionId,
  deploy,
  readLiveVersion,
})
const deployedVersionId = await readLiveVersion()
if (deployedVersionId === state.expectedVersionId) {
  throw new Error("deploy command succeeded but live deployment did not change")
}

const warnings = []
for (const path of ["/manifest.webmanifest", "/sw.js"]) {
  try {
    const response = await fetch(`https://coworkers.hwong103.work${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status !== 200) {
      warnings.push(
        `${path} returned ${response.status}; this asset check does not prove runtime`,
      )
    }
  } catch (error) {
    warnings.push(`${path} smoke check failed: ${error.message}`)
  }
}

const nextState = {
  schemaVersion: 1,
  worker,
  expectedVersionId: deployedVersionId,
  deployedUpstreamSha: metadata.upstream_sha,
  deployedCandidateSha: metadata.candidate_sha,
  deployedAt: new Date().toISOString(),
}
const resultBody = { ...result, state: nextState, warnings }
writeFileSync(
  join(artifact, "deployment-result.json"),
  `${JSON.stringify(resultBody, null, 2)}\n`,
)
console.log(JSON.stringify(resultBody))
