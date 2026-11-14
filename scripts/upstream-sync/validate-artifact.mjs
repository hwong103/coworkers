import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { hashTree, isProtectedPath, sha256File } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const artifact = resolve(process.env.ARTIFACT_DIR ?? join(here, "../../.upstream-artifact"))
const expectedAccount = process.env.COWORKERS_ACCOUNT_ID
const expectedAccessTeam = process.env.COWORKERS_ACCESS_TEAM_DOMAIN
const expectedAccessAud = process.env.COWORKERS_ACCESS_AUD
const policy = JSON.parse(readFileSync(join(here, "artifact-policy.json"), "utf8"))
const metadata = JSON.parse(readFileSync(join(artifact, "metadata.json"), "utf8"))

function fail(message) {
  throw new Error(`artifact rejected: ${message}`)
}

function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} changed\nactual: ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`)
  }
}

function expand(value) {
  if (typeof value === "string") {
    return value
      .replace("$ACCOUNT_ID", expectedAccount ?? "")
      .replace("$ACCESS_TEAM_DOMAIN", expectedAccessTeam ?? "")
      .replace("$ACCESS_AUD", expectedAccessAud ?? "")
  }
  if (Array.isArray(value)) return value.map(expand)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item)]),
    )
  }
  return value
}

for (const [name, value] of Object.entries({
  COWORKERS_ACCOUNT_ID: expectedAccount,
  COWORKERS_ACCESS_TEAM_DOMAIN: expectedAccessTeam,
  COWORKERS_ACCESS_AUD: expectedAccessAud,
})) {
  if (!value?.trim()) fail(`${name} is required for validation`)
}
if (!/^[0-9a-f]{32}$/.test(expectedAccount)) {
  fail("account ID must be 32 lowercase hex characters")
}
if (metadata.schemaVersion !== 1) fail("unknown metadata schema")
for (const key of ["base_sha", "upstream_sha", "candidate_sha", "patch_sha256"]) {
  if (!metadata[key]) fail(`metadata.${key} is missing`)
}
equal(
  metadata.expected,
  {
    account_id: expectedAccount,
    worker_name: policy.workerName,
    access_team_domain: expectedAccessTeam,
    access_aud: expectedAccessAud,
  },
  "build identity",
)

const output = join(artifact, "output")
equal(hashTree(output), metadata.output_sha256, "build output digest")
equal(
  sha256File(join(artifact, "candidate.patch")),
  metadata.patch_sha256,
  "candidate patch digest",
)
const patchPaths = execFileSync(
  "git",
  ["apply", "--numstat", join(artifact, "candidate.patch")],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t").at(-1))
for (const path of patchPaths) {
  if (isProtectedPath(path)) fail(`candidate patch changes protected path ${path}`)
}

const config = JSON.parse(readFileSync(join(output, "v0/config.json"), "utf8"))
const worker = JSON.parse(
  readFileSync(join(output, "v0/workers/default/worker.config.json"), "utf8"),
)
for (const [label, value] of [
  ["config", config],
  ["worker", worker],
]) {
  const account = value.rootConfig?.accountId ?? value.accountId
  if (account !== undefined && account !== expectedAccount) {
    fail(`${label} root accountId ${account} does not equal ${expectedAccount}`)
  }
}
if (
  config.buildContext?.isPreview !== false ||
  config.buildContext?.mode !== "production"
) {
  fail("build is not a production build")
}

equal(worker.name, policy.workerName, "Worker name")
equal(worker.compatibilityDate, policy.compatibilityDate, "compatibility date")
equal(worker.compatibilityFlags, policy.compatibilityFlags, "compatibility flags")
equal(worker.previewUrls, policy.previewUrls, "preview policy")
equal(worker.observability, policy.observability, "observability")
equal(worker.exports, policy.exports, "Durable Object exports")
equal(worker.routes ?? null, null, "Worker routes")
equal(worker.triggers ?? null, null, "Worker triggers")
equal(worker.env, expand(policy.bindings), "bindings")

const secrets = Object.entries(worker.env)
  .filter(([, value]) => value?.type === "secret")
  .map(([name]) => name)
  .sort()
equal(secrets, [...policy.secretBindings].sort(), "secret binding names")

const main = worker.manifest?.mainModule
if (!main || main.startsWith("/") || main.includes("..")) {
  fail("unsafe main module path")
}

console.log(
  JSON.stringify({
    ok: true,
    worker: worker.name,
    account_id: expectedAccount,
    candidate_sha: metadata.candidate_sha,
    upstream_sha: metadata.upstream_sha,
    output_sha256: metadata.output_sha256,
  }),
)
