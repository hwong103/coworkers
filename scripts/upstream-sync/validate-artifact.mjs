import { execFileSync } from "node:child_process"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
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
for (const key of [
  "base_sha",
  "upstream_sha",
  "candidate_sha",
  "patch_sha256",
  "bundle_sha256",
]) {
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
equal(
  sha256File(join(artifact, "candidate.bundle")),
  metadata.bundle_sha256,
  "candidate bundle digest",
)
const bundleHead = execFileSync(
  "git",
  ["bundle", "list-heads", join(artifact, "candidate.bundle")],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)
  .trim()
  .split("\n")[0]
  ?.split(/\s+/)[0]
equal(bundleHead, metadata.candidate_sha, "candidate bundle head")
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
equal(Object.keys(config).sort(), ["buildContext"], "root config keys")
equal(
  Object.keys(config.buildContext ?? {}).sort(),
  ["isPreview", "mode"],
  "build context keys",
)
equal(
  Object.keys(worker).sort(),
  [
    "compatibilityDate",
    "compatibilityFlags",
    "env",
    "exports",
    "manifest",
    "name",
    "observability",
    "previewUrls",
  ],
  "worker config keys",
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
if (main !== "index.js") fail("unsafe main module path")

const outputRoot = resolve(output)
const allowedFile = (path) =>
  path === "v0/config.json" ||
  path === "v0/workers/default/worker.config.json" ||
  path.startsWith("v0/workers/default/assets/") ||
  path.startsWith("v0/workers/default/bundle/")
const visit = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail(`symlink in output: ${path}`)
    if (stat.isDirectory()) visit(path)
    else {
      const rel = relative(outputRoot, path).split("\\").join("/")
      if (!allowedFile(rel)) fail(`unexpected output file: ${rel}`)
      const absolute = resolve(outputRoot, rel)
      if (!absolute.startsWith(`${outputRoot}/`)) fail(`path escaped output: ${rel}`)
    }
  }
}
visit(outputRoot)
for (const modulePath of Object.keys(worker.manifest?.modules ?? {})) {
  const absolute = resolve(outputRoot, "v0/workers/default/bundle", modulePath)
  if (!absolute.startsWith(`${outputRoot}/v0/workers/default/bundle/`)) {
    fail(`manifest module escaped bundle: ${modulePath}`)
  }
  try {
    readFileSync(absolute)
  } catch {
    fail(`manifest module is missing: ${modulePath}`)
  }
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
