import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const upstream = "a".repeat(40)

function run(status, event, comments = []) {
  const root = mkdtempSync(join(tmpdir(), "coworkers-failure-state-"))
  try {
    const fixture = join(root, "comments.json")
    const output = join(root, "output.txt")
    writeFileSync(fixture, JSON.stringify(comments))
    writeFileSync(output, "")
    execFileSync(process.execPath, [join(here, "check-failure.mjs")], {
      env: {
        ...process.env,
        PREPARE_STATUS: status,
        PREPARE_REASON: "",
        UPSTREAM_SHA: upstream,
        GITHUB_EVENT_NAME: event,
        COWORKERS_UPDATE_ISSUE_NUMBER: "42",
        FAILURE_COMMENTS_FILE: fixture,
        GITHUB_OUTPUT: output,
      },
      stdio: "pipe",
    })
    return readFileSync(output, "utf8")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const marker = `<!-- coworkers-upstream-failure:${upstream} -->`

test("scheduled runs suppress a previously failed upstream SHA", () => {
  assert.match(
    run("candidate-ready", "schedule", [{ body: `failed ${marker}` }]),
    /status=failed-candidate-suppressed/
  )
})

test("manual runs bypass failed-candidate suppression", () => {
  assert.match(
    run("candidate-ready", "workflow_dispatch", [{ body: marker }]),
    /status=candidate-ready/
  )
})

test("scheduled runs proceed for a different upstream SHA", () => {
  assert.match(
    run("candidate-ready", "schedule", [
      { body: `<!-- coworkers-upstream-failure:${"b".repeat(40)} -->` },
    ]),
    /status=candidate-ready/
  )
})

test("non-candidate prepare outcomes pass through unchanged", () => {
  assert.match(run("no-update", "schedule"), /status=no-update/)
})

test("scheduled runs suppress a previously failed blocked merge", () => {
  assert.match(
    run("blocked-conflict", "schedule", [{ body: marker }]),
    /status=failed-candidate-suppressed/
  )
})
