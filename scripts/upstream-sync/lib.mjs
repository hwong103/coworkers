import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

export const PROTECTED_PREFIXES = [
  ".github/",
  "scripts/upstream-sync/",
  "docs/upstream-auto-deploy.md",
]

export const PROTECTED_EXACT = new Set([
  ".dev.vars.example",
  "pnpm-workspace.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "installer/package.json",
  "installer/cloudflare.config.ts",
  "vite.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "eslint.config.js",
  "drizzle.config.ts",
  ".npmrc",
])

export const PROTECTED_PREFIXES_DEPENDENCY = [
  "drizzle/",
  "migrations/",
  "schema/",
]

export const SECURITY_PATHS = new Set([
  "src/server.ts",
  "src/lib/auth.ts",
  "src/lib/push.ts",
  "src/agents/guards.ts",
  "src/agents/secrets.ts",
  "src/agents/email-routing.ts",
  "src/mcp/oauth.ts",
  "src/mcp/oauth-store.ts",
  "src/mcp/scopes.ts",
  "src/control/access.ts",
  "src/routes/api/hooks.$userId.$botId.$token.ts",
])

const STATE_RE = [
  /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/i,
  /ALTER\s+TABLE/i,
  /DROP\s+(?:TABLE|INDEX)/i,
  /PRAGMA\s+(?:user_version|journal_mode)/i,
  /\b(?:ctx\.)?storage\.(?:sql|exec|transaction|put|delete|list)\b/i,
  /\bblockConcurrencyWhile\b/i,
  /\binitialState\b/i,
  /\bvalidateStateChange\b/i,
]

export function git(args, cwd, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: process.env,
  }).trim()
}

export function gitSucceeds(args, cwd) {
  try {
    git(args, cwd)
    return true
  } catch {
    return false
  }
}

export function changedFiles(cwd, base, target) {
  const out = git(["diff", "--name-only", "-z", base, target], cwd)
  return out ? out.split("\0").filter(Boolean) : []
}

export function isProtectedPath(path) {
  return (
    PROTECTED_EXACT.has(path) ||
    PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    PROTECTED_PREFIXES_DEPENDENCY.some((prefix) => path.startsWith(prefix)) ||
    SECURITY_PATHS.has(path)
  )
}

export function sensitiveChangeReason(path, cwd, base, target) {
  if (isProtectedPath(path)) return `protected or production-sensitive path: ${path}`
  if (!path.startsWith("src/agents/") || !path.endsWith(".ts")) return null

  const diff = git(
    ["diff", "--unified=0", "--no-color", base, target, "--", path],
    cwd,
  )
  const changedLines = diff
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
    )
  for (const line of changedLines) {
    if (STATE_RE.some((re) => re.test(line))) {
      return `possible schema/storage initialization change in ${path}: ${line.slice(1).trim()}`
    }
  }
  return null
}

export function inspectChangeSet(cwd, base, target) {
  const files = changedFiles(cwd, base, target)
  const blockers = files
    .map((path) => sensitiveChangeReason(path, cwd, base, target))
    .filter(Boolean)
  return { files, blockers }
}

export function assertPersonalInvariants(root) {
  const errors = []
  const hub = readFileSync(join(root, "src/agents/user-hub.ts"), "utf8")
  const config = readFileSync(join(root, "cloudflare.config.ts"), "utf8")
  const models = readFileSync(join(root, "src/lib/models.ts"), "utf8")
  const rootRoute = readFileSync(join(root, "src/routes/__root.tsx"), "utf8")

  if (/DROP\s+TABLE\s+IF\s+EXISTS\s+google_client/i.test(hub)) {
    errors.push("UserHub still drops the preserved google_client table")
  }
  if (
    !/EMAIL_ROUTING_API_TOKEN:\s*EMAIL_ROUTING_MANAGED[\s\S]{0,120}bindings\.secret\(\)/.test(
      config,
    )
  ) {
    errors.push("email routing token conditional is missing")
  }
  if (/["']experimental["']/.test(config)) {
    errors.push("experimental compatibility flag is forbidden")
  }
  if (!/dynamic\/command-code/.test(models)) {
    errors.push("personal Command Code model registration is missing")
  }
  if (!/manifest\.webmanifest/.test(rootRoute)) {
    errors.push("web manifest link is missing")
  }
  try {
    readFileSync(join(root, "public/manifest.webmanifest"))
  } catch {
    errors.push("public/manifest.webmanifest is missing")
  }
  return errors
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function hashTree(root) {
  const hash = createHash("sha256")
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${path}`)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        hash.update(relative(root, path).split("\\").join("/"))
        hash.update("\0")
        hash.update(readFileSync(path))
        hash.update("\0")
      } else {
        throw new Error(`unsupported file type: ${path}`)
      }
    }
  }
  visit(resolve(root))
  return hash.digest("hex")
}

export function parseWorkerDeployments(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  const deployments = Array.isArray(parsed) ? parsed : parsed.deployments
  if (!Array.isArray(deployments)) {
    throw new Error("cf deployments JSON has no deployments array")
  }
  return deployments
}

export function latestDeploymentId(deployments) {
  const latest = deployments[0]
  if (!latest) throw new Error("cf returned no Worker deployments")
  const versions = latest.versions ?? []
  if (versions.length !== 1 || Number(versions[0].percentage) !== 100) {
    throw new Error("latest deployment is not a single 100% version; automatic deploy stopped")
  }
  const id = versions[0].version_id ?? versions[0].versionId
  if (!id) throw new Error("latest deployment has no version ID")
  return id
}

export function deploymentPreflight(expectedVersionId, currentVersionId) {
  if (expectedVersionId !== currentVersionId) {
    return {
      ok: false,
      reason: `live deployment changed outside this automation: expected ${expectedVersionId}, found ${currentVersionId}`,
    }
  }
  return { ok: true }
}

export async function deployWithOneRecoveryAttempt({
  expectedVersionId,
  deploy,
  readLiveVersion,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let firstError
  try {
    await deploy()
  } catch (error) {
    firstError = error
  }

  const afterFirst = await readLiveVersion()
  if (!firstError) {
    if (afterFirst !== expectedVersionId) return { attempts: 1 }
    throw new Error("deploy command succeeded but live deployment did not change")
  }
  if (afterFirst !== expectedVersionId) {
    throw new Error(
      `deploy failed and live version may have changed; no retry: ${firstError?.message ?? "unknown error"}`,
    )
  }

  await sleep(30_000)
  try {
    await deploy()
  } catch (error) {
    const afterSecond = await readLiveVersion()
    throw new Error(
      `deploy failed after retry; live ${afterSecond === expectedVersionId ? "is unchanged" : "may have changed"}: ${error.message}`,
    )
  }
  return { attempts: 2, firstError: firstError?.message }
}
